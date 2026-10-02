import { useCallback, useEffect, useState } from 'react';
import { api, type HookPlugin } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n/I18nProvider';
import { Package, RotateCw } from 'lucide-react';

const SCOPE_STYLES: Record<HookPlugin['scope'], string> = {
  builtin: 'bg-amber-900/40 text-amber-300',
  global: 'bg-blue-900/40 text-blue-300',
  project: 'bg-emerald-900/40 text-emerald-300',
};

/**
 * 插件区段（SPI 扫描结果）：列插件、开关（级联启停其规则）、校验错误。
 * 实时刷新挂在 App 转发的 `weave:hook` window 事件（plugin.reloaded/toggled）。
 */
export function HooksPluginsSection() {
  const t = useT();
  const [plugins, setPlugins] = useState<HookPlugin[] | null>(null);

  const refresh = useCallback(() => {
    api
      .listHookPlugins()
      .then(setPlugins)
      .catch(() => setPlugins((prev) => prev ?? []));
  }, []);

  useEffect(() => {
    refresh();
    const onHook = (e: Event) => {
      const detail = (e as CustomEvent<{ kind?: string }>).detail;
      if (detail?.kind === 'plugin.reloaded' || detail?.kind === 'plugin.toggled') refresh();
    };
    window.addEventListener('weave:hook', onHook);
    return () => window.removeEventListener('weave:hook', onHook);
  }, [refresh]);

  const toggle = async (p: HookPlugin, enabled: boolean): Promise<void> => {
    try {
      await api.toggleHookPlugin(p.id, enabled);
      refresh();
    } catch {
      // 网络失败保持原状，下次帧/手动刷新校准
    }
  };

  if (plugins === null) return null;
  if (plugins.length === 0) {
    return <p className="text-xs text-neutral-600">{t('hooks.plugins.empty')}</p>;
  }

  return (
    <div className="space-y-1">
      {plugins.map((p) => (
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
          <span className="ml-auto shrink-0">
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
      ))}
      <p className="flex items-center gap-1 pt-0.5 text-[10px] text-neutral-600">
        <RotateCw className="h-3 w-3" />
        {t('hooks.plugins.hotReload')}
      </p>
    </div>
  );
}
