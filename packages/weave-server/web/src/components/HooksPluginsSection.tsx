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
  const [installSrc, setInstallSrc] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState<string | null>(null);

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

  const install = async (): Promise<void> => {
    const src = installSrc.trim();
    if (!src || installing) return;
    setInstalling(true);
    setInstallMsg(null);
    try {
      const result = await api.installHookPlugin(src);
      setInstallMsg(t('hooks.plugins.installOk', { id: result.installed.map((p) => p.id).join(', ') }));
      setInstallSrc('');
      refresh();
    } catch (e) {
      setInstallMsg(t('hooks.plugins.installFail', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setInstalling(false);
    }
  };

  const uninstall = async (p: HookPlugin): Promise<void> => {
    if (!window.confirm(t('hooks.plugins.uninstallConfirm', { id: p.id }))) return;
    try {
      await api.uninstallHookPlugin(p.id);
      refresh();
    } catch {
      // 失败保持原状
    }
  };

  if (plugins === null) return null;

  return (
    <div className="space-y-2">
      {plugins.length === 0 && (
        <p className="text-xs text-neutral-600">{t('hooks.plugins.empty')}</p>
      )}
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
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => void uninstall(p)}
              title={t('hooks.plugins.uninstallTip')}
              className="rounded px-1 text-[11px] text-neutral-600 hover:text-red-400"
            >
              ✕
            </button>
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

      {/* 安装：粘贴本地目录或 git URL */}
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
      {installMsg && <p className="text-[11px] text-neutral-500">{installMsg}</p>}
      <p className="flex items-center gap-1 text-[10px] text-neutral-600">
        <RotateCw className="h-3 w-3" />
        {t('hooks.plugins.hotReload')}
      </p>
    </div>
  );
}
