import { Asterisk, Hexagon, Loader2, type LucideIcon } from 'lucide-react';
import type { Harness } from '@weavecode/core/harness';

/**
 * harness 的展示元数据单点表（样式 / 图标 / 显示名）。web 侧的「harness 知识」
 * 只许落在这里，其余组件一律经 `harnessUiOf()` 查表——新增 harness 只需本表加一行
 * （`satisfies Record<Harness, …>` 漏加即编译失败），页签与初始 state 由
 * `HARNESS_ORDER` 自动跟随，组件不再写 `agent === 'codex'` 一类二分。
 *
 * web 运行时不能 import core 值（import type 纪律，见 tasks/lifecycle.ts 注释），
 * 故名表在此镜像而非 re-export core 的 HARNESS_NAMES。
 */
export interface HarnessUi {
  /** 显示名（页签 / 安装目标 / 抽屉，首字母大写）。 */
  label: string;
  /** 工具提示用的全名（页签 title）。 */
  tooltip: string;
  /** AgentBadge 描边色板（border + bg + text）。 */
  badge: string;
  /** 来源徽标配色（日志/事件链，`hook-payload.SOURCE_STYLES`）。 */
  source: string;
  /** 会话状态图标。 */
  icon: LucideIcon;
  /** 图标运行态色。 */
  iconRunning: string;
  /** 图标静默态色。 */
  iconIdle: string;
  /** 运行态跑马灯动效类（index.css）。 */
  runAnimation: string;
  /** 落盘目录名（core HARNESS_DIRS 的 web 镜像）：'.claude' / '.codex'。 */
  dotDir: string;
}

export const HARNESS_UI = {
  claude: {
    label: 'Claude',
    tooltip: 'Claude Code',
    badge: 'border-orange-800/50 bg-orange-900/40 text-orange-300',
    source: 'bg-orange-900/40 text-orange-300',
    icon: Asterisk,
    iconRunning: 'text-orange-400',
    iconIdle: 'text-orange-400/45',
    runAnimation: 'harness-run-claude',
    dotDir: '.claude',
  },
  codex: {
    label: 'Codex',
    tooltip: 'Codex',
    badge: 'border-cyan-800/50 bg-cyan-900/40 text-cyan-300',
    source: 'bg-cyan-900/40 text-cyan-300',
    icon: Hexagon,
    iconRunning: 'text-cyan-400',
    iconIdle: 'text-cyan-400/45',
    runAnimation: 'harness-run-codex',
    dotDir: '.codex',
  },
} satisfies Record<Harness, HarnessUi>;

/** 未知 / 新 harness 的通用降级（中性色、通用 spinner、显示名回落 harness id）。 */
export const HARNESS_UI_FALLBACK: HarnessUi = {
  label: '',
  tooltip: '',
  badge: 'border-neutral-700/50 bg-neutral-800/40 text-neutral-300',
  source: 'bg-neutral-800 text-neutral-400',
  icon: Loader2,
  iconRunning: 'text-neutral-300',
  iconIdle: 'text-neutral-500',
  runAnimation: '',
  dotDir: '',
};

/** 运行时名表（顺序 = 本表键序）：页签数组、初始 state 都由此派生。 */
export const HARNESS_ORDER: readonly Harness[] = Object.keys(HARNESS_UI) as Harness[];

/**
 * harness → 展示元数据。未知 / 新 harness 或 null/undefined 一律回落通用降级值，
 * 显示名用 harness id 原文——UI 不猜、不崩。
 */
export function harnessUiOf(harness: Harness | null | undefined): HarnessUi {
  if (harness && harness in HARNESS_UI) return HARNESS_UI[harness];
  return {
    ...HARNESS_UI_FALLBACK,
    label: harness ?? HARNESS_UI_FALLBACK.label,
    tooltip: harness ?? HARNESS_UI_FALLBACK.tooltip,
  };
}
