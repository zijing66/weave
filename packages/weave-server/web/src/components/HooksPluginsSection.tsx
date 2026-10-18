import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type HookPlugin } from '@/lib/api';
import { subscribeHook } from '@/lib/sse';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n/I18nProvider';
import { ChevronDown, ChevronRight, Package, RotateCw } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import { toggleIn } from '@/lib/repo-groups';
import { ConfirmDialog } from '@/components/ConfirmDialog';

const SCOPE_STYLES: Record<HookPlugin['scope'], string> = {
  builtin: 'bg-amber-900/40 text-amber-300',
  user: 'bg-blue-900/40 text-blue-300',
  project: 'bg-emerald-900/40 text-emerald-300',
};

/** 插件变更级联了其规则（增删/启停）→ 通知规则面板与分类计数刷新。 */
function notifyRulesChanged(): void {
  window.dispatchEvent(new Event('weave:rules-changed'));
}

/**
 * 插件区段（SPI 扫描结果）：列插件、开关（级联启停其规则）、校验错误。
 * 全局态 = 插件管理（卸载 + 默认启用开关）；带 projectId = 项目态，
 * 只读列表 + effective 开关（批 4 `/hooks/plugins?projectId=`），卸载隐藏。
 * 徽标近似区分跟随/覆盖：批 4 端点未暴露 syncedAt，拿全局列表与项目列表
 * 逐条比对 effective 状态——相同记「跟随全局」，不同记「已单独设置」。
 * 实时刷新挂在 SSE 总线的 hook 订阅（plugin.reloaded/toggled）。
 *
 * 批 6：安装入口只留「内置仓 + 资源市场」两条（粘贴本地目录/git URL 的输入框
 * 撤掉，后端 `POST /hooks/plugins` 保留）；`renderRules` 是**每个插件块内的
 * 规则列表插槽**——插件与其规则本是一件事，分两块展示等于同一份数据读两遍
 * （规则 JSX 与增删改交互留在 HooksPanel，它已持有表单与编辑态）。
 */
export function HooksPluginsSection({
  projectId,
  renderRules,
}: {
  projectId?: number;
  /** 插件块内的规则列表（`rule.pluginId === plugin.id` 的那些）。 */
  renderRules?: (plugin: HookPlugin) => ReactNode;
}) {
  const t = useT();
  const [plugins, setPlugins] = useState<HookPlugin[] | null>(null);
  const [globalPlugins, setGlobalPlugins] = useState<HookPlugin[] | null>(null);
  // 折叠集记「折叠起来的」：默认展开——规则就在这个块里，藏起来等于没合并。
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // 待确认卸载的插件：✕ 按钮设入，应用内 ConfirmDialog 确认后执行
  const [uninstallTarget, setUninstallTarget] = useState<HookPlugin | null>(null);
  // 统一反馈：动作状态走 useActionFeedback，消息（含失败）走 toast——插件开关/
  // 卸载失败原先在面板里被静默吞掉。
  const { show } = useToast();
  const fb = useActionFeedback();

  const refresh = useCallback(() => {
    Promise.all([
      api.listHookPlugins(projectId),
      projectId === undefined ? Promise.resolve(null) : api.listHookPlugins(),
    ])
      .then(([list, globalList]) => {
        setPlugins(list);
        setGlobalPlugins(globalList);
      })
      .catch(() => setPlugins((prev) => prev ?? []));
  }, [projectId]);

  useEffect(() => {
    refresh();
    const off = subscribeHook(
      () => {
        refresh();
        notifyRulesChanged(); // 级联规则变化 → 数据流画布随规则集合更新
      },
      ['plugin.reloaded', 'plugin.toggled'],
    );
    return off;
  }, [refresh]);

  const toggle = (p: HookPlugin, enabled: boolean): void => {
    void fb.run(
      `toggle:${p.id}`,
      async () => {
        await api.toggleHookPlugin(p.id, enabled, projectId);
        refresh();
        notifyRulesChanged(); // 插件级联启停其规则
      },
      { fail: (e) => t('hooks.plugins.toggleFail', { error: errorText(e) }) },
    );
  };

  const uninstall = async (p: HookPlugin): Promise<void> => {
    await fb.run(
      `uninstall:${p.id}`,
      async () => {
        await api.uninstallHookPlugin(p.id);
        refresh();
        notifyRulesChanged(); // 卸载插件的规则出画布
        show('success', t('hooks.plugins.uninstallOk', { id: p.id }));
      },
      { fail: (e) => t('hooks.plugins.uninstallFail', { error: errorText(e) }) },
    );
  };

  // 手动重新扫描：热重载只覆盖「启动时已存在的根」，运行期才建起来的根要这一下
  const rescan = (): void => {
    void fb.run(
      'rescan',
      async () => {
        const count = await api.rescanHookPlugins();
        refresh();
        notifyRulesChanged();
        show('success', t('hooks.plugins.rescanOk', { n: count }));
      },
      { fail: (e) => t('hooks.plugins.rescanFail', { error: errorText(e) }) },
    );
  };

  if (plugins === null) return null;

  const globalStatusById = new Map((globalPlugins ?? []).map((p) => [p.id, p.status]));

  return (
    <div className="space-y-2">
      {plugins.length === 0 && (
        <p className="text-xs text-neutral-600">{t('hooks.plugins.empty')}</p>
      )}
      {plugins.map((p) => {
        const globalStatus = globalStatusById.get(p.id);
        const override = projectId !== undefined && globalStatus !== undefined && globalStatus !== p.status;
        const collapsedHere = collapsed.has(p.id);
        // 有规则槽且该插件确实带规则时才给折叠头——空展开只是噪音。
        const expandable = !!renderRules && p.ruleCount > 0;
        return (
          <div
            key={p.id}
            className="rounded-md border border-edge/[0.06] bg-edge/[0.015] overflow-hidden"
          >
            <div className="flex items-center gap-2 px-2 py-1.5">
              {expandable && (
                <button
                  type="button"
                  onClick={() => setCollapsed((prev) => toggleIn(prev, p.id))}
                  title={collapsedHere ? t('hooks.plugins.expand') : t('hooks.plugins.collapse')}
                  className="shrink-0 text-neutral-500 hover:text-neutral-300 [&_svg]:pointer-events-none"
                >
                  {collapsedHere ? (
                    <ChevronRight className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
              <Package
                className={cn(
                  'h-3.5 w-3.5 shrink-0',
                  p.status === 'active'
                    ? 'text-emerald-400'
                    : p.status === 'disabled'
                      ? 'text-neutral-600'
                      : 'text-red-400',
                )}
              />
              <span className="shrink-0 text-xs font-medium text-neutral-200">{p.name}</span>
              <span className="shrink-0 font-mono text-[10px] text-neutral-500">{p.id}</span>
              <Badge className={cn('shrink-0', SCOPE_STYLES[p.scope])}>{p.scope}</Badge>
              <span className="shrink-0 text-[10px] text-neutral-600">v{p.version}</span>
              <span className="shrink-0 text-[11px] text-neutral-500">
                {t('hooks.plugins.rules', { n: p.ruleCount })}
              </span>
              {p.status === 'rejected' && p.error && (
                <span className="min-w-0 truncate text-[11px] text-red-400/90" title={p.error}>
                  {p.error}
                </span>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                {projectId !== undefined && p.status !== 'rejected' && globalStatus !== undefined && (
                  <Badge
                    variant={override ? 'warning' : 'default'}
                    title={t('hooks.plugins.projectHint')}
                  >
                    {override ? t('hooks.plugins.projectOverride') : t('hooks.plugins.followGlobal')}
                  </Badge>
                )}
                {projectId === undefined && (
                  <button
                    type="button"
                    onClick={() => setUninstallTarget(p)}
                    title={t('hooks.plugins.uninstallTip')}
                    className="rounded px-1 text-[11px] text-neutral-600 hover:text-red-400 [&_svg]:pointer-events-none"
                  >
                    <FeedbackIcon
                      state={fb.stateOf(`uninstall:${p.id}`)}
                      className="h-3 w-3"
                      icon={<span className="text-[11px]">✕</span>}
                    />
                  </button>
                )}
                <Switch
                  checked={p.status !== 'disabled'}
                  onChange={(v) => void toggle(p, v)}
                  title={
                    p.status === 'rejected'
                      ? t('hooks.plugins.rejectedTip')
                      : t('hooks.plugins.toggleTip')
                  }
                />
              </span>
            </div>
            {expandable && !collapsedHere && (
              <div className="px-2 pb-2 pl-7">{renderRules!(p)}</div>
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="flex items-center gap-1 text-[10px] text-neutral-600">
          <RotateCw className="h-3 w-3" />
          {t('hooks.plugins.hotReload')}
        </p>
        {/* 手动纳管运行期新建的根：启动时不存在的根挂不上 watcher（不热重载） */}
        <button
          type="button"
          onClick={rescan}
          title={t('hooks.plugins.rescanTip')}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-edge/[0.06] hover:text-neutral-200"
        >
          <FeedbackIcon state={fb.stateOf('rescan')} className="h-3 w-3" icon={<RotateCw className="h-3 w-3" />} />
          {t('hooks.plugins.rescan')}
        </button>
      </div>

      {/* 卸载确认弹窗：替代原生 window.confirm */}
      <ConfirmDialog
        open={uninstallTarget !== null}
        title={t('hooks.plugins.uninstallTitle')}
        message={uninstallTarget ? t('hooks.plugins.uninstallConfirm', { id: uninstallTarget.id }) : ''}
        confirmLabel={t('common.confirm')}
        onConfirm={() => {
          if (uninstallTarget) void uninstall(uninstallTarget);
        }}
        onClose={() => setUninstallTarget(null)}
      />
    </div>
  );
}
