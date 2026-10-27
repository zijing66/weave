import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { SessionTitleSurface } from '../driver.js';
import { codexHome } from './home.js';
import { codexCommandLine } from './plugins.js';

/**
 * Codex 会话标题读写面（SessionTitleSurface）：
 * - 读 = `<CODEX_HOME>/session_index.jsonl` 从尾扫（append-only、最新条目胜，
 *   与宿主 `find_thread_name_by_id` 同判据）；清名字时宿主置空串 → null。
 * - 写 = 官方 app-server RPC `thread/name/set`（宿主侧与 TUI rename 同源：
 *   落 sqlite threads.name + session_index append）。
 * 宿主自动名（threads.title）不进 session_index——本面只同步用户自定义名。
 */

const RPC_TIMEOUT_MS = 10_000;

/** mtime+size 指纹缓存：hook ingest 每条事件都会查一次，重读只在文件变化后。 */
const indexCache = new Map<string, { mtimeMs: number; size: number; names: Map<string, string> }>();

export function codexSessionTitleOf(sessionId: string, home?: string): string | null {
  const file = path.join(codexHome(home), 'session_index.jsonl');
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return null;
  }
  const cached = indexCache.get(file);
  if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
    const names = new Map<string, string>();
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as { id?: unknown; thread_name?: unknown };
          if (typeof entry.id === 'string' && typeof entry.thread_name === 'string') {
            names.set(entry.id, entry.thread_name);
          }
        } catch {
          // 坏行跳过（append-only 中途截断容忍）
        }
      }
    } catch {
      return null;
    }
    indexCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, names });
  }
  const name = indexCache.get(file)!.names.get(sessionId) ?? null;
  return name != null && name.trim() ? name : null;
}

/** 与 officialSkills 同款 app-server JSON-RPC：握手后一发一收即杀树。 */
export function codexSetSessionTitle(sessionId: string, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const trimmed = name.trim();
    if (!trimmed) {
      reject(new Error('thread name must not be empty'));
      return;
    }
    const win = process.platform === 'win32';
    const child = spawn(
      win ? process.env['ComSpec'] || 'cmd.exe' : 'codex',
      win ? ['/d', '/s', '/c', codexCommandLine(['app-server'])] : ['app-server'],
      { windowsHide: true, windowsVerbatimArguments: win, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let settled = false;
    let buf = '';
    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // win32 只杀得到 cmd.exe 外壳：孙进程会吊住管道，必须杀树
      if (win && child.pid !== undefined) {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).unref();
      } else {
        child.kill('SIGKILL');
      }
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error('codex app-server thread/name/set timed out')), RPC_TIMEOUT_MS);
    const send = (msg: unknown): void => {
      child.stdin?.write(`${JSON.stringify(msg)}\n`);
    };
    child.on('error', () => finish(new Error('failed to spawn codex app-server')));
    child.on('exit', () => finish(new Error('codex app-server exited before thread/name/set')));
    child.stdin?.on('error', () => finish(new Error('codex app-server stdin closed')));
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
        let msg: { id?: unknown; error?: { code?: unknown; message?: unknown }; result?: unknown } | null = null;
        try {
          msg = JSON.parse(line) as { id?: unknown };
        } catch {
          continue;
        }
        if (msg?.id === 1) {
          send({ jsonrpc: '2.0', method: 'initialized', params: {} });
          send({ jsonrpc: '2.0', id: 2, method: 'thread/name/set', params: { threadId: sessionId, name: trimmed } });
          continue;
        }
        if (msg?.id === 2) {
          finish(msg.error ? new Error(String(msg.error.message ?? 'thread/name/set failed')) : null);
        }
      }
    });
  });
}

export function createCodexTitleSurface(deps: { home?: string } = {}): SessionTitleSurface {
  return {
    harness: 'codex',
    sessionTitleOf: (sessionId) => Promise.resolve(codexSessionTitleOf(sessionId, deps.home)),
    setSessionTitle: (sessionId, name) => codexSetSessionTitle(sessionId, name),
  };
}

export const CODEX_TITLES: SessionTitleSurface = createCodexTitleSurface();
