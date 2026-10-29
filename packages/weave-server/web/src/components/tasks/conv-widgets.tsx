import { useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';
import { useBackPop } from '@/lib/back-pop';
import type { ConvEntry } from './conv-model';
import { isRemotePrompt, stripVisualizeRefs } from './conv-model';
import { api, API_BASE } from '@/lib/api';
import type { ConvImageEntry, ConvImageTag } from '@/lib/conv-image';


/** 触屏双击开菜单的两枚门槛：两击须落在同一条气泡、间隔不超过 DOUBLE_TAP_MS；
 *  位移超过 TAP_SLOP 就当是滚动，这一击不算轻点。 */
/** 触屏双击开菜单的两枚门槛：两击须落在同一条气泡、间隔不超过 DOUBLE_TAP_MS；
 *  位移超过 TAP_SLOP 就当是滚动，这一击不算轻点。 */
export const DOUBLE_TAP_MS = 300;
export const TAP_SLOP = 8;

/** 弹出菜单两副面孔：气泡右键（进多选）/ 底栏分享图片（复制 | 下载），都挂在
 *  body 上按视口坐标定位。 */
export type ConvMenu =
  | { kind: 'bubble'; x: number; y: number; key: string }
  /** 分享菜单往上弹：`bottom` 量到视口底边（贴着按钮顶）——不拿菜单高度去猜，
   *  少一项多一项都不会错位。 */
  | { kind: 'share'; left: number; bottom: number };

export const MENU_W = 168;
/** 菜单高度上限（气泡菜单至多三项）：只用于向上定位与下沿夹取，略大无害。 */
export const MENU_H = 104;

/** 设置页「当前使用」的自定义头；读不到设置就当没有（导出不该被设置面挡住）。 */
export async function activeHtmlHead(): Promise<string | null> {
  try {
    const { settings } = await api.getDaemonSettings();
    const cfg = settings.htmlExport;
    if (!cfg?.activeId) return null;
    return cfg.profiles.find((p) => p.id === cfg.activeId)?.head ?? null;
  } catch {
    return null;
  }
}

/** 上传件 → data URL（单页导出要内联）；取不到即 null，调用方写占位文本。 */
export async function imageDataUrl(id: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/images/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** 进图片的条目：正文原样全量（气泡里收着的也照全文；剥运输装饰是展示层的事，
 *  这里就是气泡里那串文本）。压缩分隔不是对话内容，不进图。气泡上的那几枚 tag
 *  （weave 来源 / 发送方 / 计划）照面板带过去——出图与窗口看到的是同一件事。 */
export const toImageEntries = (entries: readonly ConvEntry[], planLabel: string): ConvImageEntry[] =>
  entries
    .filter((e) => e.role !== 'compaction')
    .map((e) => {
      const tags: ConvImageTag[] = [];
      if (e.role === 'user' && e.fromWeave === true) tags.push({ kind: 'weave', text: 'weave' });
      if (isRemotePrompt(e)) tags.push({ kind: 'name', text: e.fromName! });
      if (e.plan === true) tags.push({ kind: 'plan', text: planLabel });
      return {
        role: e.role as ConvImageEntry['role'],
        at: e.at,
        // 渲染块引用行在分享图里是乱码，剥行保文（与 HTML 导出同口径）
        text: stripVisualizeRefs(e.text),
        ...(tags.length > 0 ? { tags } : {}),
        ...(e.pipe !== undefined ? { viaWeave: true } : {}),
        ...(e.failed === true ? { failed: true } : {}),
      };
    });

/** 弹窗尺寸：宽度跟屏幕走（宽屏优先，窄屏交给 `w-full` 类），拖角可改并记住；
 *  高度缺省 0 = 不设行内高度，沿用 h-[70%] 类（父容器 inset-0 蒙版有确定高，
 *  显式 dvh 在根 zoom 下被二次放大——见 index.css #root 注）。 */
export type ConvSize = { w: number; h: number };
export const CONV_SIZE_KEY = 'weave:conv-size';
/** 浮窗位置（相对居中位的位移）：拖标题栏挪过就记住，下次开在同一处。 */
export const CONV_POS_KEY = 'weave:conv-pos';
const SIZE_MIN = { w: 320, h: 220 };

export const clampConvSize = (w: number, h: number): ConvSize => ({
  w: Math.min(Math.max(Math.round(w), SIZE_MIN.w), Math.max(SIZE_MIN.w + 40, innerWidth - 32)),
  h:
    h > 0
      ? Math.min(Math.max(Math.round(h), SIZE_MIN.h), Math.max(SIZE_MIN.h + 40, innerHeight - 32))
      : 0,
});

/** 默认宽 = 视口 62%、高 = 蒙版 70%（h-[70%] 类），1100px 封顶（宽屏优先但不铺满整屏）。 */
export const defaultConvSize = (): ConvSize =>
  clampConvSize(Math.min(1100, Math.round(innerWidth * 0.62)), 0);

export function loadConvSize(): ConvSize {
  try {
    const raw = JSON.parse(localStorage.getItem(CONV_SIZE_KEY) ?? 'null') as ConvSize | null;
    if (!raw || typeof raw.w !== 'number' || typeof raw.h !== 'number') return defaultConvSize();
    return clampConvSize(raw.w, raw.h);
  } catch {
    return defaultConvSize();
  }
}

/** 记住的浮窗位移（相对居中位）；越界由挂载后的 clampPos 再收一次。 */
export function loadConvPos(): { x: number; y: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(CONV_POS_KEY) ?? 'null') as {
      x?: unknown;
      y?: unknown;
    } | null;
    if (typeof raw?.x === 'number' && typeof raw?.y === 'number') return { x: raw.x, y: raw.y };
  } catch {
    // 坏值就当没记过
  }
  return { x: 0, y: 0 };
}

/** 多选态气泡旁的勾选框（点击面是整个气泡，这里只显示状态）。
 *  位置贴在气泡的「内容那一侧」的上沿：自己发的在气泡左边、回复在气泡右边
 *  （两类气泡的正文都朝中间流），`self-start` 让它在底部对齐的行里仍贴顶。 */
/** 多选态气泡旁的勾选框（点击面是整个气泡，这里只显示状态）。
 *  位置贴在气泡的「内容那一侧」的上沿：自己发的在气泡左边、回复在气泡右边
 *  （两类气泡的正文都朝中间流），`self-start` 让它在底部对齐的行里仍贴顶。 */
export function CheckBox({ on, className }: { on: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center self-start rounded border',
        on ? 'border-blue-400 bg-blue-500 text-white' : 'border-neutral-600 bg-neutral-900',
        className,
      )}
    >
      {on && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
    </span>
  );
}

/**
 * 生成中那一行：只摆**最新**那条事件摘要（同事件链卡片口径）。新事件一到就换
 * 一条——`key` 变即重挂，新的从下面滚进来（keyframes 见 index.css 的
 * `weave-ticker-in`），于是一轮里这行一直在往上滚。
 */
export function EventTicker({ text }: { text: string }) {
  return (
    <span className="relative min-w-0 flex-1 overflow-hidden">
      <span key={text} className="weave-ticker-in block truncate whitespace-nowrap">
        {text}
      </span>
    </span>
  );
}

/** 折叠态的高度 ≈ 三行正文（`text-xs leading-relaxed` 19.5px/行）。 */
const CLAMP_Y = '3.75rem';
/** 收起门槛：不足六行不收——短回复（几句话的答案）本来一眼看得完，收起来只是
 *  多点一下，还把「这几行就完了」变成「后面是不是还有」。 */
const CLAMP_MIN_PX = 6 * 19.5;
/** 收起时的底部渐隐：用遮罩而不是盖一层底色——气泡底色半透明，叠色在亮/暗两
 *  套主题下都露馅。 */
const CLAMP_FADE = {
  WebkitMaskImage: `linear-gradient(to bottom, #000 55%, transparent 100%)`,
  maskImage: `linear-gradient(to bottom, #000 55%, transparent 100%)`,
};

/**
 * 可折叠的回复正文：收起时只留三行、底部渐隐。**只有底部那枚箭头能收/展**——正文
 * 自己一概不接点击（点一下就收会把「拖选复制」变成赌运气：慢机上一个 pointerup
 * 落偏就把气泡收了）。**超过六行才收**——短回复不该出现渐变或箭头，故量一次
 * `scrollHeight`；这一量在收起态（照报整段高度）与展开态（就是内容高度）下同样有效，
 * 展开中的最新那条因此也能收。展开过再收起仍认旧账（`tall` 只涨不落），否则一点开
 * 就丢掉「这条能收」的记忆、收不回去了。**折叠只是气泡里的排版**：复制/导出/分享
 * 图片一律取条目原文，收着的也照全文给出去。
 */
export function Collapsible({
  text,
  open,
  onToggle,
  disabled,
  children,
}: {
  text: string;
  open: boolean;
  onToggle: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const [tall, setTall] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = (): void => {
      if (el.scrollHeight > CLAMP_MIN_PX) setTall(true);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);
  return (
    <div className="relative">
      <div
        ref={ref}
        style={!open && tall ? { maxHeight: CLAMP_Y, overflow: 'hidden', ...CLAMP_FADE } : undefined}
      >
        {children}
      </div>
      {/* 收/展的唯一入口：贴着渐隐居中的这枚箭头（它自己不被遮罩）。正文不接点击，
          拖选复制因此永远安全。 */}
      {tall && !disabled && (
        <button
          type="button"
          aria-label={t(open ? 'tasks.convFold' : 'tasks.convUnfold')}
          onClick={onToggle}
          className={cn(
            'mx-auto flex w-7 items-center justify-center rounded-full py-0.5',
            'border border-edge/[0.08] bg-neutral-900/80 text-neutral-500 hover:text-neutral-300',
            // 收起时压在渐隐上、贴气泡底边；展开时让它自己占一行，别盖住最后一行正文
            open ? 'mt-1' : 'absolute inset-x-0 bottom-0',
          )}
        >
          {/* 收起态朝下（点开看全）、展开态朝上（收回去）。箭头不做任何动效：
              常驻的上下浮动在慢机上就是白烧的每帧合成，也不安分 */}
          <ChevronDown className={cn('h-3 w-3', open && 'rotate-180')} />
        </button>
      )}
    </div>
  );
}

/** 返回键收大图（hook 不能条件挂，包一层小组件；open 翻转时 effect 重挂）。 */
export function LightboxBackPop({ open, onClose }: { open: boolean; onClose: () => void }) {
  useBackPop(open, () => {
    onClose();
    return true;
  });
  return null;
}
