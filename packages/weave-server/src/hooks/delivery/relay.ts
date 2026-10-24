import { tmpdir } from 'node:os';
import type { PromptRelaySpec } from '@weavecode/harness';
import type { HeadlessRunner, HeadlessSettleResult } from '../headless-runner.js';
import type { PipeMessage } from '../message-deliverer.js';
import { isSlashCommand } from '../message-deliverer.js';

/**
 * 层① 原生中继（claude SendMessage）：复用 HeadlessRunner 的 spawn 基建
 * （win32 shell 单串 + stdin + 超时），键 = 合成键（不占目标会话的 headless
 * 并发闸）。中继是**本轮次的一次性子进程**：与 daemon 同进程组，随 daemon
 * 退出回收，不留独立进程占资源。
 *
 * 终态语义：成功 = delivered（布防回执闸；中继闸释放后若还有积压继续下一批）；
 * 失败 = failed 留内存可见并置暂停闸——不自动重试（避免对活着但拒收的会话反复
 * 打中继），手动重发解除。回执先到 = 消息确实送进去了（中继 exit 状态只管进程、
 * 不管送达），这时翻成 failed 会把已送达的会话队列无限期停住。
 */

export interface RelayDeps {
  headless: HeadlessRunner;
  /** 内存行读取（settle 需要按 id 取当前行——写期间回执可能已到）。 */
  getMemory(messageId: string): PipeMessage | null;
  /** 内存行登记/摘除。 */
  setMemory(msg: PipeMessage): void;
  /** 占住队头（送出即登记）。 */
  awaitAck(sessionId: string, messageId: string): void;
  /** 暂停闸（失败时置）。 */
  stall(sessionId: string, msg: PipeMessage, reason: 'failed'): void;
  /** 斜杠命令判定。 */
  isSlashCommand(text: string): boolean;
  armAckWatch(msg: PipeMessage): void;
  armCommandAck(messageId: string, onRelease: (sessionId: string) => void): void;
  /** 中继闸释放后若还有积压，续排下一批。 */
  onReleased(sessionId: string): void;
  emit(message: { kind: string; [key: string]: unknown }): void;
  /** 覆写 bin（测试注入；缺省 WEAVE_CLAUDE_BIN → relay.bin）。 */
  bin?: string;
  relayTimeoutMs?: number;
}

/** 中继启动（fire-and-forget）：返回是否启动成功（失败也已落终态，视作启动过）。 */
export function runRelay(
  deps: RelayDeps,
  entry: PipeMessage,
  relay: PromptRelaySpec,
  peerName: string,
  wireText: string,
): boolean {
  try {
    return deps.headless.run({
      sessionId: `prompt-relay:${entry.sessionId}`,
      cwd: tmpdir(),
      prompt: relay.instruction(peerName, wireText, { oneWay: entry.oneWay === true }),
      spec: { supported: true, bin: relay.bin, args: () => [...relay.args], promptStdin: true },
      bin: deps.bin ?? process.env.WEAVE_CLAUDE_BIN ?? relay.bin,
      timeoutMs: deps.relayTimeoutMs ?? 0,
      detached: false,
      onSettle: (result) => settleRelay(deps, entry.id, result),
    });
  } catch (err) {
    settleRelay(deps, entry.id, {
      status: 'failed',
      output: null,
      error: err instanceof Error ? err.message : String(err),
    });
    return true; // 已落终态，视作启动过（调用方不再入队）
  }
}

/** 中继终态（幂等由 HeadlessRunner 的 per-run state 保证）。 */
export function settleRelay(
  deps: RelayDeps,
  messageId: string,
  result: HeadlessSettleResult,
): void {
  const msg = deps.getMemory(messageId);
  if (!msg) return;
  if (result.status === 'succeeded') {
    // 中继退出 = 同会话中继闸释放：若还有积压，继续下一批（不必等下一次事件）
    deps.onReleased(msg.sessionId);
    const delivered: PipeMessage = {
      ...msg,
      status: 'delivered',
      settledAt: new Date().toISOString(),
    };
    deps.setMemory(delivered);
    if (isSlashCommand(msg.text)) deps.armCommandAck(messageId, deps.onReleased);
    else deps.armAckWatch(delivered);
    deps.emit({
      kind: 'message.delivered',
      messageId,
      sessionId: msg.sessionId,
      at: new Date().toISOString(),
    });
    return;
  }
  // 回执先到 = 消息确实送进去了：翻成 failed 并置闸会把已送达的队列无限期停住。
  if (msg.acked === true) {
    const at = new Date().toISOString();
    deps.setMemory({ ...msg, status: 'delivered', settledAt: at });
    deps.emit({ kind: 'message.delivered', messageId, sessionId: msg.sessionId, at });
    return;
  }
  const failed: PipeMessage = {
    ...msg,
    status: 'failed',
    error: result.error ?? `prompt relay ${result.status}`,
    settledAt: new Date().toISOString(),
  };
  deps.setMemory(failed);
  deps.stall(msg.sessionId, failed, 'failed');
  deps.emit({
    kind: 'message.finished',
    messageId,
    sessionId: msg.sessionId,
    status: 'failed',
    at: new Date().toISOString(),
  });
}

export { tmpdir };
