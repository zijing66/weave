import type { ComponentType } from 'react';
import { Asterisk, Loader2 } from 'lucide-react';
import type { Harness } from '@weavecode/core/harness';

/**
 * Codex 标记：OpenAI 官方结花印（Simple Icons 的 openai path，CC0），
 * fill=currentColor 跟随运行/静默两态配色。
 */
function CodexMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

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
  /** 会话状态图标（lucide 图标，或本文件内的 harness 专属 SVG 标记）。 */
  icon: ComponentType<{ className?: string }>;
  /** 图标运行态色。 */
  iconRunning: string;
  /** 图标静默态色。 */
  iconIdle: string;
  /** 运行态跑马灯动效类（index.css）。 */
  runAnimation: string;
  /** 运行态呼吸动效类（index.css，叠加在图标本体上——外层转、里层缩）。 */
  breatheAnimation: string;
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
    breatheAnimation: 'harness-breathe',
    dotDir: '.claude',
  },
  codex: {
    label: 'Codex',
    tooltip: 'Codex',
    badge: 'border-cyan-800/50 bg-cyan-900/40 text-cyan-300',
    source: 'bg-cyan-900/40 text-cyan-300',
    icon: CodexMark,
    iconRunning: 'text-cyan-400',
    iconIdle: 'text-cyan-400/45',
    runAnimation: 'harness-run-codex',
    breatheAnimation: 'harness-breathe',
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
  breatheAnimation: '',
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
