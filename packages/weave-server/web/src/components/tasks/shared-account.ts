import type { HookDispatch, PendingQuestionEntry, SessionRow } from '@/lib/api';
import type { ModelAliasTarget } from '@weavecode/harness';

/**
 * 跨窗共享会话账：主窗（全局 /events 的唯一订阅者）是**唯一生产者**——账本变化即
 * 写 sessionStorage 快照 + BroadcastChannel 广播；弹出窗等其他窗口是纯消费者——
 * 首拍吃快照起账、广播到即重读，自己不开全局流。
 * sessionStorage 跨窗不广播（一窗写入不触发他窗事件），故实时对齐走
 * BroadcastChannel；sessionStorage 只做冷启动种子与刷新后恢复。
 */

export interface SharedAccountSnapshot {
  at: number;
  sessions: SessionRow[] | null;
  dispatches: HookDispatch[];
  questions: PendingQuestionEntry[];
  modelCatalog: Record<string, ModelAliasTarget[]>;
}

const KEY = 'weave:shared-account';
const CHANNEL = 'weave:shared-account';

let channel: BroadcastChannel | null = null;
function bc(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) channel = new BroadcastChannel(CHANNEL);
  return channel;
}

export function readSharedAccount(): SharedAccountSnapshot | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as SharedAccountSnapshot;
    return p && typeof p.at === 'number' ? p : null;
  } catch {
    return null;
  }
}

/** 写账（sessionStorage 快照 + 广播）。sessions 只主窗整份写；dispatches /
 *  questions 是「写入口以对话窗为准」的账——哪个窗执行了写操作（派发/作答），
 *  哪个窗刷新后就把自己的最新账写进来，其余窗经广播对齐。 */
export function writeSharedAccount(snap: SharedAccountSnapshot): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(snap));
  } catch {
    // 配额满/隐私模式：账本照常在内存里跑，只是其他窗冷启动拿不到种子
  }
  bc()?.postMessage(snap.at);
}

/** 字段级写账：只覆盖传入的字段，其余沿用盘上现值（对话窗没有 sessions 全量，
 *  派发/作答后只写自己刷新出的那部分，不碰主窗的会话行）。 */
export function mergeSharedAccount(patch: Partial<Omit<SharedAccountSnapshot, 'at'>>): void {
  const cur = readSharedAccount();
  writeSharedAccount({
    at: Date.now(),
    sessions: patch.sessions ?? cur?.sessions ?? null,
    dispatches: patch.dispatches ?? cur?.dispatches ?? [],
    questions: patch.questions ?? cur?.questions ?? [],
    modelCatalog: patch.modelCatalog ?? cur?.modelCatalog ?? {},
  });
}

/** 消费者订阅「账本变了」：到即重读快照（自窗内 ALSO 收本窗生产者的广播）。 */
export function subscribeSharedAccount(listener: () => void): () => void {
  const ch = bc();
  const onMsg = (): void => listener();
  ch?.addEventListener('message', onMsg);
  return () => {
    ch?.removeEventListener('message', onMsg);
  };
}
