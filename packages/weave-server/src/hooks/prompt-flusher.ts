import type { MessageDeliverer } from './message-deliverer.js';

/**
 * prompt 队列的隐藏冲洗器（消息域重塑）：周期试递排队消息——会话可能在任何
 * 时刻被打开（peer 注册表 / 终端 pane 随时出现），ingest 即时冲洗（inbox-worker
 * 挂钩）只覆盖 weave 项目会话，本刷新器补齐其余。双触发幂等（递送键 = 行 id，
 * 起送即删行）。空队列 = 一次空 Set 迭代，零开销；不绑 SSE 订阅数（递送域
 * 非 UI 域——没人在看板也要送）。
 */
export const PROMPT_FLUSH_INTERVAL_MS = 15_000;

export function startPromptFlusher(deliverer: Pick<MessageDeliverer, 'flushAll'>): () => void {
  const timer = setInterval(() => {
    void deliverer.flushAll();
  }, PROMPT_FLUSH_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
