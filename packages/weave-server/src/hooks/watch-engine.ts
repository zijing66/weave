import { HARNESS_LIFECYCLE, type Harness } from '@weavecode/core';
import type { MessagingSurface } from '@weavecode/harness';
import type {
  SessionWatchRepository,
  SessionWatchRow,
  WatchOn,
} from '../repositories/session-watches.js';
import type { SessionRepository } from '../repositories/sessions.js';
import { messagingSurfaceFor } from '../surfaces.js';
import { claudeLivenessById, pidAliveOf } from '../daemon/claude-liveness.js';
import type { HookBusMessage, HookEventBus } from './bus.js';
import type { MessageDeliverer } from './message-deliverer.js';

/** 同一次转场的邻接事件合并窗口（ms）：Stop 与其后的 SessionEnd 只算一次命中。 */
const HIT_DEDUPE_MS = 1_000;

/**
 * 会话订阅引擎（session-orchestration 批 2 + 提醒类型）：`session_watches` 的
 * one-shot 触发器，三条 fire 路径（订阅的 `onEvents` 决定听哪几条）——
 *
 * ① onEvent：ingest 消费路径见到**目标会话**的事件 → `idle` 听 idleSignals
 *    全集（经 MessagingSurface 取），`turnEnd` 只听一轮对话结束
 *    （HARNESS_LIFECYCLE[<harness>].close，claude = Stop）——两者都不散写
 *    Stop/SessionEnd 字面量；
 * ② onBus：`message.finished` 且终态 failed/timeout → `messageFailed`；
 * ③ sweepTerminated：既有 SessionSweeper tick 挂钩——daemon 重启或目标异常
 *    终止（未打 idle 信号，claude 注册表判死）后的补射（第七章 7.3-1）；只补
 *    空闲类订阅（投递类等的是投递事件，进程死不给它编触发）。
 *
 * fire 语义（D3）：watcher 是会话 → 通知文本经 MessageDeliverer 的 inject
 * 通道注入（非抢占，随它下一拍 hook 事件收到；线程留痕 + message.* 帧）；
 * watcher 是 dashboard → watch.fired 帧由 web toast + 浏览器通知。markFired
 * 先行（CAS），投递结果不再回滚——one-shot 落定即失效。
 *
 * 一切异常在内部吞掉：watch 失败永不影响采集（hooks 非阻塞不变式）。
 */
export class WatchEngine {
  /** 订阅 id → 上次命中的时刻：同一次转场可能带来多个事件（Stop + SessionEnd），
   *  窗口内的重复命中不重复计数/提醒（计数订阅的一次 = 一次转场）。 */
  private readonly lastHitAt = new Map<number, number>();

  constructor(
    private readonly deps: {
      watches: Pick<
        SessionWatchRepository,
        'listPendingByTarget' | 'listPending' | 'consumeHit'
      >;
      deliverer: Pick<MessageDeliverer, 'send'>;
      sessions: Pick<SessionRepository, 'getBySessionId' | 'listWithCounts' | 'turnOpenOf'>;
      bus: HookEventBus;
      /** 能力面访问器（测试注入）；缺省 surfaces.ts 模块级 registry。 */
      surfaceFor?: (harness: Harness) => MessagingSurface;
      /** liveness 探测（测试注入）；缺省 claude 注册表全量扫描。 */
      livenessOf?: () => Map<string, boolean>;
    },
  ) {
    deps.bus.subscribe((message) => this.onBus(message));
  }

  /**
   * ingest 消费路径的事件钩子（fire-and-forget；内部全吞）。source 即目标
   * 会话的 harness（事件来自它）——空闲/回合结束判定按 harness 表取。
   */
  onEvent(input: { sessionId: string; eventType: string; source: Harness }): void {
    try {
      const surface = this.deps.surfaceFor?.(input.source) ?? messagingSurfaceFor(input.source);
      const isIdle = surface.idleSignals.includes(input.eventType);
      // 字面量元组（claude ['Stop'] / codex []）先宽化再 includes，否则 never 参数
      const closeEvents: readonly string[] = HARNESS_LIFECYCLE[input.source].close;
      const isTurnEnd = closeEvents.includes(input.eventType);
      if (!isIdle && !isTurnEnd) return;
      for (const row of this.deps.watches.listPendingByTarget(input.sessionId)) {
        if (isTurnEnd && row.onEvents.includes('turnEnd')) this.fire(row, 'turnEnd');
        else if (isIdle && row.onEvents.includes('idle')) this.fire(row, 'idle');
      }
    } catch {
      // 面缺席/库错误都不影响采集
    }
  }

  /** 管道终态帧：目标会话的消息投递失败/超时 → `messageFailed` 订阅。 */
  private onBus(message: HookBusMessage): void {
    if (message.kind !== 'message.finished') return;
    if (message.status !== 'failed' && message.status !== 'timeout') return;
    try {
      for (const row of this.deps.watches.listPendingByTarget(message.sessionId)) {
        if (row.onEvents.includes('messageFailed')) this.fire(row, 'messageFailed');
      }
    } catch {
      // 库错误不影响采集
    }
  }

  /**
   * 订阅落库后的即时段（路由插入后调用）：目标**此刻已空闲**（turnOpen
   * false——服务端基线）→ 立即 fire，不等下一拍。「空闲时提醒我」点在空闲
   * 会话上，答案就是现在；turnOpen 未知（null）不猜。投递类订阅没有「此刻
   * 已成真」态，不参与即时段。
   */
  created(row: SessionWatchRow): void {
    try {
      if (!row.onEvents.includes('idle') && !row.onEvents.includes('turnEnd')) return;
      if (this.deps.sessions.turnOpenOf(row.targetSessionId) === false) {
        this.fire(row, row.onEvents.includes('idle') ? 'idle' : 'turnEnd');
      }
    } catch {
      // 即时段失败不影响订阅本身（pending 留给 ingest/补射路径）
    }
  }

  /**
   * terminated 补射：全部 pending 订阅里，目标已判死（claude 注册表 pidAlive
   * false；目标行已消失 = 等待永不可解）的补 fire。判不动（null）不猜——
   * 会话可能只是安静。返回补射数（可反复调用，已 fire 的自然不在 pending）。
   */
  sweepTerminated(): number {
    try {
      const liveness = this.deps.livenessOf?.() ?? claudeLivenessById();
      const rows = new Map(
        this.deps.sessions.listWithCounts().map((r) => [r.sessionId, r] as const),
      );
      let fired = 0;
      for (const watch of this.deps.watches.listPending()) {
        if (!watch.onEvents.includes('idle') && !watch.onEvents.includes('turnEnd')) continue;
        const row = rows.get(watch.targetSessionId);
        if (row && pidAliveOf(row, liveness) !== false) continue;
        if (this.fire(watch, 'idle')) fired++;
      }
      return fired;
    } catch {
      return 0;
    }
  }

  /**
   * fire 一条订阅（one-shot）：CAS 落定 → 按订阅方分流。返回 false = 并发
   * 路径（同批 Stop+SessionEnd / 补射与 ingest 竞速）已 fire，本次零副作用。
   * 同步方法——markFired/bus.emit 均同步；注入投递 fire-and-forget。
   */
  private fire(row: SessionWatchRow, reason: WatchOn): boolean {
    const now = Date.now();
    const last = this.lastHitAt.get(row.id);
    if (last !== undefined && now - last < HIT_DEDUPE_MS) return false; // 同一次转场的邻接事件
    const consumed = this.deps.watches.consumeHit(row.id);
    if (!consumed) return false;
    this.lastHitAt.set(row.id, now);
    if (consumed.firedAt !== null) this.lastHitAt.delete(row.id); // 已失效：不再留痕
    const at = new Date(now).toISOString();
    this.deps.bus.emit({
      kind: 'watch.fired',
      watchId: row.id,
      targetSessionId: row.targetSessionId,
      watcherSessionId: row.watcherSessionId,
      reason,
      at,
    });
    if (row.watcherSessionId == null) return true;
    // one-shot 已落定：投递拒绝（watcher 会话已删/项目没了）不回滚、不重试
    void this.deps.deliverer
      .send({
        toSessionId: row.watcherSessionId,
        text: row.notify ?? this.defaultNotify(row.targetSessionId, reason),
        fromKind: 'session',
        fromSessionId: row.targetSessionId,
        mode: 'inject',
      })
      .catch(() => {
        // send 约定不 throw；防御位
      });
    return true;
  }

  /**
   * 缺省通知文本（server 单点）：载荷自包含纪律（第七章 7.3-4）——触发类
   * 消息必须自带「为何此刻收到」，接收会话的上下文可能已被压缩。
   */
  private defaultNotify(targetSessionId: string, reason: WatchOn): string {
    const target = this.deps.sessions.getBySessionId(targetSessionId);
    const label = target?.title ?? targetSessionId.slice(0, 8);
    const what =
      reason === 'messageFailed'
        ? 'had a failed message delivery'
        : reason === 'turnEnd'
          ? 'finished its turn'
          : 'is now idle';
    return `Session ${label} ${what} (trigger=watch:${targetSessionId})`;
  }
}
