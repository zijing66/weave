import { useEffect, useState } from 'react';
import {
  api,
  type AssetAgent,
  type AssetScope,
  type McpEnableMap,
  type McpEnableState,
  type McpServerConfig,
  type McpUpdate,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AgentBadge } from '@/components/AgentBadge';
import { Power, Server, Trash2 } from 'lucide-react';
import { useT } from '@/i18n/I18nProvider';
import { useToast } from '@/components/Toast';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { errorText, useActionFeedback } from '@/lib/action-feedback';

export interface McpRow {
  name: string;
  config: McpServerConfig;
  scope: AssetScope;
  /** 'codex' rows target ~/.codex/config.toml (user-level). */
  agent?: AssetAgent;
}

/** Tri-state cycle for the project enable override (absent entry = 跟随默认). */
const NEXT_STATE: Record<McpEnableState, McpEnableState> = {
  default: 'enabled',
  enabled: 'disabled',
  disabled: 'default',
};

const STATE_LABEL: Record<McpEnableState, 'mcp.enableDefault' | 'mcp.enableOn' | 'mcp.enableOff'> = {
  default: 'mcp.enableDefault',
  enabled: 'mcp.enableOn',
  disabled: 'mcp.enableOff',
};

export function McpGrid({
  projectId,
  servers,
  scope,
  updates,
  empty,
  onUninstallMcp,
}: {
  /** Anchor project for the enable overrides (project scope only). */
  projectId: number;
  servers: McpRow[];
  /** Which view this grid is rendered in — prefixes the section heading the
   * same way the skills sections do (项目 X / 全局 X). */
  scope: AssetScope;
  /** Update info already filtered to this mode's scope. */
  updates?: McpUpdate[];
  empty: string;
  onUninstallMcp: (name: string, scope: AssetScope, agent?: AssetAgent) => void | Promise<void>;
}) {
  const t = useT();
  const [enableMap, setEnableMap] = useState<McpEnableMap | null>(null);
  // 按钮本体自持三态反馈：卸载 loading 转圈 + 成功/失败 toast；cycleEnable 失败
  // 回滚乐观覆盖并报错（原先 .catch 静默吞掉）。
  const { show } = useToast();
  const fb = useActionFeedback();

  // Enable overrides live in the project's .claude/settings.json, so only the
  // project view reads them (global / Codex rows have no such semantics).
  useEffect(() => {
    if (scope !== 'project') {
      setEnableMap(null);
      return;
    }
    let alive = true;
    api
      .getMcpEnable(projectId)
      .then((m) => {
        if (alive) setEnableMap(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [projectId, scope]);

  const stateOf = (name: string): McpEnableState => enableMap?.overrides[name] ?? 'default';

  const cycleEnable = (name: string): void => {
    const key = `mcp-enable:${name}`;
    if (fb.stateOf(key) === 'loading') return;
    const prev = enableMap;
    const next = NEXT_STATE[stateOf(name)];
    setEnableMap(prev ? { ...prev, overrides: { ...prev.overrides, [name]: next } } : prev);
    void fb.run(
      key,
      async () => {
        try {
          await api.putMcpEnable(projectId, name, next);
        } catch (e) {
          setEnableMap(prev); // 失败回滚乐观覆盖，再抛给 fb.run 报 toast
          throw e;
        }
      },
      { fail: (e) => t('mcp.enableFailed', { error: errorText(e) }) },
    );
  };

  if (servers.length === 0) {
    return (
      <p className="text-xs text-neutral-600 border border-dashed border-white/[0.06] rounded-md p-3">
        {empty}
      </p>
    );
  }

  const isOutdated = (name: string, agent?: AssetAgent) =>
    !!updates?.find(
      (u) => u.name === name && u.outdated && (u.agent ?? 'claude') === (agent ?? 'claude'),
    );

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-semibold text-neutral-400 uppercase">
          {scope === 'user' ? t('mcp.headingGlobal') : t('mcp.headingProject')}
        </h2>
        <span className="ml-auto rounded-full bg-neutral-800/60 text-neutral-400 px-2 py-0.5 text-[11px] font-medium tabular-nums">
          {servers.length}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 items-start">
        {servers.map((s) => {
          const outdated = isOutdated(s.name, s.agent);
          const toggleable = s.scope === 'project' && (s.agent ?? 'claude') !== 'codex';
          const state = stateOf(s.name);
          const enableKey = `mcp-enable:${s.name}`;
          const enableState = fb.stateOf(enableKey);
          const uninstallKey = `mcp-uninstall:${s.agent ?? 'claude'}:${s.scope}:${s.name}`;
          const uninstallState = fb.stateOf(uninstallKey);
          return (
            <Card key={`${s.agent ?? 'claude'}-${s.scope}-${s.name}`}>
              <CardHeader className="items-center gap-2">
                <Server className="h-3.5 w-3.5 shrink-0 text-pink-400" />
                <CardTitle className="truncate">{s.name}</CardTitle>
                <AgentBadge agent={s.agent} />
                {/* Codex rows always live in the user-level config.toml, so
                    they read 全局 even when rendered inside the project view. */}
                <Badge variant="settings" className="ml-1">
                  {t(
                    s.agent === 'codex' || s.scope === 'user'
                      ? 'library.scopeGlobal'
                      : 'library.scopeProject',
                  )}
                </Badge>
                {outdated && (
                  <Badge variant="warning" className="ml-1">
                    {t('mcp.update')}
                  </Badge>
                )}
                <div className="ml-auto flex items-center gap-1.5 shrink-0">
                  {toggleable && (
                    <button
                      type="button"
                      disabled={enableState === 'loading'}
                      onClick={() => cycleEnable(s.name)}
                      title={t('mcp.enableTip', { state: t(STATE_LABEL[state]) })}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium disabled:cursor-not-allowed [&_svg]:pointer-events-none',
                        state === 'enabled'
                          ? 'bg-emerald-900/40 text-emerald-300 hover:bg-emerald-900/60'
                          : 'bg-neutral-800 text-neutral-500 hover:bg-neutral-700',
                      )}
                    >
                      <FeedbackIcon
                        state={enableState}
                        className="h-3 w-3"
                        icon={<Power className="h-3 w-3" />}
                      />
                      {t(STATE_LABEL[state])}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={uninstallState === 'loading'}
                    onClick={() =>
                      void fb.run(
                        uninstallKey,
                        async () => {
                          await onUninstallMcp(s.name, s.scope, s.agent);
                          show('success', t('mcp.uninstalled', { name: s.name }));
                        },
                        { fail: (e) => t('errors.mcpUninstallFailed', { error: errorText(e) }) },
                      )
                    }
                    className="text-neutral-500 hover:text-red-400 disabled:cursor-not-allowed [&_svg]:pointer-events-none"
                    title={t('mcp.remove', { name: s.name })}
                  >
                    <FeedbackIcon
                      state={uninstallState}
                      className="h-3.5 w-3.5"
                      icon={<Trash2 className="h-3.5 w-3.5" />}
                    />
                  </button>
                </div>
              </CardHeader>
              <CardContent className="pt-0 text-xs font-mono text-neutral-400 break-all">
                <span className="text-neutral-300">{s.config.command}</span>
                {s.config.args && s.config.args.length > 0 && (
                  <span className="text-neutral-500"> {s.config.args.join(' ')}</span>
                )}
                {s.config.env && Object.keys(s.config.env).length > 0 && (
                  <div className="mt-1 text-neutral-600">
                    env: {Object.keys(s.config.env).join(', ')}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
