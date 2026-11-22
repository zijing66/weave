import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_PORT,
  DAEMON_HOST,
  readDaemonState,
  getAuthPath,
  writeClientFrame,
} from '@weavecode/server';
import { readFileSync } from 'node:fs';
import { logger } from '@weavecode/core';
import { t } from '../i18n/index.js';
import type { Command, CommandContext } from '../parser.js';

/**
 * `weave agent attach [--readonly] [sessionId]`（B5 External Attach）：CLI 连
 * daemon 的 `/terminals/ws` 网关，把 headless 实例的 TUI 桥进当前终端（Terminal
 * Bridge，Windows 不做 ConPTY 句柄转让）。外部终端与 Dashboard attach 同一实例、
 * 不重复起 Agent；输入控制权走 Input Lease（多读一写），本进程退出不影响实例。
 */

const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
/** Ctrl+Q = detach 退出键（其余按键原样交宿主 TUI）。 */
const DETACH_KEY = 0x11;

/** 读 auth.json 的本机令牌（与 daemon-auth.ts 同判据；此处避免顶层依赖环）。 */
function localToken(): string {
  try {
    const parsed = JSON.parse(readFileSync(getAuthPath(), 'utf8')) as { localToken?: unknown };
    return typeof parsed.localToken === 'string' ? parsed.localToken : '';
  } catch {
    return '';
  }
}

async function resolvePort(): Promise<number> {
  const state = readDaemonState();
  if (state) return state.port;
  return DEFAULT_PORT;
}

/** 按 sessionId 查活 headless 实例 id；无 sessionId 取第一条活实例。 */
async function resolveInstance(
  port: number,
  sessionId: string | undefined,
): Promise<{ instanceId: string; sessionTitle: string } | null> {
  const headers: Record<string, string> = {};
  const token = localToken();
  if (token) headers['x-weave-local'] = token;
  const res = await fetch(`http://${DAEMON_HOST}:${port}/sessions`, { headers });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    sessions?: Array<{ sessionId: string; title?: string | null; webInstanceId?: string | null }>;
  };
  const rows = (data.sessions ?? []).filter((s) => s.webInstanceId);
  if (sessionId) {
    const hit = rows.find((s) => s.sessionId === sessionId);
    return hit ? { instanceId: hit.webInstanceId!, sessionTitle: hit.title ?? hit.sessionId } : null;
  }
  const first = rows[0];
  return first ? { instanceId: first.webInstanceId!, sessionTitle: first.title ?? first.sessionId } : null;
}

interface Conn {
  send: (obj: Record<string, unknown>) => void;
  close: () => void;
}

/** 客户端 WS：手写握手 + writeClientFrame 掩码帧；下行经 onMessage 回调。 */
function connectWs(
  port: number,
  token: string,
  onMessage: (text: string) => void,
  onClose: () => void,
): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, DAEMON_HOST, () => {
      const key = randomBytes(16).toString('base64');
      socket.write(
        `GET /terminals/ws HTTP/1.1\r\n` +
          `Host: ${DAEMON_HOST}:${port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          (token ? `x-weave-local: ${token}\r\n` : '') +
          `\r\n`,
      );
    });
    let buf = Buffer.alloc(0);
    let handshook = false;
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshook) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.subarray(0, idx).toString('utf8');
        if (!head.includes('101')) {
          reject(new Error(t('out.attach.handshakeFailed', { status: head.split('\r\n')[0] ?? '' })));
          socket.destroy();
          return;
        }
        handshook = true;
        buf = buf.subarray(idx + 4);
        resolve({
          send: (obj) => writeClientFrame(socket, OPCODE_TEXT, JSON.stringify(obj)),
          close: () => {
            try {
              writeClientFrame(socket, OPCODE_CLOSE, Buffer.alloc(0));
              socket.end();
            } catch {
              socket.destroy();
            }
          },
        });
      }
      // 之后的 data 全是 WS 帧：逐帧解（文本帧 JSON；close/ping 简单处理）
      for (;;) {
        const parsed = readClientFrame(buf);
        if (!parsed) break;
        buf = buf.subarray(parsed.consumed);
        if (parsed.opcode === OPCODE_TEXT) onMessage(parsed.payload.toString('utf8'));
        else if (parsed.opcode === 0x9) writeClientFrame(socket, 0xa, parsed.payload);
        else if (parsed.opcode === OPCODE_CLOSE) {
          socket.destroy();
          onClose();
          return;
        }
      }
    });
    socket.on('close', onClose);
    socket.on('error', (err) => {
      if (!handshook) reject(err);
      else onClose();
    });
  });
}

function readClientFrame(buf: Buffer): { opcode: number; payload: Buffer; consumed: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let len = buf[1]! & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;
  const payload = buf.subarray(off + maskLen, off + maskLen + len);
  return { opcode, payload, consumed: off + maskLen + len };
}

async function attachAction(ctx: CommandContext): Promise<void> {
  const readonly = ctx.flags.readonly === true;
  const sessionId = ctx.positional[0] as string | undefined;
  const port = await resolvePort();
  const target = await resolveInstance(port, sessionId);
  if (!target) {
    logger.error(t('out.attach.noInstance', { sessionId: sessionId ?? '' }));
    process.exitCode = 1;
    return;
  }
  logger.info(t('out.attach.attaching', { instance: target.instanceId, title: target.sessionTitle }));

  const token = localToken();
  const stdout = process.stdout;
  const stdin = process.stdin;
  let leaseId: string | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let conn: Conn | null = null;
  let bridged = false;
  let stdinRaw = false;
  let finished = false;
  let onStdin: ((chunk: Buffer) => void) | null = null;
  let onResize: (() => void) | null = null;
  let done: (() => void) | null = null;

  const teardown = (notifyServer: boolean): void => {
    if (finished) return;
    finished = true;
    if (heartbeat) clearInterval(heartbeat);
    if (onStdin) stdin.off('data', onStdin);
    if (onResize) stdout.off('resize', onResize);
    if (stdinRaw && stdin.isTTY) {
      try {
        stdin.setRawMode(false);
      } catch {
        /* stdin 可能已不可用 */
      }
    }
    stdin.pause();
    stdin.destroy();
    if (notifyServer && conn) {
      if (leaseId) conn.send({ type: 'release', instanceId: target.instanceId, leaseId });
      conn.send({ type: 'detach', instanceId: target.instanceId });
      conn.close();
    }
    stdout.write('\r\n' + t('out.attach.detached') + '\r\n');
    done?.();
  };

  await new Promise<void>((resolve) => {
    done = resolve;

    const bridgeStdin = (canWrite: boolean): void => {
      if (bridged) return;
      bridged = true;
      if (stdin.isTTY) {
        stdin.setRawMode(true);
        stdinRaw = true;
      }
      stdin.resume();
      onStdin = (chunk: Buffer) => {
        if (finished) return;
        if (chunk.includes(DETACH_KEY)) {
          teardown(true);
          return;
        }
        if (canWrite) conn?.send({ type: 'stdin', instanceId: target.instanceId, data: chunk.toString('utf8') });
      };
      stdin.on('data', onStdin);
      if (canWrite) {
        onResize = () => {
          if (finished) return;
          conn?.send({
            type: 'resize',
            instanceId: target.instanceId,
            cols: stdout.columns ?? 80,
            rows: stdout.rows ?? 24,
          });
        };
        stdout.on('resize', onResize);
      }
    };

    connectWs(
      port,
      token,
      (text) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return;
        }
        switch (msg.type) {
          case 'terminal.output':
            stdout.write(String(msg.data ?? ''));
            break;
          case 'attached':
            stdout.write(
              t('out.attach.attachedBanner', { mode: readonly ? 'readonly' : 'interactive' }) + '\r\n',
            );
            if (!readonly) conn?.send({ type: 'request_control', instanceId: target.instanceId });
            else bridgeStdin(false);
            break;
          case 'lease.granted':
            leaseId = String(msg.leaseId ?? '');
            conn?.send({
              type: 'resize',
              instanceId: target.instanceId,
              cols: stdout.columns ?? 80,
              rows: stdout.rows ?? 24,
            });
            heartbeat = setInterval(() => {
              if (leaseId && !finished) {
                conn?.send({ type: 'heartbeat', instanceId: target.instanceId, leaseId });
              }
            }, 5_000);
            heartbeat.unref();
            bridgeStdin(true);
            break;
          case 'lease.denied':
            stdout.write(t('out.attach.leaseDenied') + '\r\n');
            bridgeStdin(false);
            break;
          case 'lease.released':
            leaseId = null;
            bridged = false;
            if (onStdin) {
              stdin.off('data', onStdin);
              onStdin = null;
            }
            if (onResize) {
              stdout.off('resize', onResize);
              onResize = null;
            }
            stdout.write(t('out.attach.leaseReleased') + '\r\n');
            break;
          default:
            break;
        }
      },
      () => teardown(false),
    )
      .then((c) => {
        if (finished) {
          c.close();
          return;
        }
        conn = c;
        c.send({
          type: 'attach',
          instanceId: target.instanceId,
          lastSequence: 0,
          cols: stdout.columns ?? 80,
          rows: stdout.rows ?? 24,
          mode: readonly ? 'readonly' : 'interactive',
        });
      })
      .catch((err: unknown) => {
        logger.error(String(err instanceof Error ? err.message : err));
        process.exitCode = 1;
        teardown(false);
      });
  });
}

export const attachCommand: Command = {
  name: 'agent',
  description: 'cmd.agent.description',
  subcommands: [
    {
      name: 'attach',
      description: 'cmd.agentAttach.description',
      options: [
        {
          name: 'readonly',
          short: 'r',
          description: 'cmd.agentAttach.readonly',
          type: 'boolean',
          default: false,
        },
      ],
      maxPositionals: 1,
      action: attachAction,
    },
  ],
};
