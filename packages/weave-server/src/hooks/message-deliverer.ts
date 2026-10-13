import { isHarness, type Harness } from '@weavecode/core';
import type { MessagingSurface, MessageMeta } from '@weavecode/harness';
import type { HookEventRepository } from '../repositories/hook-events.js';
import type { ProjectRepository } from '../repositories/projects.js';
import type { SessionRepository } from '../repositories/sessions.js';
import type {
  MessageFromKind,
  MessageMode,
  MessageStatus,
  SessionMessageRepository,
  SessionMessageRow,
} from '../repositories/session-messages.js';
import { messagingSurfaceFor } from '../surfaces.js';
import type { HookEventBus } from './bus.js';
import { HeadlessRunner, type HeadlessSettleResult, type SpawnLike } from './headless-runner.js';
import { appendOutbox, hooksRoot } from './mirror.js';

/**
 * session-orchestration 批 1 消息投递器：把 dashboard / 会话间 / CLI 的点对点
 * 消息按裁决表落到通道上——
 *
 *   inject  → outbox 顺延注入（fire-and-forget，随目标会话下一拍 hook 事件送达，
 *             状态置 injected 即「已写 outbox」）
 *   headless → 无头强制回合（`claude --resume <sid> -p <信封>`，running → 终态）
 *   auto    → turnOpen 忙 → inject（绝不无头抢占）；闲 → headless
 *
 * 通道规格（rideEvents / headless 命令 / 不支持原因）全部来自 MessagingSurface
 * 能力面，本类不含 harness 硬编码。与 ResumeRunner 共享同一 HeadlessRunner
 * 实例 = 同会话并发闸跨 dispatch / message 两域生效。
 *
 * send() 校验失败同步返回错误码；成功立即返回（inject 已落 outbox，headless
 * 「已启动」），headless 终态经 onSettle 后台回写，绝不 throw 出 send()。
 */

export interface MessageDelivererDeps {
  messages: SessionMessageRepository;
  sessions: SessionRepository;
  projects: ProjectRepository;
  /** harness 归属判定用：目标会话最新事件的 source（与 open-terminal 同口径）。 */
  hookEvents: HookEventRepository;
  bus?: HookEventBus;
  /** 共享无头执行核（与 ResumeRunner 同实例 = 跨域同会话并发闸）。 */
  headless?: HeadlessRunner;
  /** 测试注入的 spawn 实现；缺省经 HeadlessRunner 用 node:child_process.spawn。 */
  spawnImpl?: SpawnLike;
  /** 测试注入的强杀实现。 */
  killImpl?: (pid: number) => void;
  /** harness 可执行覆盖（测试用）；缺省环境变量，再缺省 headless spec.bin。 */
  bin?: string;
  /** 无头回合超时（毫秒）；缺省 HeadlessRunner 默认 300s。 */
  timeoutMs?: number;
  /** outbox 根目录（测试注入）；缺省 hooksRoot()。 */
  hooksDir?: string;
  /** 能力面访问器（测试注入）；缺省 surfaces.ts 模块级 registry。 */
  surfaceFor?: (harness: Harness) => MessagingSurface;
}

/** send() 入参（路由层已做 zod 形状校验）。 */
export interface SendInput {
  toSessionId: string;
  text: string;
  mode: MessageMode;
  fromKind: MessageFromKind;
  fromSessionId?: string | null;
}

/** send() 返回：ok 由路由映射 200，否则 status 即 HTTP 码。 */
export type SendResult =
  | { ok: true; messageId: number; status: MessageStatus }
  | { ok: false; status: 400 | 404 | 409; error: string };

/** 通道裁决结果：mode=auto 落到实际通道后才存在。 */
type ResolvedChannel = 'inject' | 'headless';

export class MessageDeliverer {
  private readonly headless: HeadlessRunner;

  constructor(private readonly deps: MessageDelivererDeps) {
    this.headless =
      deps.headless ?? new HeadlessRunner({ spawnImpl: deps.spawnImpl, killImpl: deps.killImpl });
  }

  /**
   * 裁决表（规格顺序）：session 404 → harness 无法判定 400 → auto 按忙闲
   * 落通道（忙 = turnOpen）→ 通道不支持 409+reason → 无项目 400/404 →
   * headless 被占 409。通过后插入 message.created 并立即投递。
   */
  async send(input: SendInput): Promise<SendResult> {
    const session = this.deps.sessions.getBySessionId(input.toSessionId);
    if (!session) return { ok: false, status: 404, error: 'Session not found' };

    // harness 归属 = 最新事件 source（open-terminal 同口径）
    const latest = this.deps.hookEvents.listBySession(input.toSessionId, 1);
    const src = latest[latest.length - 1]?.source;
    if (!isHarness(src)) {
      return { ok: false, status: 400, error: 'Session has no hook events to determine its harness' };
    }
    const surface = this.deps.surfaceFor?.(src) ?? messagingSurfaceFor(src);

    const channel = this.resolveChannel(input.mode, input.toSessionId, surface);
    if (typeof channel !== 'string') return { ok: false, status: 409, error: channel.reason };

    // 两通道都需要项目：inject 用 token 分片 outbox，headless 用 path 做 cwd。
    if (session.projectId == null) {
      return { ok: false, status: 400, error: 'Session is not bound to a project' };
    }
    const project = this.deps.projects.getById(session.projectId);
    if (!project) return { ok: false, status: 404, error: 'Project not found' };

    if (channel === 'headless' && this.headless.isBusy(input.toSessionId)) {
      return { ok: false, status: 409, error: 'Session already has a running run' };
    }

    const meta: MessageMeta = {
      fromLabel: input.fromKind === 'session' ? `session ${input.fromSessionId ?? 'unknown'}` : input.fromKind,
      at: new Date().toISOString(),
      mode: channel,
    };
    const message = this.deps.messages.insert({
      fromKind: input.fromKind,
      fromSessionId: input.fromSessionId ?? null,
      toSessionId: input.toSessionId,
      text: input.text,
      mode: input.mode,
      status: 'queued',
    });
    this.deps.bus?.emit({
      kind: 'message.created',
      messageId: message.id,
      sessionId: input.toSessionId,
      mode: input.mode,
      at: meta.at,
    });

    if (channel === 'inject') return this.deliverInject(message, project.token, meta, surface);
    return this.deliverHeadless(message, project.path, meta, surface);
  }

  /**
   * mode → 实际通道。auto 的忙/闲基准 = turnOpenOf（与列表计算字段同语义）；
   * 忙 → inject（无通道才拒绝，绝不无头抢占），闲 → headless。
   * 对象 = 拒绝（409 reason）；字符串 = 选中的通道。
   */
  private resolveChannel(
    mode: MessageMode,
    sessionId: string,
    surface: MessagingSurface,
  ): ResolvedChannel | { reason: string } {
    if (mode === 'inject' || mode === 'headless') {
      const supported = mode === 'inject' ? surface.inject : surface.headless;
      if (!supported) return { reason: this.unsupportedReason(surface, mode) };
      return mode;
    }
    const turnOpen = this.deps.sessions.turnOpenOf(sessionId);
    const channel: ResolvedChannel = turnOpen ? 'inject' : 'headless';
    const supported = channel === 'inject' ? surface.inject : surface.headless;
    if (!supported) return { reason: this.unsupportedReason(surface, channel) };
    return channel;
  }

  /** 不支持原因：面声明优先，缺省兜底文案。 */
  private unsupportedReason(surface: MessagingSurface, channel: ResolvedChannel): string {
    return (
      surface.unsupportedReasons?.[channel] ??
      `Harness "${surface.harness}" does not support the ${channel} messaging channel`
    );
  }

  /** inject 通道：信封写 outbox → injected + deliveredAt（fire-and-forget 语义）。 */
  private deliverInject(
    message: SessionMessageRow,
    token: string,
    meta: MessageMeta,
    surface: MessagingSurface,
  ): SendResult {
    const envelope = this.renderEnvelope(message.text, meta, surface);
    appendOutbox(this.deps.hooksDir ?? hooksRoot(), token, [
      { sessionId: message.toSessionId, text: envelope },
    ]);
    const at = new Date().toISOString();
    this.deps.messages.updateStatus(message.id, { status: 'injected', delivered: true });
    this.deps.bus?.emit({ kind: 'message.delivered', messageId: message.id, sessionId: message.toSessionId, at });
    return { ok: true, messageId: message.id, status: 'injected' };
  }

  /** headless 通道：置 running + delivered → 无头 spawn；终态经 onSettle 后台回写。 */
  private deliverHeadless(
    message: SessionMessageRow,
    cwd: string,
    meta: MessageMeta,
    surface: MessagingSurface,
  ): SendResult {
    const spec = surface.headless!;
    const startedAt = new Date().toISOString();
    this.deps.messages.updateStatus(message.id, { status: 'running', delivered: true });
    this.deps.bus?.emit({
      kind: 'message.delivered',
      messageId: message.id,
      sessionId: message.toSessionId,
      at: startedAt,
    });
    const state = { settled: false };
    try {
      const started = this.headless.run({
        sessionId: message.toSessionId,
        cwd,
        prompt: this.renderEnvelope(message.text, meta, surface),
        spec,
        bin: this.deps.bin ?? process.env.WEAVE_CLAUDE_BIN ?? spec.bin,
        timeoutMs: this.deps.timeoutMs,
        onSettle: (result) => this.settle(message, state, result),
      });
      // isBusy 前置检查与本调用之间无 await（纯同步段），false 只是防御位：
      // 仍落 failed 留痕（消息可轮询），不 throw。
      if (!started) {
        this.settle(message, state, {
          status: 'failed',
          output: null,
          error: 'Session already has a running run',
        });
      }
    } catch (err) {
      this.settle(message, state, {
        status: 'failed',
        output: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { ok: true, messageId: message.id, status: 'running' };
  }

  /** 信封：面可覆写（harness 自己的表示法）；缺省 weave 通用头 + 正文。 */
  private renderEnvelope(text: string, meta: MessageMeta, surface: MessagingSurface): string {
    return surface.renderEnvelope?.(text, meta) ?? `[weave message] from=${meta.fromLabel} at=${meta.at} mode=${meta.mode}\n\n${text}`;
  }

  /** 终态落定（幂等，per-run state 守卫）：回写 → message.finished。 */
  private settle(
    message: SessionMessageRow,
    state: { settled: boolean },
    result: HeadlessSettleResult,
  ): void {
    if (state.settled) return;
    state.settled = true;
    try {
      this.deps.messages.updateStatus(message.id, {
        status: result.status,
        output: result.output,
        error: result.error,
        finished: true,
      });
      this.deps.bus?.emit({
        kind: 'message.finished',
        messageId: message.id,
        sessionId: message.toSessionId,
        status: result.status,
        at: new Date().toISOString(),
      });
    } catch {
      // settle 运行在后台事件回调里，不允许异常冒泡。
    }
  }
}
