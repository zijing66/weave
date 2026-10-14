import type { Harness } from '@weavecode/core';
import type { MessagingSurface } from '@weavecode/harness';
import type { SessionSequenceRepository, SessionSequenceRow } from '../repositories/session-sequences.js';
import type { SessionRepository } from '../repositories/sessions.js';
import { messagingSurfaceFor } from '../surfaces.js';
import { claudeLivenessById, pidAliveOf } from '../daemon/claude-liveness.js';
import type { HookBusMessage, HookEventBus } from './bus.js';
import type { MessageDeliverer, PipeMessage } from './message-deliverer.js';

/** D5 跳数上限：一次序列至多 3 步（A→B→C），POST 侧静态校验。 */
export const SEQUENCE_HOP_LIMIT = 3;

/**
 * 跨会话序列引擎（session-orchestration 批 3 ②）：手工编排的多步链
 * `A → B → C`——步 0 由路由触发，此后每步完成即发下一步。
 *
 * 无状态设计：权威状态全在 `session_sequences` 行（cursor/steps[].messageId），
 * 引擎只是 bus/ingest 的监听器 + DB 的推进器，daemon 重启经 rearm() 从行恢复，
 * 零恢复态机。步完成判据双通道（D6）：
 *
 *   headless 步 → `message.finished`（messageId 匹配；failed/timeout = 序列失败）
 *   inject 步   → 目标会话的 idleSignals 事件（经 MessagingSurface 取，与
 *                 WatchEngine 同口径同竞态——骑乘 Stop 的提前一拍是已知残差）
 *
 * 推进用 cursor CAS（同批 Stop+SessionEnd 双事件只赢一次）；终态用 status CAS。
 * 一切异常内部吞掉：序列推进失败永不影响采集与消息投递。
 */
export class SequenceEngine {
  constructor(
    private readonly deps: {
      sequences: Pick<
        SessionSequenceRepository,
        'getById' | 'listRunning' | 'advanceCursor' | 'finish' | 'setStepMessage'
      >;
      /** 消息域重塑：步↔消息关联走管道发号 + 内存注册表（无 DB 行可反查）。 */
      deliverer: Pick<MessageDeliverer, 'send' | 'getMessage'>;
      sessions: Pick<SessionRepository, 'listWithCounts'>;
      bus: HookEventBus;
      /** 能力面访问器（测试注入）；缺省 surfaces.ts 模块级 registry。 */
      surfaceFor?: (harness: Harness) => MessagingSurface;
      /** liveness 探测（测试注入）；缺省 claude 注册表全量扫描。 */
      livenessOf?: () => Map<string, boolean>;
    },
  ) {
    this.deps.bus.subscribe((message) => this.onBus(message));
  }

  /** 路由插入后触发步 0（await 到 send 落定——响应即可带回 messageId；拒绝即 failed 留痕）。 */
  async trigger(row: SessionSequenceRow): Promise<void> {
    await this.fire(row.id, row.cursor);
  }

  /** 取消（路由 DELETE）：仅 running 可取消，终态拒绝由路由先行判。 */
  cancel(id: number): boolean {
    return this.finish(id, 'cancelled');
  }

  /**
   * daemon 重启恢复：running 序列按行重挂——injected/delivered 步续等 idle
   * （不重发）；messageId 缺席或注册表已随进程死 → **判 interrupted，不重发**
   * （批 3 的补 fire 语义作废：宁可人续，不往会话重复打 prompt）；headless 步
   * 的 settle 回调已死 → 按失败收尾；已落终态但帧未达（宕机窗口）→ 按行终态
   * 补推进。boot 不阻塞。
   */
  rearm(): void {
    try {
      for (const row of this.deps.sequences.listRunning()) {
        const step = row.steps[row.cursor];
        if (!step) {
          this.finish(row.id, 'done');
          continue;
        }
        if (step.messageId == null) {
          // insert 后、send 发号前的窗口崩溃：无从判知 prompt 是否已打出去
          this.finish(row.id, 'failed', `step ${row.cursor + 1} interrupted — daemon restarted, not re-sent`);
          continue;
        }
        const msg = this.deps.deliverer.getMessage(step.messageId);
        if (msg?.status === 'injected' || msg?.status === 'delivered') continue; // idle-wait：监听恢复即续等
        if (msg?.status === 'running') {
          this.finish(row.id, 'failed', 'daemon restarted during headless step');
          continue;
        }
        if (msg?.status === 'succeeded') this.advance(row);
        else this.finish(row.id, 'failed', `step ${row.cursor + 1} ${msg?.status ?? 'message missing'}`);
      }
    } catch {
      // 恢复失败：序列留在 running，下一轮 rearm/事件可再推进
    }
  }

  /**
   * ingest 消费路径的事件钩子（与 WatchEngine.onEvent 同形态）：目标会话的
   * idleSignals 事件 → 本序列当前 inject 步完成。messageId 缺席（下一步
   * 尚未触发）不响应——idle 信号先于注入落库，属上一拍遗留。
   */
  onEvent(input: { sessionId: string; eventType: string; source: Harness }): void {
    try {
      const surface = this.deps.surfaceFor?.(input.source) ?? messagingSurfaceFor(input.source);
      if (!surface.idleSignals.includes(input.eventType)) return;
      for (const row of this.deps.sequences.listRunning()) {
        const step = row.steps[row.cursor];
        if (!step || step.to !== input.sessionId || step.messageId == null) continue;
        const msg = this.deps.deliverer.getMessage(step.messageId);
        if (msg?.status === 'injected' || msg?.status === 'delivered') this.advance(row);
      }
    } catch {
      // 面缺席/库错误都不影响采集
    }
  }

  /** headless 步完成：message.finished 帧按 messageId 匹配当前步。 */
  private onBus(message: HookBusMessage): void {
    if (message.kind !== 'message.finished') return;
    try {
      for (const row of this.deps.sequences.listRunning()) {
        const step = row.steps[row.cursor];
        if (step?.messageId !== message.messageId) continue;
        if (message.status === 'succeeded') this.advance(row);
        else this.finish(row.id, 'failed', `step ${row.cursor + 1} ${message.status}`);
      }
    } catch {
      // 吞
    }
  }

  /** 步完成 → 推进：末步落 done；否则 CAS 推游标后 fire 下一步。 */
  private advance(row: SessionSequenceRow): void {
    if (row.cursor + 1 >= row.steps.length) {
      this.finish(row.id, 'done');
      return;
    }
    if (this.deps.sequences.advanceCursor(row.id, row.cursor, row.cursor + 1)) {
      void this.fire(row.id, row.cursor + 1);
    }
  }

  /**
   * 触发一步：send 拒绝即序列失败；成功回填 messageId。headless 的同步失败
   * 路径（isBusy 竞态/spawn throw）会在 send 返回前就发 finished 帧——彼时
   * messageId 尚未落库、帧匹配不上，故 send 返回后按消息行终态补判。
   */
  private async fire(id: number, stepIndex: number): Promise<void> {
    try {
      const row = this.deps.sequences.getById(id);
      if (!row || row.status !== 'running' || row.cursor !== stepIndex) return;
      const step = row.steps[stepIndex];
      if (!step) return;
      this.deps.bus.emit({
        kind: 'sequence.step',
        sequenceId: id,
        cursor: stepIndex,
        at: new Date().toISOString(),
      });
      const result = await this.deps.deliverer.send({
        toSessionId: step.to,
        text: step.text,
        mode: step.mode,
        fromKind: 'dashboard',
      });
      if (!result.ok) {
        this.finish(id, 'failed', `step ${stepIndex + 1} rejected: ${result.error}`);
        return;
      }
      this.deps.sequences.setStepMessage(id, stepIndex, result.messageId);
      if (result.status === 'running') {
        const msg: PipeMessage | null = this.deps.deliverer.getMessage(result.messageId);
        if (msg?.status === 'succeeded' || msg?.status === 'failed' || msg?.status === 'timeout') {
          if (msg.status === 'succeeded') {
            const fresh = this.deps.sequences.getById(id);
            if (fresh) this.advance(fresh);
          } else {
            this.finish(id, 'failed', `step ${stepIndex + 1} ${msg.status}`);
          }
        }
      }
    } catch (err) {
      this.finish(id, 'failed', err instanceof Error ? err.message : String(err));
    }
  }

  /** 终态落定（status CAS）：并发终态只赢一次，赢家广播 sequence.finished。 */
  private finish(id: number, status: 'done' | 'failed' | 'cancelled', error: string | null = null): boolean {
    if (!this.deps.sequences.finish(id, status, error)) return false;
    this.deps.bus.emit({
      kind: 'sequence.finished',
      sequenceId: id,
      status,
      error,
      at: new Date().toISOString(),
    });
    return true;
  }

  /**
   * terminated 补射（挂 SessionSweeper 同 tick）：进行中序列的当前等待目标
   * 已判死（行消失/claude 注册表 pid 死）→ 序列失败。判不动（null）不猜。
   */
  sweepTerminated(): number {
    try {
      const liveness = this.deps.livenessOf?.() ?? claudeLivenessById();
      const rows = new Map(
        this.deps.sessions.listWithCounts().map((r) => [r.sessionId, r] as const),
      );
      let failed = 0;
      for (const row of this.deps.sequences.listRunning()) {
        const step = row.steps[row.cursor];
        if (!step) continue; // rearm 的补落路径已兜
        const target = rows.get(step.to);
        if (target && pidAliveOf(target, liveness) !== false) continue;
        if (this.finish(row.id, 'failed', `target session ${step.to} terminated`)) failed++;
      }
      return failed;
    } catch {
      return 0;
    }
  }
}
