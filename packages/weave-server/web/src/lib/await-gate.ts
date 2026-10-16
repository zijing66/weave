/**
 * 等「外部数据长成某样」的闸：数据面每次变更 poke 一次、命中即放行对应的承诺，
 * 到点还没命中照样放行（loading 不能挂死）。不轮询、不订阅——「长成什么样」由
 * 调用方给判据，这里只当那把闸，免得它也要懂会话行/终端角标长什么样。
 */
export interface AwaitGate {
  /** 等 `hit()` 成真（当下已真就直接兑现），或超时。 */
  wait(key: string, hit: () => boolean): Promise<void>;
  /** 数据变了：把这一拍够条件的放行。 */
  poke(): void;
  /** 收摊：挂着的承诺一律放行（组件没了，谁也不用等）。 */
  releaseAll(): void;
}

export function createAwaitGate(timeoutMs: number): AwaitGate {
  const waiters = new Map<string, { hit: () => boolean; release: () => void }>();
  return {
    wait(key, hit) {
      if (hit()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(key);
          resolve();
        }, timeoutMs);
        waiters.set(key, {
          hit,
          release: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
    poke() {
      for (const [key, waiter] of waiters) {
        if (!waiter.hit()) continue;
        waiters.delete(key);
        waiter.release();
      }
    },
    releaseAll() {
      for (const waiter of waiters.values()) waiter.release();
      waiters.clear();
    },
  };
}
