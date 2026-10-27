import { claudeLivenessById } from './claude-liveness.js';
import { codexLivenessById } from '@weavecode/harness';

/**
 * 判活装配：把各 harness 的 liveness 槽并成消费方要的同步 `() => Map`。
 * claude 注册表全同步现算；codex 锁探针是异步 spawn（~0.7s/轮），后台按
 * 15s 一拍刷新缓存、消费方读上次快照——判活消费点（队列落定/terminated
 * 补射/诊断）都在事件路径上，等不起 spawn。
 */

/** codex 缓存的刷新节奏（与 livenessRefresher 的 15s 同拍）。 */
const CODEX_REFRESH_MS = 15_000;

let codexCache: Map<string, boolean> = new Map();

/** 后台刷新 codex 缓存；探针失败保持旧值（只损失新鲜度，不产生错误结论）。 */
async function refreshCodexCache(now: number): Promise<void> {
  try {
    const map = await codexLivenessById(undefined, now);
    codexCache = map;
  } catch {
    /* 保持旧值 */
  }
}

let codexTimer: NodeJS.Timeout | null = null;

/** 起 codex 缓存的周期刷新（unref：不吊住 daemon 退出）。 */
function ensureCodexRefreshLoop(): void {
  if (codexTimer) return;
  codexTimer = setInterval(() => {
    void refreshCodexCache(Date.now());
  }, CODEX_REFRESH_MS);
  codexTimer.unref();
}

/**
 * 全 harness 合并存活图：claude 现算 + codex 缓存。两实现只输出判得动的
 * 条目，「查不到」当未知——消费方 `pidAliveOf` 的三态合成不受影响。
 */
export function combinedLivenessOf(): Map<string, boolean> {
  ensureCodexRefreshLoop();
  const map = claudeLivenessById();
  for (const [id, v] of codexCache) map.set(id, v);
  return map;
}

/** 测试用：清 codex 缓存与刷新循环状态。 */
export function resetCombinedLivenessForTest(): void {
  if (codexTimer) {
    clearInterval(codexTimer);
    codexTimer = null;
  }
  codexCache = new Map();
}
