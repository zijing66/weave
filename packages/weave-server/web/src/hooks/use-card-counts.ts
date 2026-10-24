import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type HookRule,
  type OrchestrationRow,
} from '@/lib/api';

/**
 * 分类卡计数域：hook 规则集（Weave 卡）与编排定义（编排卡）。面板自己改完会
 * 重拉自己的那份；这里的副本只喂卡片角标——变更经 window 事件（weave:rules-changed /
 * weave:orchestrations-changed）回报，卡片计数不经过 CategoryDetail 的 props 链。
 */
export function useCardCounts() {
  // All hook rules (global + per project) — drives the Weave card count; the
  // panel refetches its own copy after every mutation.
  const [hookRules, setHookRules] = useState<HookRule[]>([]);
  // 全部编排定义（不分项目）——编排卡计数按当前视图过滤；画布改了定义会
  // 发 `weave:orchestrations-changed` 让这里重拉。
  const [orchestrations, setOrchestrations] = useState<OrchestrationRow[]>([]);

  /** Refresh the hooks rule set (card count). */
  const refreshHookRules = useCallback(() => {
    api.listHooksRules().then(setHookRules).catch(() => {});
  }, []);

  useEffect(() => {
    refreshHookRules();
  }, [refreshHookRules]);

  /** Refresh the orchestration definitions (编排 card count). */
  const refreshOrchestrations = useCallback(() => {
    api.listOrchestrations().then(setOrchestrations).catch(() => {});
  }, []);

  useEffect(() => {
    refreshOrchestrations();
  }, [refreshOrchestrations]);

  // 编排画布用这个事件回报定义的新增/改名/删除（同 weave:rules-changed）。
  useEffect(() => {
    window.addEventListener('weave:orchestrations-changed', refreshOrchestrations);
    return () =>
      window.removeEventListener('weave:orchestrations-changed', refreshOrchestrations);
  }, [refreshOrchestrations]);

  // HooksPanel announces rule mutations with this event so the category card
  // count stays honest without threading callbacks through CategoryDetail.
  useEffect(() => {
    window.addEventListener('weave:rules-changed', refreshHookRules);
    return () => window.removeEventListener('weave:rules-changed', refreshHookRules);
  }, [refreshHookRules]);

  return { hookRules, refreshHookRules, orchestrations, refreshOrchestrations };
}
