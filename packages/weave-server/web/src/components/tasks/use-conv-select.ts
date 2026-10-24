import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type React from 'react';
import { DOUBLE_TAP_MS, TAP_SLOP, type ConvMenu } from './conv-widgets';
import type { ConvEntry } from './conv-model';

/**
 * 多选 + 气泡手势域：勾选账（picked/selecting）、气泡右键与触屏双击开菜单、
 * 全选/逐条勾选。菜单状态（ConvMenu）也归这里——它与多选/手势强耦合
 * （右键进多选并勾上、双击开菜单、分享动作落定即收）。
 */
export function useConvSelect(deps: {
  /** 对话条目（勾选集按 key 过滤）。 */
  thread: ConvEntry[];
  coarse: boolean;
}) {
  const { thread, coarse } = deps;
  /** 多选态：气泡上出现复选框，点气泡即勾选，底栏换成工具条。 */
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  /** 弹出菜单（位置 = 指针处）：气泡右键（那条一并勾上）与底栏「分享图片」共用一套
   *  外点关闭/Esc/滚轮退场，故只留一份状态、用 kind 分面。 */
  const [menu, setMenu] = useState<ConvMenu | null>(null);
  /** 手指这会儿落在哪条气泡上（判断这一击是不是轻点：位移超阈值即作废）。 */
  const tap = useRef<{ key: string; x: number; y: number } | null>(null);
  /** 上一次轻点：同一条气泡、间隔够短 = 双击，开右键菜单。 */
  const lastTap = useRef<{ key: string; at: number } | null>(null);

const togglePick = (key: string): void =>
  setPicked((prev) => {
    const next = new Set(prev);
    if (!next.delete(key)) next.add(key);
    return next;
  });

const enterSelect = (key?: string): void => {
  setMenu(null);
  setSelecting(true);
  if (key !== undefined) setPicked(new Set([key]));
};

/** 勾上的条目（顺序 = 对话序，与手上这批的顺序一致）。 */
const pickedEntries = (): ConvEntry[] => thread.filter((e) => picked.has(e.key));

/** 可勾选的条目 = 除压缩分隔（它不是谁说的话，没有可复制的正文）。 */
const selectable = thread.filter((e) => e.role !== 'compaction');

/** 全选的范围 = 已加载的全部条目（不是当前过滤可见的那些：过滤只看显示，
 *  勾选面不跟着变，正如过滤不收回已有的勾）。 */
const allPicked = selectable.length > 0 && selectable.every((e) => picked.has(e.key));
const toggleAll = (): void =>
  setPicked(allPicked ? new Set() : new Set(selectable.map((e) => e.key)));


/** 触屏双击开菜单（桌面走右键；鼠标不该有双击这回事）。
 *  多选不再是长按直达——它只是菜单里的一项，双击也只开菜单。 */
const onPressDown = (key: string) => (e: ReactPointerEvent): void => {
  if (!coarse || selecting || e.button !== 0) return;
  tap.current = { key, x: e.clientX, y: e.clientY };
};
const onPressMove = (e: ReactPointerEvent): void => {
  const t = tap.current;
  if (!t) return;
  if (Math.abs(e.clientX - t.x) > TAP_SLOP || Math.abs(e.clientY - t.y) > TAP_SLOP) {
    tap.current = null;
  }
};
/** 抬手定这一击：够近才算轻点，紧接着的下一击落在同一条气泡上就是双击。 */
const onPressUp = (key: string) => (e: ReactPointerEvent): void => {
  const t = tap.current;
  tap.current = null;
  if (!t || t.key !== key) return;
  const now = Date.now();
  const prev = lastTap.current;
  lastTap.current = { key, at: now };
  if (!prev || prev.key !== key || now - prev.at > DOUBLE_TAP_MS) return;
  lastTap.current = null;
  setMenu({ kind: 'bubble', x: e.clientX, y: e.clientY, key });
};
const cancelTap = (): void => {
  tap.current = null;
};


/** 每条气泡的交互面：桌面右键开菜单（进多选并勾上这条），触屏双击同效；
 *  多选态里点气泡即勾选/取消。 */
const rowProps = (key: string): React.HTMLAttributes<HTMLDivElement> => ({
  onContextMenu: (e) => {
    if (selecting) return;
    // 触屏不压原生长按：那条路是「选中文字 + 系统复制」，压掉就再也复制不了；
    // 自家菜单在触屏走双击（见 onPressUp），桌面才用右键接管
    if (coarse) return;
    e.preventDefault();
    setMenu({ kind: 'bubble', x: e.clientX, y: e.clientY, key });
  },
  onPointerDown: onPressDown(key),
  onPointerMove: onPressMove,
  onPointerUp: onPressUp(key),
  onPointerCancel: cancelTap,
  onClick: selecting ? () => togglePick(key) : undefined,
});
  return {
    selecting, setSelecting, picked, setPicked, menu, setMenu,
    togglePick, enterSelect, pickedEntries, selectable, allPicked, toggleAll,
    rowProps, cancelTap,
  };
}
