/**
 * 首屏请求计数器：apiFetch 每发出一个 HTTP 请求即 `total++`、响应（成功或失败
 * 都算响应）即 `done++`。启动页进度 = done/total——不是按阶段猜，是每个真实
 * 请求一格。SSE 建连不计入（它是流，不是请求响应对），由连接态单独当一路。
 *
 * 分母不随本次请求闪变：启动时从 localStorage 读「上次 boot 的总请求数」直接
 * 固化为分母（本次请求照实记账，但分母不动）；boot 收尾时把本次实际总数写回
 * 存量供下次用。首次无存量退回动态计数（分母随请求增长，只发生在第一次）。
 *
 * 模块级单例（同 auth store 惯例）。
 */

const STORE_KEY = 'weave:boot-requests-total';

/** 上次 boot 的总请求数；无存量/坏值 = null（首次访问）。 */
function lastTotal(): number | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}

let total = lastTotal() ?? 0;
/** 无存量时的动态模式（分母随请求增长）；有存量即固化，本次不再动分母。 */
const dynamic = total === 0;
let done = 0;
/** 启动期已结束（退场后新请求不再记账）。 */
let sealed = false;
/** 缓存的快照（useSyncExternalStore 的 getSnapshot 必须引用稳定）。 */
let snap = { done: 0, total };
const listeners = new Set<() => void>();

function emit(): void {
  snap = { done, total };
  for (const listener of listeners) listener();
}

export const bootRequests = {
  /** 请求发出（apiFetch 挂钩处调用）。 */
  start(): void {
    if (sealed) return;
    // 固化模式分母不动（超额照实记 done，进度提前到顶）；动态模式分母跟着涨
    if (dynamic) {
      total++;
    } else if (total < 64) {
      // 防御：实际请求远超存量（版本升级加接口）时把分母撑上去，别让进度假满
      total++;
      snap = { done, total };
    }
    emit();
  },
  /** 请求已响应（成功失败都算——失败也是一格「已响应」）。 */
  settle(): void {
    if (sealed || done >= total) return;
    done++;
    emit();
  },
  snapshot(): { done: number; total: number } {
    return snap;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** 启动页退场后调用：封账 + 把本次实际总数写回存量（下次启动的分母）。 */
  seal(): void {
    if (!sealed) {
      sealed = true;
      try {
        localStorage.setItem(STORE_KEY, String(Math.max(total, done)));
      } catch {
        // 存不进就退回每次动态计数
      }
    }
  },
};
