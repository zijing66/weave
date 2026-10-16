import net from 'node:net';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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

/** 直投凭据落盘文件名（放 `<dataDir>/hooks/` 下；装配侧拼路径用同一常量）。 */
export const INBOX_TARGETS_FILE = 'inbox-targets.json';

/**
 * 读盘上凭据：缺失 / 坏文件 / 字段不像凭据一律视同没有（照常靠 hook 事件补回来）。
 * 值域收窄在读取处做——盘上的东西不能直接当可信形状使。
 */
function readTargets(file: string): Record<string, InboxTarget> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, InboxTarget> = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      const t = value as { socket?: unknown; token?: unknown };
      if (typeof t?.socket !== 'string' || !t.socket) continue;
      out[sessionId] = {
        socket: t.socket,
        token: typeof t.token === 'string' && t.token ? t.token : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * sessionId → 该会话的 inbox 目标：由 hook 事件旁路上报（hook 进程是会话自己的 child，
 * 继承会话导出的 env），并落 `<dataDir>/hooks/inbox-targets.json`（0600，与 auth.json
 * 同口径的非 UI 面）。**凭据不进 payload、不落库、不进 UI、不写日志**。
 *
 * 为什么要落盘：凭据活在**会话进程**里（socket 由它托管、token 每进程一份），daemon
 * 重启不动它们——只落 daemon 自己的记忆。于是「重启后首条手动消息只能走终端/中继」
 * 这个窗口消失（原先要等下一次 hook 事件把凭据带回来）。会话自己 resume/重启换了
 * socket（旧值即废）时，覆盖前那一刻只会**连不上 → 回落**，不猜不误投；新值随下一次
 * hook 事件覆盖写回。会话删除/归档时 forget（落盘行一并清）。
 */
export class InboxSocketRegistry {
  private readonly bySession: Map<string, InboxTarget>;
  /** 上次落盘的内容（hook 每次事件都上报，值没变就不重写盘）。 */
  private persisted: string;

  constructor(private readonly file?: string) {
    const loaded = file ? readTargets(file) : {};
    this.bySession = new Map(Object.entries(loaded));
    this.persisted = JSON.stringify(loaded);
  }

  /** 上报/刷新（hook 每次事件都会带，覆盖写即最新）。socket 为空 = 该会话没有可用 inbox。 */
  set(sessionId: string, target: InboxTarget | null): void {
    const prev = this.bySession.get(sessionId);
    if (!target?.socket) {
      if (prev) {
        this.bySession.delete(sessionId);
        this.persist();
      }
      return;
    }
    if (prev && prev.socket === target.socket && prev.token === target.token) return;
    this.bySession.set(sessionId, target);
    this.persist();
  }

  get(sessionId: string): InboxTarget | undefined {
    return this.bySession.get(sessionId);
  }

  forget(sessionId: string): void {
    if (this.bySession.delete(sessionId)) this.persist();
  }

  /** 原子写（临时文件 + rename）+ 0600（Windows 上 chmod 近似 no-op，无害）。 */
  private persist(): void {
    if (!this.file) return;
    const next = JSON.stringify(Object.fromEntries(this.bySession));
    if (next === this.persisted) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, `${next}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.file);
      chmodSync(this.file, 0o600);
      this.persisted = next;
    } catch {
      // 这条路径由 hook 事件驱动：落盘失败绝不能冒泡（内存态照常能投，下轮再试）
    }
  }
}
