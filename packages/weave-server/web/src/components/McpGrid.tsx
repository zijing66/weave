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
  onUninstallMcp: (name: string, scope: AssetScope, agent?: AssetAgent) => void;
}) {
  const t = useT();
  const [enableMap, setEnableMap] = useState<McpEnableMap | null>(null);

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
    const prev = enableMap;
    const next = NEXT_STATE[stateOf(name)];
    setEnableMap(prev ? { ...prev, overrides: { ...prev.overrides, [name]: next } } : prev);
    api.putMcpEnable(projectId, name, next).catch(() => setEnableMap(prev));
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
          {scope === 'global' ? t('mcp.headingGlobal') : t('mcp.headingProject')}
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
          return (
            <Card key={`${s.agent ?? 'claude'}-${s.scope}-${s.name}`}>
              <CardHeader className="items-center gap-2">
                <Server className="h-3.5 w-3.5 shrink-0 text-pink-400" />
                <CardTitle className="truncate">{s.name}</CardTitle>
                <AgentBadge agent={s.agent} />
                {outdated && (
                  <Badge variant="warning" className="ml-1">
                    {t('mcp.update')}
                  </Badge>
                )}
                <div className="ml-auto flex items-center gap-1.5 shrink-0">
                  {toggleable && (
                    <button
                      onClick={() => cycleEnable(s.name)}
                      title={t('mcp.enableTip', { state: t(STATE_LABEL[state]) })}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                        state === 'enabled'
                          ? 'bg-emerald-900/40 text-emerald-300 hover:bg-emerald-900/60'
                          : 'bg-neutral-800 text-neutral-500 hover:bg-neutral-700',
                      )}
                    >
                      <Power className="h-3 w-3" />
                      {t(STATE_LABEL[state])}
                    </button>
                  )}
                  <button
                    onClick={() => onUninstallMcp(s.name, s.scope, s.agent)}
                    className="text-neutral-500 hover:text-red-400"
                    title={t('mcp.remove', { name: s.name })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
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
