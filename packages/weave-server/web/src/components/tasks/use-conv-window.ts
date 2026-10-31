import type React from 'react';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  applyDraftSnapshot,
  draftSnapshotOf,
  serializeDraft,
  type DraftSnapshot,
} from './draft-editor';
import {
  clampConvSize,
  loadConvPos,
  loadConvSize,
  CONV_POS_KEY,
  CONV_SIZE_KEY,
  type ConvSize,
} from './conv-widgets';
import { settledUploads, type StagedFile } from './attach';
import type { PickTarget } from './FilePicker';
import type { CmdSigil, CmdSource } from './draft-editor';

/**
 * 浮窗几何域：尺寸/位移（localStorage 记住）、拖角改大小、标题栏拖动、挂载时
 * 按实测尺寸收一次越界位移。全屏切换的滚动/草稿快照也在这（嵌入形态切全屏时
 * body 改走 portal、DOM 整棵重建，先快照、切完再还）。
 */
export function useConvWindow(deps: {
  embedded: boolean | undefined;
  isDesktop: boolean;
  /** 全屏态（主组件持有：ESC/返回键链也要读它）。 */
  fullscreen: boolean;
  setFullscreen: (updater: (v: boolean) => boolean) => void;
  /** 草稿域（全屏快照要存/还草稿）。 */
  draftRef: RefObject<HTMLDivElement | null>;
  setDraft: (text: string) => void;
  buildChip: (ref: string, target: PickTarget) => HTMLElement;
  buildCmdChip: (name: string, source?: CmdSource, sigil?: CmdSigil) => HTMLElement;
  buildAttachChip: (part: { a: string; p: string; n: string; m: string }) => HTMLElement;
  buildSessionChip: (sessionId: string, name: string) => HTMLElement;
  /** 附件暂存（草稿快照的 staged 半份）。 */
  staged: StagedFile[];
  /** 气泡滚动容器（全屏快照存/还滚动位置）。 */
  threadRef: RefObject<HTMLDivElement | null>;
}) {
  const {
    embedded, isDesktop, fullscreen, setFullscreen,
    draftRef, setDraft, buildChip, buildCmdChip, buildAttachChip, buildSessionChip, staged, threadRef,
  } = deps;
const [size, setSize] = useState<ConvSize>(() => loadConvSize());
const [pos, setPos] = useState(loadConvPos);
const panelRef = useRef<HTMLDivElement | null>(null);

/** 切全屏要保住的两样：气泡的滚动位置、输入框里没发出去的草稿。
 *  嵌入形态切的那一刻 body 改走 portal（为了脱离右栏祖先的包含块），DOM 会整棵
 *  重建——滚动归零、contenteditable 也会变空，故先快照、切完再还。 */
const scrollKeeper = useRef<{
  top: number;
  atBottom: boolean;
  draft: DraftSnapshot | null;
} | null>(null);

const toggleFullscreen = (): void => {
  const el = threadRef.current;
  scrollKeeper.current = {
    top: el?.scrollTop ?? 0,
    atBottom: el ? el.scrollHeight - el.scrollTop - el.clientHeight < 8 : false,
    draft: draftSnapshotOf(draftRef.current, settledUploads(staged)),
  };
  setFullscreen((v) => !v);
};

useLayoutEffect(() => {
  const keep = scrollKeeper.current;
  if (!keep) return;
  scrollKeeper.current = null;
  const el = threadRef.current;
  if (el) el.scrollTop = keep.atBottom ? el.scrollHeight : keep.top;
  // 草稿只在嵌入形态会被重建（浮窗的 body 自始至终挂在同一个 portal 里）；
  // 拿快照重建 DOM，胶囊按 data-* 还原，与「刷新不丢」同一套路径
  if (embedded && keep.draft && draftRef.current) {
    applyDraftSnapshot(draftRef.current, keep.draft, buildChip, buildCmdChip, buildAttachChip, buildSessionChip);
    setDraft(serializeDraft(draftRef.current));
  }
}, [fullscreen, embedded]);
/** 向上翻页插入新条目后要补的滚动高度（渲染后按差值补，视口不跳）。 */
const grip = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
/** 标题栏拖动（移动整扇窗）：与拖角改大小是两回事。 */
const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
const clampPos = (x: number, y: number, s: ConvSize): { x: number; y: number } => {
  const box = panelRef.current?.getBoundingClientRect();
  const limX = Math.max(0, (innerWidth - (box?.width ?? s.w)) / 2 - 12);
  const limY = Math.max(0, (innerHeight - (box?.height ?? 0)) / 2 - 12);
  return { x: Math.max(-limX, Math.min(limX, x)), y: Math.max(-limY, Math.min(limY, y)) };
};

// 记住的位移按面板实测尺寸收一次：换了屏幕/窗口大小之后，旧位移可能出界。
// 只在挂载时收（之后每次拖动/拖角自己就在 clamp 里）。
useLayoutEffect(() => {
  if (embedded || !isDesktop) return;
  setPos((p) => clampPos(p.x, p.y, size));
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

const onGripDown = (e: React.PointerEvent<HTMLDivElement>): void => {
  const box = panelRef.current?.getBoundingClientRect();
  grip.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h || Math.round(box?.height ?? 0) };
  e.currentTarget.setPointerCapture(e.pointerId);
};
const onGripMove = (e: React.PointerEvent<HTMLDivElement>): void => {
  const g = grip.current;
  if (!g) return;
  const next = clampConvSize(g.w + (e.clientX - g.x), g.h + (e.clientY - g.y));
  setSize(next);
  setPos((p) => clampPos(p.x, p.y, next));
};
const onGripUp = (): void => {
  if (!grip.current) return;
  grip.current = null;
  setSize((s) => {
    try {
      localStorage.setItem(CONV_SIZE_KEY, JSON.stringify(s));
      // 拖角会连带 clamp 位位移，一起记下来
      localStorage.setItem(CONV_POS_KEY, JSON.stringify(pos));
    } catch {
      // 隐私模式禁写：尺寸只在本次会话有效
    }
    return s;
  });
};

const onDragDown = (e: React.PointerEvent<HTMLDivElement>): void => {
  // 标题栏上的按钮（停止/关闭/过滤）不是拖动把手
  if (!isDesktop || (e.target as HTMLElement).closest('button')) return;
  drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
  e.currentTarget.setPointerCapture(e.pointerId);
};
const onDragMove = (e: React.PointerEvent<HTMLDivElement>): void => {
  const d = drag.current;
  if (!d) return;
  setPos(clampPos(d.px + (e.clientX - d.x), d.py + (e.clientY - d.y), size));
};
const onDragUp = (): void => {
  if (!drag.current) return;
  drag.current = null;
  try {
    localStorage.setItem(CONV_POS_KEY, JSON.stringify(pos));
  } catch {
    // 隐私模式禁写：位置只在本次会话有效
  }
};
  return {
    size, setSize, pos, setPos, panelRef,
    toggleFullscreen, clampPos,
    onGripDown, onGripMove, onGripUp,
    onDragDown, onDragMove, onDragUp,
  };
}
