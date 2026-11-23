import { createRuntimeRegistry, codexLivenessById, type LivenessSurface } from '@weavecode/harness';

/**
 * 判活装配：经 HarnessRegistry 的 liveness 槽枚举合并（新增带 liveness 槽的
 * harness 自动吸收）。探测零 spawn 的面（`aliveSync`，claude = 注册表现算）
 * 逐拍取新鲜值；探测有开销的面（codex 锁探针 spawn ~0.7s/轮）后台按 15s 一拍
 * 刷缓存、消费方读上次快照——判活消费点（队列落定/terminated 补射/诊断）都在
 * 事件路径上，等不起 spawn。
 */

const registry = createRuntimeRegistry();

/** 声明了 liveness 槽的 (harness, 面) 列表（注册顺序）——合并点据本表枚举。 */
function livenessSurfaces(): Array<{ harness: string; surface: LivenessSurface }> {
  return registry
    .all()
    .filter((d) => d.liveness !== undefined)
    .map((d) => ({ harness: d.id, surface: d.liveness! }));
}

/** 异步探测面的缓存：面 id → 上次快照。 */
const asyncCaches = new Map<string, Map<string, boolean>>();

async function refreshAsyncCache(surface: LivenessSurface, now: number): Promise<void> {
  try {
    asyncCaches.set(surface.harness, await surface.alive(undefined, now));
  } catch {
    /* 保持旧值 */
  }
}

let refreshTimer: NodeJS.Timeout | null = null;
let primed = false;

/** 异步探测面的周期刷新（与 livenessRefresher 的 15s 同拍；unref 不吊住退出）。 */
function ensureRefreshLoop(): void {
  if (refreshTimer) return;
  // 首拍先拉一次（否则合并图要等 15s 后才有异步面的数据）——挂在首次
  // combinedLivenessOf() 上而非模块加载期：import 本模块不该起锁探针 spawn
  // （测试 import 链大面积带到这里，S3″ 盲评指认）。
  if (!primed) {
    primed = true;
    const now = Date.now();
    for (const { surface } of livenessSurfaces()) {
      if (!surface.aliveSync) void refreshAsyncCache(surface, now);
    }
  }
  refreshTimer = setInterval(() => {
    const now = Date.now();
    for (const { surface } of livenessSurfaces()) {
      if (surface.aliveSync) continue;
      void refreshAsyncCache(surface, now);
    }
  }, CODEX_REFRESH_MS);
  refreshTimer.unref();
}

const CODEX_REFRESH_MS = 15_000;

/**
 * 全 harness 合并存活图：同步面现算 + 异步面缓存。各面只输出判得动的条目，
 * 「查不到」当未知——消费方 `pidAliveOf` 的三态合成不受影响。
 */
export function combinedLivenessOf(): Map<string, boolean> {
  ensureRefreshLoop();
  const map = new Map<string, boolean>();
  for (const { surface } of livenessSurfaces()) {
    if (surface.aliveSync) {
      for (const [id, v] of surface.aliveSync()) map.set(id, v);
    } else {
      for (const [id, v] of asyncCaches.get(surface.harness) ?? []) map.set(id, v);
    }
  }
  return map;
}

/** 测试用：清缓存与刷新循环状态（primed 一并复位，重启后首拍语义复原）。 */
export function resetCombinedLivenessForTest(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  primed = false;
  asyncCaches.clear();
}

// codex 锁探针的直连取用面收口在此（liveness 槽 aliveSync 缺席时的装配缓存）；
// 其它消费方一律走 combinedLivenessOf，不直连 harness 专属函数。
export { codexLivenessById };
