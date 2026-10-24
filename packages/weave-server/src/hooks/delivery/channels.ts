import { spawn } from 'node:child_process';
import { defaultKill } from '../headless-runner.js';
import { tmpdir } from 'node:os';
import type { MessagingSurface } from '@weavecode/harness';
import { isImageMediaType } from '../../repositories/uploads.js';
import type { SpawnLike } from '../headless-runner.js';
import type { PipeMessage } from '../message-deliverer.js';

/**
 * 层① 投递通道的「尝试一次」实现：宿主队列（codex queue）与会话本地 inbox
 * socket 直投。两者都是「成功即 delivered、失败即静默回落下一层」——回落不留痕
 * 是语义的一部分（凭据失效 / 会话不在 / CLI 起不来都是暂态）。
 *
 * 回执布防（armCommandAck / armAckWatch）与内存登记由宿主回调完成——本模块只管
 * 「把文本送出去」与「送出去之后长什么样」。
 */

export interface ChannelAttemptDeps {
  /** 内存行登记（delivering / delivered 都要可见）。 */
  setMemory(msg: PipeMessage): void;
  /** 摘内存行（回落时不留痕）。 */
  deleteMemory(messageId: string): void;
  /** 占住队头（送出即登记，等它的 UPS）。 */
  awaitAck(sessionId: string, messageId: string): void;
  /** 斜杠命令判定（内建命令不发 UPS，回执收尾走短窗口）。 */
  isSlashCommand(text: string): boolean;
  /** 回执布防（普通 prompt）。 */
  armAckWatch(msg: PipeMessage): void;
  /** 回执布防（斜杠命令短窗口）。 */
  armCommandAck(messageId: string): void;
  /** 消息域帧。 */
  emit(message: { kind: string; [key: string]: unknown }): void;
  spawnImpl?: SpawnLike;
}

/** 投递文本 = 用户原文经 harness `attach.composePrompt` 现合成（带附件时追加引用）。 */
export function wireTextOf(
  entry: PipeMessage,
  surfaceOfSession: (sessionId: string) => MessagingSurface | null,
): string {
  const files = entry.attachments;
  if (!files || files.length === 0) return entry.text;
  return surfaceOfSession(entry.sessionId)?.attach?.composePrompt(entry.text, files) ?? entry.text;
}

/** 有没有图（**不是**有没有附件）：宿主队列拒收图，只有图才逼着走终端。 */
export function hasImages(entry: PipeMessage): boolean {
  return (entry.attachments ?? []).some((a) => isImageMediaType(a.mediaType));
}

/** 一次性子进程：收集输出、超时强杀；非零退出 / spawn 失败都算拒绝。 */
export function spawnOnce(
  bin: string,
  args: readonly string[],
  timeoutMs: number,
  spawnImpl?: SpawnLike,
): Promise<void> {
  const doSpawn = spawnImpl ?? ((command, argv, options) => spawn(command, [...argv], options));
  return new Promise((resolve, reject) => {
    const child = doSpawn(bin, args, {
      cwd: tmpdir(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => out.push(c));
    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          defaultKill(child.pid);
        } catch {
          // 已退出：忽略
        }
      }
      reject(new Error(`queue timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const tail = Buffer.concat(out).toString('utf8').slice(-500);
      reject(new Error(`queue exit ${code}${tail ? `: ${tail}` : ''}`));
    });
  });
}

/** 落定 delivered 行（内存 + 帧 + 回执布防）——队列/直投两路共用的收尾。 */
export function settleDelivered(
  deps: ChannelAttemptDeps,
  entry: PipeMessage,
  via: 'queue' | 'socket',
): PipeMessage {
  const delivered: PipeMessage = {
    ...entry,
    status: 'delivered',
    via,
    settledAt: new Date().toISOString(),
  };
  deps.setMemory(delivered);
  deps.awaitAck(entry.sessionId, entry.id);
  if (deps.isSlashCommand(entry.text)) deps.armCommandAck(entry.id);
  else deps.armAckWatch(delivered);
  deps.emit({
    kind: 'message.delivered',
    messageId: entry.id,
    sessionId: entry.sessionId,
    at: new Date().toISOString(),
  });
  return delivered;
}
