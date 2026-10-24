import type { MessagingSurface, MessageMeta } from '@weavecode/harness';
import type { SessionRepository } from '../../repositories/sessions.js';
import { appendOutbox } from '../mirror.js';
import type { HeadlessRunner, HeadlessSettleResult } from '../headless-runner.js';
import type { HookEventBus } from '../bus.js';
import type { MessageMode, PipeMessage } from '../message-deliverer.js';

/**
 * send() 的通道裁决与 inject/headless 落地：mode → 实际通道的唯一裁决点，
 * 以及两个「立即返回终态或在途」的非 prompt 通道。
 */

/** 通道裁决结果：mode=auto 落到实际通道后才存在。 */
export type ResolvedChannel = 'prompt' | 'inject' | 'headless';

/**
 * mode → 实际通道。prompt = 层① 原生 || 层② 终端通道（都没有才 409）；
 * auto 的忙/闲基准 = turnOpenOf，忙 → inject（无通道才拒绝，绝不无头抢占），
 * 闲 → headless。对象 = 拒绝（409 reason）；字符串 = 选中的通道。
 */
export function resolveChannel(
  deps: Pick<SessionRepository, 'turnOpenOf'>,
  hasTerminalChannel: () => boolean,
  mode: MessageMode,
  sessionId: string,
  surface: MessagingSurface,
): ResolvedChannel | { reason: string } {
  if (mode === 'prompt') {
    if (surface.prompt || surface.queuedPrompt) return 'prompt';
    if (hasTerminalChannel()) return 'prompt';
    return {
      reason:
        surface.unsupportedReasons?.prompt ??
        `Harness "${surface.harness}" has no native prompt channel and the configured terminal cannot inject text`,
    };
  }
  if (mode === 'inject' || mode === 'headless') {
    const supported = mode === 'inject' ? surface.inject : surface.headless;
    if (!supported) return { reason: unsupportedReason(surface, mode) };
    return mode;
  }
  const turnOpen = deps.turnOpenOf(sessionId);
  const channel: Exclude<ResolvedChannel, 'prompt'> = turnOpen ? 'inject' : 'headless';
  const supported = channel === 'inject' ? surface.inject : surface.headless;
  if (!supported) return { reason: unsupportedReason(surface, channel) };
  return channel;
}

/** 不支持原因：面声明优先，缺省兜底文案。 */
export function unsupportedReason(
  surface: MessagingSurface,
  channel: Exclude<ResolvedChannel, 'prompt'>,
): string {
  return (
    surface.unsupportedReasons?.[channel] ??
    `Harness "${surface.harness}" does not support the ${channel} messaging channel`
  );
}

/** 信封：面可覆写（harness 自己的表示法）；缺省 weave 通用头 + 正文。 */
export function renderEnvelope(
  text: string,
  meta: MessageMeta,
  surface: MessagingSurface,
): string {
  return (
    surface.renderEnvelope?.(text, meta) ??
    `[weave message] from=${meta.fromLabel} at=${meta.at} mode=${meta.mode}\n\n${text}`
  );
}

export interface InjectDeps {
  hooksDir: string;
  memory: Map<string, PipeMessage>;
  bus: Pick<HookEventBus, 'emit'>;
}

/** inject 通道：信封写 outbox → injected（fire-and-forget 语义）。 */
export function deliverInject(
  deps: InjectDeps,
  entry: PipeMessage,
  token: string,
  meta: MessageMeta,
  surface: MessagingSurface,
  wireText: string,
): { ok: true; messageId: string; status: 'injected'; message: PipeMessage } {
  const envelope = renderEnvelope(wireText, meta, surface);
  appendOutbox(deps.hooksDir, token, [{ sessionId: entry.sessionId, text: envelope }]);
  const msg: PipeMessage = { ...entry, status: 'injected', settledAt: new Date().toISOString() };
  deps.memory.set(msg.id, msg);
  deps.bus.emit({
    kind: 'message.delivered',
    messageId: msg.id,
    sessionId: entry.sessionId,
    at: new Date().toISOString(),
  });
  return { ok: true, messageId: msg.id, status: 'injected', message: msg };
}

export interface HeadlessDeps {
  memory: Map<string, PipeMessage>;
  headless: HeadlessRunner;
  bus: Pick<HookEventBus, 'emit'>;
  /** 覆写 bin（测试注入；缺省 WEAVE_CLAUDE_BIN → spec.bin）。 */
  bin?: string;
  timeoutMs?: number;
}

/** headless 通道：置 running → 无头 spawn；终态经 onSettle 后台回写（幂等）。 */
export function deliverHeadless(
  deps: HeadlessDeps,
  entry: PipeMessage,
  cwd: string,
  meta: MessageMeta,
  surface: MessagingSurface,
  wireText: string,
): { ok: true; messageId: string; status: 'running'; message: PipeMessage } {
  const spec = surface.headless!;
  const msg: PipeMessage = { ...entry, status: 'running' };
  deps.memory.set(msg.id, msg);
  const state = { settled: false };
  try {
    const started = deps.headless.run({
      sessionId: msg.sessionId,
      cwd,
      prompt: renderEnvelope(wireText, meta, surface),
      spec,
      bin: deps.bin ?? process.env.WEAVE_CLAUDE_BIN ?? spec.bin,
      timeoutMs: deps.timeoutMs,
      onSettle: (result) => settleHeadless(deps, msg, state, result),
    });
    // isBusy 前置检查与本调用之间无 await（纯同步段），false 只是防御位：
    // 仍落 failed 留痕（消息可轮询），不 throw。
    if (!started) {
      settleHeadless(deps, msg, state, {
        status: 'failed',
        output: null,
        error: 'Session already has a running run',
      });
    }
  } catch (err) {
    settleHeadless(deps, msg, state, {
      status: 'failed',
      output: null,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { ok: true, messageId: msg.id, status: 'running', message: deps.memory.get(msg.id)! };
}

/** 终态落定（幂等，per-run state 守卫）：回写 → message.finished。 */
function settleHeadless(
  deps: HeadlessDeps,
  msg: PipeMessage,
  state: { settled: boolean },
  result: HeadlessSettleResult,
): void {
  if (state.settled) return;
  state.settled = true;
  const current = deps.memory.get(msg.id);
  if (!current) return;
  try {
    deps.memory.set(msg.id, {
      ...current,
      status: result.status,
      output: result.output,
      error: result.error,
      settledAt: new Date().toISOString(),
    });
    deps.bus.emit({
      kind: 'message.finished',
      messageId: msg.id,
      sessionId: msg.sessionId,
      status: result.status,
      at: new Date().toISOString(),
    });
  } catch {
    // settle 运行在后台事件回调里，不允许异常冒泡。
  }
}
