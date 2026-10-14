import net from 'node:net';
import type { PromptInboxSpec } from '@weavecode/harness';

/**
 * 会话本地收件箱「通用传输」：连上 harness 给的地址 → 写 harness 组好的帧 → 关。
 *
 * **协议不在本模块**：帧格式、键名、平台认证要求全归 harness 的 `PromptInboxSpec`
 * （claude 的 inbox socket 规格见 weave-harness/src/claude/prompt-inbox.ts）——本模块
 * 只做「连、写、关、超时」这类与 harness 无关的机械动作，其他 harness 有同类机制时
 * 只需声明自己的 spec。
 *
 * 成功 = 已写进地址并关闭连接（**不等于**对方已读：接收侧可能 Held/Refused）。
 * 失败（连不上/超时/该平台缺凭据）→ reject，调用方回落中继/终端/队列。
 */

export interface InboxTarget {
  /** 会话自己的直投地址（hook 旁路上报；`uds:` 前缀可有可无）。 */
  socket: string;
  /** 会话自己的凭据（无 = null，能否投由 spec 的平台要求决定）。 */
  token: string | null;
}

export interface InboxDeliveryOptions {
  /** 连接 + 写入总超时；缺省 3000ms（接收侧自有关闭上限 30s，我们更严，防挂死）。 */
  timeoutMs?: number;
  platform?: string;
}

/** `/status` 的 Peer address 带 `uds:` 前缀；env 里不带。两种都接受。 */
export function inboxSocketPathOf(socket: string): string {
  return socket.startsWith('uds:') ? socket.slice(4) : socket;
}

export function deliverViaInboxSocket(
  spec: PromptInboxSpec,
  target: InboxTarget,
  text: string,
  options: InboxDeliveryOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const path = inboxSocketPathOf(target.socket);

  if (spec.requiresAuthOn(platform) && !target.token) {
    return Promise.reject(new Error(`inbox delivery requires a token on platform "${platform}"`));
  }

  return new Promise<void>((resolve, reject) => {
    const payload = spec.frame({ token: target.token, text });

    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    const socket = net.connect(path);
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => fail(new Error(`inbox socket timeout after ${timeoutMs}ms`)));
    socket.on('error', (err) => fail(err));
    socket.on('connect', () => {
      // 一条连接必须一次交付完整帧（接收侧对「多久没发出完整一行」自有限制）
      socket.write(payload, (err) => {
        if (err) fail(err);
        else socket.end();
      });
    });
    socket.on('close', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });
}

/**
 * sessionId → 该会话的 inbox 目标（内存态，**凭据不落库、不进 UI、不写日志**）：
 * 由 hook 事件旁路上报（hook 进程是会话自己的 child，继承会话导出的 env）。
 * 凭据**每会话进程一份**（resume 后 socket 名重生成、旧值即废），所以不持久化；
 * 会话删除/归档时 forget。
 */
export class InboxSocketRegistry {
  private readonly bySession = new Map<string, InboxTarget>();

  /** 上报/刷新（hook 每次事件都会带，覆盖写即最新）。socket 为空 = 该会话没有可用 inbox。 */
  set(sessionId: string, target: InboxTarget | null): void {
    if (!target?.socket) this.bySession.delete(sessionId);
    else this.bySession.set(sessionId, target);
  }

  get(sessionId: string): InboxTarget | undefined {
    return this.bySession.get(sessionId);
  }

  forget(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
