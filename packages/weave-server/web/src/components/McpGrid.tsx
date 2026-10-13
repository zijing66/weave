import type { EnableOverride } from '@weavecode/core/tool';
import {
  type AssetAgent,
  type AssetScope,
  type McpRow,
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

/** 三态循环 inherit → on → off → inherit；override 由服务端行随身带。 */
const NEXT_STATE: Record<EnableOverride, EnableOverride> = {
  inherit: 'on',
  on: 'off',
  off: 'inherit',
};

const STATE_LABEL: Record<EnableOverride, 'mcp.enableDefault' | 'mcp.enableOn' | 'mcp.enableOff'> = {
  inherit: 'mcp.enableDefault',
  on: 'mcp.enableOn',
  off: 'mcp.enableOff',
};

/** 能力面 mcpScopes 只有 project/user 两档，行 scope 即卡面。 */
const cardScope = (r: McpRow): AssetScope => (r.scope === 'user' ? 'user' : 'project');

export function McpGrid({
  rows,
  scope,
  updates,
  empty,
  onUninstallMcp,
  onCycleMcpEnable,
}: {
  rows: McpRow[];
  /** Which view this grid is rendered in — prefixes the section heading the
   * same way the skills sections do (项目 X / 全局 X). */
  scope: AssetScope;
  /** Update info already filtered to this mode's scope. */
  updates?: McpUpdate[];
  empty: string;
  onUninstallMcp: (name: string, scope: AssetScope, agent?: AssetAgent) => void | Promise<void>;
  /** 开关切换只交语义（名字 + 下一态），落盘与刷新由 App 统一负责。 */
  onCycleMcpEnable: (name: string, next: EnableOverride) => void | Promise<void>;
}) {
  const t = useT();
  // 按钮本体自持三态反馈：卸载/开关 loading 转圈 + 失败 toast。
  const { show } = useToast();
  const fb = useActionFeedback();

  const cycleEnable = (row: McpRow): void => {
    const key = `mcp-enable:${row.key}`;
    if (fb.stateOf(key) === 'loading') return;
    void fb.run(key, async () => onCycleMcpEnable(row.key, NEXT_STATE[row.enable ?? 'inherit']), {
      fail: (e) => t('mcp.enableFailed', { error: errorText(e) }),
    });
  };

  if (rows.length === 0) {
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
          {rows.length}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 items-start">
        {rows.map((s) => {
          const outdated = isOutdated(s.key, s.harness);
          // enable 为 null 的面没有启停语义（user/codex 面），不渲染开关。
          const toggleable = s.enable !== null;
          const state = s.enable ?? 'inherit';
          const enableKey = `mcp-enable:${s.key}`;
          const enableState = fb.stateOf(enableKey);
          const uninstallKey = `mcp-uninstall:${s.harness}:${s.scope}:${s.key}`;
          const uninstallState = fb.stateOf(uninstallKey);
          return (
            <Card key={`${s.harness}-${s.scope}-${s.key}`}>
              <CardHeader className="items-center gap-2">
                <Server className="h-3.5 w-3.5 shrink-0 text-pink-400" />
                <CardTitle className="truncate">{s.key}</CardTitle>
                <AgentBadge agent={s.harness} />
                {/* Codex rows always live in the user-level config.toml, so
                    they read 全局 even when rendered inside the project view. */}
                <Badge variant="settings" className="ml-1">
                  {t(
                    s.harness === 'codex' || s.scope === 'user'
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
                      onClick={() => cycleEnable(s)}
                      title={t('mcp.enableTip', { state: t(STATE_LABEL[state]) })}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium disabled:cursor-not-allowed [&_svg]:pointer-events-none',
                        state === 'on'
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
                          await onUninstallMcp(s.key, cardScope(s), s.harness);
                          show('success', t('mcp.uninstalled', { name: s.key }));
                        },
                        { fail: (e) => t('errors.mcpUninstallFailed', { error: errorText(e) }) },
                      )
                    }
                    className="text-neutral-500 hover:text-red-400 disabled:cursor-not-allowed [&_svg]:pointer-events-none"
                    title={t('mcp.remove', { name: s.key })}
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
                <span className="text-neutral-300">{s.detail.command}</span>
                {s.detail.args && s.detail.args.length > 0 && (
                  <span className="text-neutral-500"> {s.detail.args.join(' ')}</span>
                )}
                {s.detail.env && Object.keys(s.detail.env).length > 0 && (
                  <div className="mt-1 text-neutral-600">
                    env: {Object.keys(s.detail.env).join(', ')}
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
