import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorText, type ActionFeedback } from '@/lib/action-feedback';
import type { ModelAliasTarget } from '@weavecode/harness';
import { effortLevelsFor, modeNamesFor, modeTintFor, modelNamesFor } from './lifecycle';
import type { TFunc } from '@/i18n/t';

/** 上下文占用读数（「上一轮完成时」）：humanize 到 k/M；没跑过一轮 = 不摆。 */
function humanizeTokens(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(n));
}

/** 上下文窗口大小（tokens）：模型真名带 `[1M]` 标注 = 1M 档，否则 200k 档。 */
export function contextWindowOf(model: string | null | undefined): number {
  return /\[1m\]/i.test(model ?? '') ? 1_000_000 : 200_000;
}

/** 「切换中」最多挂这么久：宿主下一拍事件就回报新模式，一直没事件（会话闲着）就
 *  回落「最后已知」——一个永久的「切换中」比旧值更像卡死。 */
const MODE_PENDING_MS = 60_000;

/** 会话行（状态总线）：控制面只读它的最后已知。 */
interface SessionRowLike {
  mode?: string | null;
  model?: string | null;
  modelAlias?: string | null;
  effort?: string | null;
  contextTokens?: number | null;
  title?: string | null;
}

/**
 * 会话控制面（执行模式 / 模型 / 思考强度）：三者都只在转录里照会，显示恒为
 * 「最后已知」；切换不留 hook 痕迹（Shift+Tab 一个事件都不发、/model 不落盘），
 * 故「切换中」只是本地乐观标记，宿主下一拍事件回报新模式即收。
 */
export function useSessionControls(deps: {
  sessionId: string;
  harness: string;
  /** 状态总线里本会话的行（最后已知的事实源）。 */
  sessionRow: SessionRowLike | undefined;
  /** 模型目录（别名 → 真名；老 daemon 不回 = 只摆词表）。 */
  modelCatalog: Record<string, ModelAliasTarget[]>;
  fb: ActionFeedback;
  t: TFunc;
  show: (kind: 'success' | 'error', msg: string) => void;
  refresh: () => Promise<unknown> | unknown;
}) {
  const { sessionId, harness, sessionRow, modelCatalog, fb, t, show, refresh } = deps;
const modeNames = modeNamesFor(harness);
const modelNames = modelNamesFor(harness);
const effortLevels = effortLevelsFor(harness);
const modelTargets = modelCatalog[harness] ?? [];
const currentMode = sessionRow?.mode ?? null;
const currentModel = sessionRow?.model ?? null;
/** 上下文占用读数（「上一轮完成时」）：humanize 到 k/M；没跑过一轮 = 不摆。 */
const contextLabel = humanizeTokens(sessionRow?.contextTokens ?? null);
/** 刚打出 Shift+Tab、新模式还没被任何事件回报：记下切换前的值，变了即收。 */
const [modePending, setModePending] = useState<string | null>(null);
const modeTint = modePending !== null ? null : modeTintFor(harness, currentMode);
useEffect(() => {
  if (modePending === null) return;
  if (currentMode !== modePending) {
    setModePending(null);
    return;
  }
  const timer = window.setTimeout(() => setModePending(null), MODE_PENDING_MS);
  return () => window.clearTimeout(timer);
}, [modePending, currentMode]);

const cycleMode = (): void => {
  const before = currentMode ?? '';
  void fb.run(
    `cycleMode:${sessionId}`,
    async () => {
      await api.cycleSessionMode(sessionId);
      // 新值是宿主自己算的（它的循环列表还会被 settings 过滤），猜不得——只标「切换中」，
      // 等下一次事件自带的 permission_mode 回报。
      setModePending(before);
      await refresh();
      show('success', t('tasks.modeCycled'));
    },
    { fail: (e) => t('tasks.modeCycleFailed', { error: errorText(e) }) },
  );
};

const applyModel = (name: string): void => {
  void fb.run(
    `setModel:${sessionId}`,
    async () => {
      await api.setSessionModel(sessionId, name);
      await refresh();
      show('success', t('tasks.modelSet'));
    },
    { fail: (e) => t('tasks.modelSetFailed', { error: errorText(e) }) },
  );
};

/** 思考强度：打 `/effort <档位>`，下一轮事件的 `effort.level` 回报自动跟上。 */
const applyEffort = (level: string): void => {
  void fb.run(
    `setEffort:${sessionId}`,
    async () => {
      await api.setSessionEffort(sessionId, level);
      await refresh();
      show('success', t('tasks.effortSet', { level }));
    },
    { fail: (e) => t('tasks.effortSetFailed', { error: errorText(e) }) },
  );
};

/** 下拉选项：**真名是主文案、别名降为灰字说明**——别名（opus/sonnet…）只是
 *  分类标签，真正跑的是网关那串 ID，和宿主自己 statusline 报的同一个。选中值仍是
 *  别名（`/model` 的稳定把手，宿主认它）。老 daemon 不回别名表就只摆词表。
 */
const modelOptions =
  modelTargets.length > 0
    ? modelTargets.map((t) => ({
        value: t.alias,
        label: t.actual,
        ...(t.actual === t.alias ? {} : { hint: t.alias }),
      }))
    : modelNames.map((n) => ({ value: n, label: n }));
/** 选中值取**别名**：转录里照会的是网关真名（`ftm`），那是别名 opus 的真身。 */
const modelValue = sessionRow?.modelAlias ?? currentModel ?? '';
/** 展示用真名（状态栏底条）：别名那档的真名与宿主 `display_name` 同形态
 *  （`<网关模型ID>[1M]`）；认不出别名就退回转录照会的真名——**别名不上展板**。 */
const modelDisplay =
  modelTargets.find((t) => t.alias === modelValue)?.actual ?? currentModel ?? (modelValue || null);

  /** 上下文窗口大小（tokens）：模型真名带 `[1M]` 标注 = 1M 档，否则 200k 档——
   *  与 harness 侧 `bareModelName` 剥的是同一个约定（claude 只有这两档窗口）。
   *  宿主 statusline 的 `total` 只活在渲染脚本 stdin 里，weave 拿不到，只能推。 */
  const contextWindowTokens = contextWindowOf(modelDisplay);
  /** 上一轮完成时的占用百分比（进度条与底条 context 块共用）；没读过一轮 = null。 */
  const contextPercent =
    sessionRow?.contextTokens != null && Number.isFinite(sessionRow.contextTokens)
      ? Math.min(100, Math.round((sessionRow.contextTokens / contextWindowTokens) * 100))
      : null;

  return {
    sessionRow, modeNames, modelNames, effortLevels, modelTargets,
    currentMode, currentModel, contextLabel, contextPercent, modePending, modeTint,
    cycleMode, applyModel, applyEffort, modelOptions, modelValue, modelDisplay,
  };
}
