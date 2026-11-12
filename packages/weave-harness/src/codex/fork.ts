import { spawn } from 'node:child_process';
import type { ForkExtractSpec } from '../driver.js';
import { codexCommandLine } from './plugins.js';

/**
 * Codex 边级提取的 fork 面（编排判提合一消费）：一次性 app-server 子进程走
 * 三步 JSON-RPC——`thread/fork`（ephemeral:true，不落盘、fork_cache_key 继承
 * 源会话的 prompt cache routing ⇒ 提炼边际成本 ≈ 一回合增量 token）→
 * `turn/start`（fork 上一轮 prompt）→ 收通知流的 `item/completed`
 * （agentMessage 文本）至 `turn/completed`。weave 的会话 id 与 app-server 的
 * thread_id 同源（hook 载荷 `session_id: ThreadId`），直接可用、零映射。
 *
 * 宿主的 hook 事件会随 fork 的回合照发：`onForkId` 在 fork 落定、回合开跑
 * **之前**回调——server 先登记合成会话名单再放行，ingest 侧滤掉幽灵行。
 *
 * 任何失败（spawn / RPC 错误 / 超时 / 回合 interrupted|failed）= null，调用方
 * 回落 `{upstream}`；绝不 throw（hook 采集与编排推进都不因提炼失败受阻）。
 */

const DEFAULT_TIMEOUT_MS = 120_000;

/** 回合完成的可采纳收尾（interrupted/failed 的回合输出不完整，如实判失败）。 */
const TURN_OK_STATUS = new Set(['completed']);

interface RpcMessage {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { message?: unknown };
}

function forkResponseThreadId(result: unknown): string | null {
  const thread = (result as { thread?: { id?: unknown } } | null)?.thread;
  return typeof thread?.id === 'string' ? thread.id : null;
}

function extractParamsOf(msg: RpcMessage): Record<string, unknown> | null {
  const params = (msg as { params?: unknown }).params;
  if (!params || typeof params !== 'object') return null;
  return params as Record<string, unknown>;
}

export function createCodexForkExtract(
  deps: { timeoutMs?: number; spawnImpl?: typeof spawn } = {},
): ForkExtractSpec {
  const doSpawn = deps.spawnImpl ?? spawn;
  return {
    run({ sessionId, prompt, timeoutMs, onForkId }) {
      const limit = timeoutMs ?? deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const runPrompt = prompt.trim();
      if (!runPrompt) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        const win = process.platform === 'win32';
        const child = doSpawn(
          win ? process.env['ComSpec'] || 'cmd.exe' : 'codex',
          win ? ['/d', '/s', '/c', codexCommandLine(['app-server'])] : ['app-server'],
          { windowsHide: true, windowsVerbatimArguments: win, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        let settled = false;
        let buf = '';
        let forkId: string | null = null;
        const messages: string[] = [];
        const finish = (value: string | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // win32 只杀得到 cmd.exe 外壳：孙进程会吊住管道，必须杀树
          if (win && child.pid !== undefined) {
            spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
              windowsHide: true,
              stdio: 'ignore',
            }).unref();
          } else {
            child.kill('SIGKILL');
          }
          resolve(value);
        };
        const timer = setTimeout(() => finish(null), limit);
        const send = (msg: unknown): void => {
          child.stdin?.write(`${JSON.stringify(msg)}\n`);
        };
        child.on('error', () => finish(null));
        child.on('exit', () => finish(null));
        child.stdin?.on('error', () => finish(null));
        send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'weave', title: 'weave', version: '1.0.0' } },
        });
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          buf += chunk;
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            let msg: RpcMessage | null = null;
            try {
              msg = JSON.parse(line) as RpcMessage;
            } catch {
              continue;
            }
            if (msg?.id === 1) {
              send({ jsonrpc: '2.0', method: 'initialized', params: {} });
              // fork 恒出新 thread_id；ephemeral 不落盘（血缘只在内存，源不动）。
              // excludeTurns:true 是 ephemeral 的硬性契约（0.167 实测：缺它即 -32600）。
              send({
                jsonrpc: '2.0',
                id: 2,
                method: 'thread/fork',
                params: { threadId: sessionId, ephemeral: true, excludeTurns: true },
              });
              continue;
            }
            if (msg?.id === 2) {
              if (msg.error) {
                finish(null);
                continue;
              }
              forkId = forkResponseThreadId(msg.result);
              if (!forkId) {
                finish(null);
                continue;
              }
              // 回合开跑之前回调：ingest 侧的合成名单先就位再让事件落地。
              try {
                onForkId(forkId);
              } catch {
                // 登记失败不拦回合（名单兜底还有 TTL 与行数上限）
              }
              send({
                jsonrpc: '2.0',
                id: 3,
                method: 'turn/start',
                params: { threadId: forkId, input: [{ type: 'text', text: runPrompt }] },
              });
              continue;
            }
            if (msg?.id === 3) {
              // turn/start 的回执只说明回合受理；输出在通知流里收。
              if (msg.error) finish(null);
              continue;
            }
            if (msg?.method === 'item/completed' && forkId) {
              const params = extractParamsOf(msg);
              const item = params?.item as { type?: unknown; text?: unknown } | undefined;
              if (params?.threadId === forkId && item?.type === 'agentMessage' && typeof item.text === 'string') {
                messages.push(item.text);
              }
              continue;
            }
            if (msg?.method === 'turn/completed' && forkId) {
              const params = extractParamsOf(msg);
              const turn = params?.turn as { status?: unknown } | undefined;
              if (params?.threadId !== forkId) continue;
              // interrupted / failed 的输出不完整：call方回落上游原文，不截半份。
              if (turn?.status && !TURN_OK_STATUS.has(String(turn.status))) {
                finish(null);
                continue;
              }
              finish(messages.length > 0 ? messages.join('\n\n').trim() || null : null);
            }
          }
        });
      });
    },
  };
}

export const CODEX_FORK_EXTRACT: ForkExtractSpec = createCodexForkExtract();
