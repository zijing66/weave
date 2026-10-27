import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { LivenessSurface } from '../driver.js';
import { codexHome } from './home.js';

/**
 * codex 会话存活判定：codex 没有进程注册表，但每个活跃 thread 在
 * `<CODEX_HOME>/thread-writer-locks/<sessionId>.lock` 持一把**独占**写锁
 * （先于 rollout 创建、全程持有——实测跨回合与长空闲不释放、正常关闭即删、
 * 崩溃后句柄由内核释放但文件残留）——HELD = 活。
 * node 的 libuv 恒以全共享打开文件探不到独占锁，批量探测经 PowerShell 一枪
 * （`[IO.File]::Open` 以 None 共享开，IOException = HELD；~0.7s/轮，2026-10-26 实测）。
 * `.coordination.lock` 等非 UUID 命名不是 thread 锁，跳过。
 *
 * 失去 HELD（FREE/文件消失）**不当场判死**：锁的释放瞬间（正在关闭、queue
 * 命令触碰）不该让在途消息落定——宽限窗（`CODEX_LOCK_GRACE_MS`）内不输出
 * （当未知），过窗才输出 false。宽限锚点 = 最后一次见到 HELD 的时刻；daemon
 * 重启后状态清零，用 FREE 锁文件的 mtime 兜底（0 字节文件 mtime ≈ 创建时刻
 * ≤ 死亡时刻，宽限只会长不会短）。与 claude 注册表的豁免窗同构。
 */

/** 失去 HELD 后的宽限窗：期内当未知，过窗才判死。 */
export const CODEX_LOCK_GRACE_MS = 90_000;

/** thread 锁文件名 = 裸 UUID（rollout 的 thread id）；其余（`.coordination.lock`）不认。 */
const THREAD_LOCK_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.lock$/i;

/** 锁目录（`home` 注入供测试；缺省 `codexHome()`）。 */
export function codexThreadLockDir(home?: string): string {
  return path.join(codexHome(home), 'thread-writer-locks');
}

/**
 * 批量锁探针的注入口（测试注入假实现）；缺省 spawn PowerShell 一枪探全部，
 * 回 HELD 的锁名集合。探针失败（超时/spawn 不出）回空集——只损失 true
 * （当未知），绝不产生错误的「死」。
 */
export type LockProbe = (lockNames: readonly string[]) => Promise<Set<string>>;

async function probeHeldLocksWin32(lockNames: readonly string[], dir: string): Promise<Set<string>> {
  const { spawn } = await import('node:child_process');
  // 单引号 here-string 传路径（PS 单引号内无插值；路径不含单引号——Windows 文件名禁之）
  const psQuote = (p: string) => p.replace(/'/g, "''");
  const script = [
    '$results = @()',
    ...lockNames.map((name) => {
      const full = path.win32.join(dir, name);
      return (
        `try { [void][IO.File]::Open('${psQuote(full)}','Open','ReadWrite','None') } ` +
        `catch [IO.IOException] { $results += '${psQuote(name)}' }`
      );
    }),
    '$results -join "`n"',
  ].join('; ');
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(new Set());
    }, 5000);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(new Set());
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(
        new Set(
          out
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean),
        ),
      );
    });
  });
}

/** 非 win32 的锁探针：flock 语义不同，v1 不实现（空集 = 全不判）。 */
async function probeHeldLocksUnsupported(): Promise<Set<string>> {
  return new Set();
}

/** 宽限锚点（sessionId → 最后一次见到 HELD 的 epoch ms）；daemon 生命周期内累积。 */
const lastHeldAt = new Map<string, number>();

/**
 * codex 存活图：目录里全部 thread 锁 → 一枪探针 → 合成宽限三态。
 * HELD → true（刷新锚点）；失去 HELD → 宽限期内不输出（当未知）、过窗 false；
 * 从没见过的 FREE 锁用 mtime 当锚点（重启后崩溃残留立即可判）。
 * 探针失败回空 map（全不判，不许误判死）。
 */
export async function codexLivenessById(home?: string, now: number = Date.now()): Promise<Map<string, boolean>> {
  const dir = codexThreadLockDir(home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return new Map();
  }
  const locks = names.filter((n) => THREAD_LOCK_NAME.test(n));
  const probe: LockProbe =
    locks.length === 0
      ? async () => new Set()
      : process.platform === 'win32'
        ? (ns) => probeHeldLocksWin32(ns, dir)
        : () => probeHeldLocksUnsupported();
  const held = await probe(locks);
  const map = new Map<string, boolean>();
  for (const name of locks) {
    const id = name.replace(/\.lock$/i, '');
    if (held.has(name)) {
      lastHeldAt.set(id, now);
      map.set(id, true);
      continue;
    }
    let anchor = lastHeldAt.get(id);
    if (anchor === undefined) {
      // 重启后首见的 FREE 锁：mtime（≈创建时刻 ≤ 死亡时刻）当锚点，宽限只长不短
      try {
        anchor = statSync(path.join(dir, name)).mtimeMs;
      } catch {
        continue;
      }
      lastHeldAt.set(id, anchor);
    }
    if (now - anchor >= CODEX_LOCK_GRACE_MS) map.set(id, false);
  }
  return map;
}

/**
 * codex 的存活面：锁探针异步批量（spawn 一枪）+ 宽限窗状态在本模块——
 * 消费方要同步 map，由装配层缓存（server 的判活装配按 15s 一拍刷新）。
 */
export const CODEX_LIVENESS: LivenessSurface = {
  harness: 'codex',
  alive(ids) {
    return codexLivenessById().then((map) => {
      if (!ids) return map;
      const out = new Map<string, boolean>();
      for (const id of ids) {
        const v = map.get(id);
        if (v !== undefined) out.set(id, v);
      }
      return out;
    });
  },
};
