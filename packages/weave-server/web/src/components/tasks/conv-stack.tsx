import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';
import { formatStamp } from '@/lib/hook-payload';
import { Collapsible } from './conv-widgets';
import { AssistantMarkdown } from '@/components/ui/assistant-markdown';
import { hasVisualizeRef, visualizeSegments, type ConvEntry } from './conv-model';
import { VizSegments } from './VisualizationFrame';

/**
 * 过程输出叠层（扑克牌堆）：两条最终消息之间的连续 narration 段收纳成一叠。
 * 顶卡 = 当前段完整正文；下层卡边从**左侧**露出（横向牌堆，与翻页同轴），
 * 每 5 张隐藏卡露一层；左右滑动（触屏）/ hover 箭头（桌面）翻页；页码 `n/N` 跟动。
 *
 * **数据层不动**：thread 保持扁平，分组只发生在渲染前（`stackUnitsOf`）；
 * 多选态整叠摊平（SessionMessages 负责），翻页位置是组件内部状态、不进 URL。
 */

/** 一叠 = 连续 narration 段（时间序）。 */
export interface NarrationGroup {
  key: string;
  at: string;
  segs: ConvEntry[];
}

/**
 * 渲染前分组：连续 `narration === true` 的条目折成一组，任何其他条目断组。
 * 返回渲染单元序列，SessionMessages 的 map 直接消费。
 */
export type StackUnit =
  | { kind: 'group'; group: NarrationGroup }
  | { kind: 'entry'; entry: ConvEntry };

export function stackUnitsOf(entries: readonly ConvEntry[], flat = false): StackUnit[] {
  const units: StackUnit[] = [];
  let cur: ConvEntry[] = [];
  const flush = (): void => {
    if (cur.length === 0) return;
    if (cur.length === 1 || flat) {
      // 单段不成叠（叠层 chrome 比一条普通气泡贵）；多选态整叠摊平（勾选粒度 = 段）
      for (const e of cur) units.push({ kind: 'entry', entry: e });
    } else {
      units.push({
        kind: 'group',
        group: { key: `stk:${cur[0]!.key}`, at: cur[cur.length - 1]!.at, segs: cur },
      });
    }
    cur = [];
  };
  for (const e of entries) {
    if (e.role === 'assistant' && e.narration === true) {
      cur.push(e);
    } else {
      flush();
      units.push({ kind: 'entry', entry: e });
    }
  }
  flush();
  return units;
}

/** 每 FOLD_STEP 张隐藏卡露一层卡边（用户裁决：剩 5 张 1 层、10 张以上 2 层，
 *  以此类推）。 */
const FOLD_STEP = 5;
/** 每层露出的横向位移（px）——卡边以**顶卡盒子**为基准向左伸，最深层
 *  4×8=32px < 容器预留的 34px，绝不溢出屏幕。 */
const EDGE_X = 8;
/** 每层露出的纵向位移（px，轻微下坠让牌堆有厚度）。 */
const EDGE_Y = 2;
/** 层数上限：上百段的超长叠层不该把牌堆横着铺满屏。 */
const EDGE_LAYERS = 4;
/** 触屏翻页的滑动门槛（px；低于它算轻点/滚动）。 */
const SWIPE_X = 48;

/** 隐藏卡数 → 露边层数（不足一批也给 1 层：叠层得有「底下还有」的示意）。 */
function edgeLayersOf(n: number): number {
  return Math.min(EDGE_LAYERS, Math.max(1, Math.floor((n - 1) / FOLD_STEP)));
}

/** 当前页对应的段（idx 越界夹回——组收缩瞬间渲染先于 effect）。 */
function segKeyOf(group: NarrationGroup, idx: number): string {
  return group.segs[Math.min(Math.max(idx, 0), group.segs.length - 1)]!.key;
}

/**
 * 一叠过程输出。翻页位置是内部状态：新段到达时若正看着最新段就自动跟进
 * （与对话面板贴底跟随同构），翻到历史段则留在原地、只让 ×N 跳动。
 */
export function NarrationStack({
  group,
  selecting,
  coarse,
  isOpen,
  toggleOpen,
}: {
  group: NarrationGroup;
  selecting: boolean;
  /** 指针类型分流（用户裁决）：移动端 = 滑动卡片翻页，桌面 = 只认箭头
   *  （鼠标拖拽不翻页——拖选复制不该有副作用）。 */
  coarse: boolean;
  isOpen: (key: string) => boolean;
  toggleOpen: (key: string) => void;
}) {
  const t = useT();
  const n = group.segs.length;
  /** 看到第几张（0 基，0 = 最旧）。缺省盯最新段——实时流式时新卡滑入即顶卡。 */
  const [idx, setIdx] = useState(n - 1);
  /** 流式跟进：新段到达且此前正贴着最新段 → 跟到新最新段；翻在历史段不动。 */
  const atLatest = useRef(true);
  useEffect(() => {
    if (atLatest.current) setIdx(n - 1);
  }, [n]);
  const go = (delta: number): void => {
    setIdx((prev) => {
      const next = Math.min(Math.max(prev + delta, 0), n - 1);
      atLatest.current = next === n - 1;
      return next;
    });
  };
  /** 直接跳到某张（首/尾按钮用）：跳到最新一张即恢复流式跟进。 */
  const jump = (target: number): void => {
    setIdx(() => {
      const next = Math.min(Math.max(target, 0), n - 1);
      atLatest.current = next === n - 1;
      return next;
    });
  };
  // 组内段数变化（新段并入）时夹回合法区间
  useEffect(() => {
    setIdx((prev) => Math.min(prev, n - 1));
  }, [n]);

  /** 触屏滑动（仅 coarse 指针）：容器 touch-action: pan-y——横向手势归我们
   *  （浏览器不再把它当滚动接管、也就不会中途 pointercancel），纵向滚动照常
   *  还给页面。桌面（fine）不挂手势：翻页只认箭头，拖选复制没有副作用。 */
  const startX = useRef<number | null>(null);
  const pointerId = useRef<number | null>(null);
  /** 顶卡展开（用户在读长文）时翻页手势停用——滑动会跟文本选择打架，
   *  收起（收纳态）才可翻。 */
  const swiping = coarse && !isOpen(segKeyOf(group, idx));
  const onPointerDown = (e: React.PointerEvent): void => {
    if (!swiping || pointerId.current !== null) return; // 多指只认第一根
    pointerId.current = e.pointerId;
    startX.current = e.clientX;
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    // 起手后浏览器若接管了滚动（纵向为主）会发 pointercancel——清账即可，
    // 真正的翻页判定在 up/cancel 里按位移做。
    if (pointerId.current !== e.pointerId) startX.current = null;
  };
  const settle = (e: React.PointerEvent): void => {
    if (pointerId.current !== e.pointerId) return;
    pointerId.current = null;
    const x0 = startX.current;
    startX.current = null;
    if (x0 === null || !swiping) return;
    const dx = e.clientX - x0;
    if (dx <= -SWIPE_X) go(1);
    else if (dx >= SWIPE_X) go(-1);
  };

  const seg = group.segs[Math.min(idx, n - 1)]!;
  return (
    <div
      // 只挂 touch-pan-y：横向手势归 JS（浏览器不当滚动接管、不发 pointercancel），
      // 纵向滚动照常还给页面。不能再叠 touch-manipulation——产物 CSS 里它排在
      // pan-y 之后，touch-action: manipulation 会把 pan-y 整个覆盖掉（滑动失效根因）。
      className={cn('flex touch-pan-y justify-start', selecting && 'select-none')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={settle}
      onPointerCancel={settle}
    >
      <div
        className="relative min-w-0 max-w-[92%]"
        // 缩进 = 层数 × 每层位移：最深层卡边（left: -层数×8）恰好贴回容器左缘，
        // 与普通气泡左缘对齐（用户裁决）；层数少时顶卡缩进也随之变小。
        style={{ paddingLeft: edgeLayersOf(n) * EDGE_X }}
      >
        {/* 牌堆定位基准 = 顶卡盒子（不是带 padding 的外层——旧版卡边把 30px
            padding 也算进 left，伸出 54px 才是溢出根源）。下层卡边从**左侧**
            露出：每 FOLD_STEP 张隐藏卡一层，越深越淡、微微下坠。 */}
        <div className="relative">
          {Array.from({ length: edgeLayersOf(n) }, (_, i) => (
            <div
              key={i}
              aria-hidden
              className={cn(
                'absolute rounded-lg border border-edge/[0.08] bg-neutral-800/40',
                // 深层更淡：牌堆的远近感
                i === 0 ? 'opacity-70' : i === 1 ? 'opacity-45' : i === 2 ? 'opacity-25' : 'opacity-15',
              )}
              style={{
                left: (i + 1) * -EDGE_X,
                right: 0,
                top: 8 + (i + 1) * EDGE_Y,
                bottom: 8 + (i + 1) * EDGE_Y,
              }}
            />
          ))}
          {/* 顶卡：当前段完整正文（复用普通气泡的壳与 Collapsible） */}
          <div
            key={seg.key}
            className="relative rounded-lg border border-edge/[0.08] bg-neutral-800/50 px-2 py-1.5 weave-card-in"
          >
            <span className="mb-0.5 flex items-center gap-1.5 text-10 text-neutral-600">
              {formatStamp(seg.at)}
              <span className="shrink-0 rounded bg-neutral-500/15 px-1 py-px text-10 font-medium text-neutral-400">
                {t('tasks.convNarration')}
              </span>
              {n > 1 && (
                <span className="flex shrink-0 items-center gap-0.5">
                  {/* 翻页器收进头部行（用户裁决）：位置恒定不随气泡尺寸变化，
                      箭头围页码是标准 pager 形态；桌面 hover 浮现、触屏常显。
                      双箭头 = 跳到最前/最后（长叠层一格格翻太慢）。
                      置灰只在「看得见」的态生效——disabled:opacity-30 特异性
                      压过 opacity-0，非 hover 态的到头按钮会漏出来（实测）。 */}
                  {([
                    { icon: ChevronsLeft, label: 'tasks.convStackFirst', at: 0, act: () => jump(0) },
                    { icon: ChevronLeft, label: 'tasks.convStackPrev', at: 0, act: () => go(-1) },
                  ] as const).map(({ icon: Icon, label, at, act }) => (
                    <button
                      key={label}
                      type="button"
                      aria-label={t(label)}
                      onClick={act}
                      disabled={idx === at}
                      className={cn(
                        'rounded p-px text-neutral-500 transition-colors hover:text-neutral-200',
                        'disabled:pointer-events-none',
                        // 置灰挂 hover/focus 态（触屏常显则直接挂基础态），
                        // 不与「非 hover 全隐」的 opacity-0 打架
                        coarse
                          ? 'disabled:opacity-30'
                          : 'opacity-0 group-hover/stack:opacity-100 focus-visible:opacity-100 group-hover/stack:disabled:opacity-30',
                      )}
                    >
                      <Icon className="h-3 w-3" />
                    </button>
                  ))}
                  {/* 页码夹在 ◀ ▶ 之间（标准 pager 形态；b57f3b6a 表渲染重构时被挤掉过） */}
                  <span className="tabular-nums text-neutral-500">
                    {idx + 1}/{n}
                  </span>
                  {([
                    { icon: ChevronRight, label: 'tasks.convStackNext', at: n - 1, act: () => go(1) },
                    { icon: ChevronsRight, label: 'tasks.convStackLast', at: n - 1, act: () => jump(n - 1) },
                  ] as const).map(({ icon: Icon, label, at, act }) => (
                    <button
                      key={label}
                      type="button"
                      aria-label={t(label)}
                      onClick={act}
                      disabled={idx === at}
                      className={cn(
                        'rounded p-px text-neutral-500 transition-colors hover:text-neutral-200',
                        'disabled:pointer-events-none',
                        coarse
                          ? 'disabled:opacity-30'
                          : 'opacity-0 group-hover/stack:opacity-100 focus-visible:opacity-100 group-hover/stack:disabled:opacity-30',
                      )}
                    >
                      <Icon className="h-3 w-3" />
                    </button>
                  ))}
                </span>
              )}
            </span>
            <Collapsible
              text={seg.text}
              open={isOpen(seg.key)}
              onToggle={() => toggleOpen(seg.key)}
              disabled={selecting}
            >
              {/* 渲染块引用行整行换成 sandbox iframe（与 assistant 气泡同口径） */}
              {hasVisualizeRef(seg.text) ? (
                <VizSegments
                  segments={visualizeSegments(seg.text)}
                  markdown={(text) => <AssistantMarkdown text={text} />}
                />
              ) : (
                <div className="[&_p]:whitespace-pre-wrap">
                  <AssistantMarkdown text={seg.text} />
                </div>
              )}
            </Collapsible>
          </div>
        </div>
      </div>
    </div>
  );
}
