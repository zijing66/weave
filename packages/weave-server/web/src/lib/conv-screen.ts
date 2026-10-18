import { useSyncExternalStore } from 'react';

/**
 * `<lg` 的对话是否铺满整屏（`TasksPanel` 置位、`AiAssistant` 订阅）。
 *
 * 整屏对话把右下角也占了——AI 浮球搁那儿只是压住发送区，故对话一开它就退场。
 * 只有 `<lg` 有这回事：桌面三栏并排，对话是右栏、不盖右下角。
 */
let open = false;
const listeners = new Set<() => void>();

export function setConvScreenOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export function convScreenOpen(): boolean {
  return open;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useConvScreenOpen(): boolean {
  return useSyncExternalStore(subscribe, convScreenOpen);
}
