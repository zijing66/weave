/** 指令卡拖拽的共享 MIME（HooksPanel 拖源 / 会话列表落点共用）。 */
export const DISPATCH_MIME = 'application/x-weave-dispatch';

export function setDispatchDrag(dt: DataTransfer, dispatchId: number): void {
  dt.setData(DISPATCH_MIME, String(dispatchId));
  dt.effectAllowed = 'copy';
}

export function getDispatchDrag(dt: DataTransfer): number | null {
  const raw = dt.getData(DISPATCH_MIME);
  if (!raw) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}
