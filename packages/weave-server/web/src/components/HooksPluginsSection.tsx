import { useCallback, useEffect, useState } from 'react';
import { api, type HookPlugin } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n/I18nProvider';
import { Package, RotateCw } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { errorText, useActionFeedback } from '@/lib/action-feedback';

const SCOPE_STYLES: Record<HookPlugin['scope'], string> = {
  builtin: 'bg-amber-900/40 text-amber-300',
  global: 'bg-blue-900/40 text-blue-300',
  project: 'bg-emerald-900/40 text-emerald-300',
};

/** 插件变更级联了其规则（增删/启停）→ 通知规则面板与分类计数刷新。 */
function notifyRulesChanged(): void {
  window.dispatchEvent(new Event('weave:rules-changed'));
}

/**
 * 插件区段（SPI 扫描结果）：列插件、开关（级联启停其规则）、校验错误。
 * 全局态 = 插件管理（安装/卸载 + 默认启用开关）；带 projectId = 项目态，
 * 只读列表 + effective 开关（批 4 `/hooks/plugins?projectId=`），安装/卸载隐藏。
 * 徽标近似区分跟随/覆盖：批 4 端点未暴露 syncedAt，拿全局列表与项目列表
 * 逐条比对 effective 状态——相同记「跟随全局」，不同记「已单独设置」。
 * 实时刷新挂在 App 转发的 `weave:hook` window 事件（plugin.reloaded/toggled）。
 */
export function HooksPluginsSection({ projectId }: { projectId?: number }) {
  const t = useT();
  const [plugins, setPlugins] = useState<HookPlugin[] | null>(null);
  const [globalPlugins, setGlobalPlugins] = useState<HookPlugin[] | null>(null);
  const [installSrc, setInstallSrc] = useState('');
  // 统一反馈：动作状态走 useActionFeedback，消息（含失败）走 toast——原先安装结果
  // 只在面板里一行小字，插件开关/卸载失败是**静默吞掉**的。
  const { show } = useToast();
  const fb = useActionFeedback();
  const installing = fb.stateOf('plugin-install') === 'loading';

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
    const onHook = (e: Event) => {
      const detail = (e as CustomEvent<{ kind?: string }>).detail;
      if (detail?.kind === 'plugin.reloaded' || detail?.kind === 'plugin.toggled') {
        refresh();
        notifyRulesChanged(); // 级联规则变化 → 数据流画布随规则集合更新
      }
    };
    window.addEventListener('weave:hook', onHook);
    return () => window.removeEventListener('weave:hook', onHook);
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

  const install = async (): Promise<void> => {
    const src = installSrc.trim();
    if (!src || installing) return;
    await fb.run(
      'plugin-install',
      async () => {
        const result = await api.installHookPlugin(src);
        setInstallSrc('');
        refresh();
        notifyRulesChanged(); // 新装插件的规则进画布
        show(
          'success',
          t('hooks.plugins.installOk', { id: result.installed.map((p) => p.id).join(', ') }),
        );
      },
      { fail: (e) => t('hooks.plugins.installFail', { error: errorText(e) }) },
    );
  };

  const uninstall = async (p: HookPlugin): Promise<void> => {
    if (!window.confirm(t('hooks.plugins.uninstallConfirm', { id: p.id }))) return;
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
        return (
          <div
            key={p.id}
            className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.015] px-2 py-1.5"
          >
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
                  onClick={() => void uninstall(p)}
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
        );
      })}

      {/* 安装：粘贴本地目录或 git URL（仅全局态） */}
      {projectId === undefined && (
        <>
          <div className="flex items-center gap-1.5">
            <input
              value={installSrc}
              onChange={(e) => setInstallSrc(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void install();
              }}
              placeholder={t('hooks.plugins.installPlaceholder')}
              className="min-w-0 flex-1 rounded-md border border-white/[0.08] bg-neutral-950/60 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-blue-500/50 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void install()}
              disabled={installing || !installSrc.trim()}
              className="shrink-0 rounded-md bg-blue-600/80 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-40"
            >
              {installing ? t('hooks.plugins.installing') : t('hooks.plugins.install')}
            </button>
          </div>
        </>
      )}
      <p className="flex items-center gap-1 text-[10px] text-neutral-600">
        <RotateCw className="h-3 w-3" />
        {t('hooks.plugins.hotReload')}
      </p>
    </div>
  );
}
