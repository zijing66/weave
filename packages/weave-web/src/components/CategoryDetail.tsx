import { useMemo, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import {
  type AssetEntry,
  type McpServerConfig,
  type UpdateReport,
  type AssetScope,
  type StatuslineSource,
  type GlobalSkillGroup,
  type GlobalSkillSource,
  type PluginEnabledMap,
  type PluginRuntime,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  SkillGrid,
  groupSkillRows,
  type SkillRow,
  type SkillGroup,
  type OpenDetailFn,
} from '@/components/SkillGrid';
import { McpGrid, type McpRow } from '@/components/McpGrid';
import { OtherAssets } from '@/components/OtherAssets';
import { StatuslinePanel } from '@/components/StatuslinePanel';
import { type MainCategory } from '@/components/CategoryBar';
import { Code2, PackageX } from 'lucide-react';

export type Mode = 'project' | 'global';

/** Harness-tool filter for the asset categories (skills / mcp / commands). */
export type RuntimeTab = 'claude' | 'codex' | 'all';

export function CategoryDetail({
  projectId,
  mode,
  category,
  statuslineNonce,
  assets,
  mcpServers,
  updates,
  globalSkillGroups,
  pluginEnabled,
  statuslineSource,
  onUninstallSkill,
  onUninstallMcp,
  onTogglePlugin,
  onOpenFile,
  onOpenSkillDetail,
}: {
  /** Anchor project id (global mode reuses it to read machine-global data). */
  projectId: number;
  mode: Mode;
  category: MainCategory;
  /** Bumped when re-entering the statusline panel → remounts with a fresh tab. */
  statuslineNonce: number;
  assets: AssetEntry[];
  mcpServers: { project: Record<string, McpServerConfig>; global: Record<string, McpServerConfig> };
  updates: UpdateReport | null;
  globalSkillGroups: GlobalSkillGroup[];
  pluginEnabled: PluginEnabledMap;
  /** Statusline source, used only to render the Claude config sub-header. */
  statuslineSource: StatuslineSource | null;
  onUninstallSkill: (name: string, scope: AssetScope) => void;
  onUninstallMcp: (name: string, scope: AssetScope) => void;
  onTogglePlugin: (runtime: PluginRuntime, key: string, enabled: boolean) => void;
  onOpenFile: (relPath: string) => void;
  onOpenSkillDetail: OpenDetailFn;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: 'project-assets' });
  const isGlobal = mode === 'global';
  const scope: AssetScope = isGlobal ? 'global' : 'project';

  // Harness-tool tab: globally effective skills differ per tool (Claude vs
  // Codex), so the asset categories filter by runtime instead of mixing them.
  const [runtimeTab, setRuntimeTab] = useState<RuntimeTab>('claude');
  const showRuntimeTabs =
    category === 'skills' ||
    category === 'mcp' ||
    category === 'commands' ||
    category === 'personalization';

  // Project mode: a flat skill list from the project's own .claude/skills/
  // (Claude-only — the project harness has no Codex-scope skills).
  const skills = useMemo<SkillRow[]>(
    () => (isGlobal || runtimeTab === 'codex' ? [] : groupSkillRows(assets)),
    [isGlobal, runtimeTab, assets],
  );

  // Machine-wide skill groups (personal + plugin, Claude + Codex), decorated
  // with live plugin enable state for the toggle badges. Built in BOTH modes:
  // global mode renders them as editable groups; project mode renders them
  // read-only beneath the project's own skills. Filtered by the runtime tab.
  const groups = useMemo<SkillGroup[]>(() => {
    const filtered =
      runtimeTab === 'all'
        ? globalSkillGroups
        : globalSkillGroups.filter((g) => g.source.startsWith(runtimeTab));
    return filtered.map((g) => {
      const runtime: PluginRuntime | null = g.source.startsWith('claude')
        ? 'claude'
        : g.source.startsWith('codex')
          ? 'codex'
          : null;
      const enabled =
        g.pluginKey && runtime ? pluginEnabled[runtime][g.pluginKey] ?? false : undefined;
      return {
        label: g.label,
        source: g.source,
        pluginKey: g.pluginKey,
        enabled,
        skills: g.skills.map((k) => ({
          name: k.name,
          scope: 'global' as const,
          files: [],
          source: g.source as GlobalSkillSource,
          pluginKey: g.pluginKey,
        })),
      };
    });
  }, [globalSkillGroups, pluginEnabled, runtimeTab]);

  const mcp = useMemo<McpRow[]>(() => {
    const map = isGlobal ? mcpServers.global : mcpServers.project;
    return Object.entries(map).map(([name, config]) => ({ name, config, scope }));
  }, [isGlobal, mcpServers, scope]);

  const skillUpdates = updates?.skills.filter((u) => u.scope === scope);
  const mcpUpdates = updates?.mcp.filter((u) => u.scope === scope);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'space-y-4 h-full',
        isOver && 'ring-1 ring-blue-500/60 rounded-md p-2 -m-2 bg-blue-950/20',
      )}
    >
      {showRuntimeTabs && (
        <div className="flex items-center gap-1 rounded-lg bg-neutral-900/60 border border-white/[0.06] p-0.5 w-fit">
          {(['claude', 'codex', 'all'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setRuntimeTab(t)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150',
                runtimeTab === t
                  ? 'bg-neutral-800 text-neutral-100 shadow-mac-sm'
                  : 'text-neutral-500 hover:text-neutral-300',
              )}
              title={
                t === 'all'
                  ? '混合展示全部 harness 工具的资产'
                  : `仅展示 ${t === 'claude' ? 'Claude Code' : 'Codex'} 生效的资产`
              }
            >
              {t === 'claude' ? 'Claude' : t === 'codex' ? 'Codex' : '全部'}
            </button>
          ))}
        </div>
      )}

      {category === 'skills' && (
        <SkillGrid
          skills={skills}
          groups={isGlobal ? groups : undefined}
          globalGroupsReadOnly={isGlobal ? undefined : groups}
          updates={skillUpdates}
          empty={
            runtimeTab === 'codex'
              ? isGlobal
                ? '未安装 Codex 生效的全局 skills'
                : '该项目无 Codex 生效的 skills（项目 .claude/skills 仅作用于 Claude）'
              : isGlobal
                ? '未安装全局 skills'
                : '该项目未安装 skills'
          }
          onUninstallSkill={onUninstallSkill}
          onOpenDetail={onOpenSkillDetail}
          onTogglePlugin={onTogglePlugin}
        />
      )}

      {category === 'mcp' &&
        (runtimeTab === 'codex' ? (
          <CodexPlaceholder text="Codex 的 MCP 配置（~/.codex/config.toml）暂未接入，当前仅管理 Claude 的 .mcp.json。" />
        ) : (
          <McpGrid
            servers={mcp}
            updates={mcpUpdates}
            empty={isGlobal ? '未配置全局 MCP' : '该项目未配置 MCP'}
            onUninstallMcp={onUninstallMcp}
          />
        ))}

      {category === 'commands' &&
        (runtimeTab === 'codex' ? (
          <CodexPlaceholder text="Codex 的 commands / agents 暂未接入，当前仅管理 Claude 的 .claude/commands。" />
        ) : isGlobal ? (
          <div className="rounded-xl border border-dashed border-white/[0.1] bg-neutral-900/40 p-8 flex flex-col items-center justify-center text-center gap-3">
            <PackageX className="h-8 w-8 text-neutral-600" />
            <div>
              <p className="text-sm font-medium text-neutral-300">全局 Commands</p>
              <p className="text-xs text-neutral-500 mt-1 max-w-xs">
                全局级别的 commands / agents / helpers 配置暂未提供，仅在项目视图展示。
              </p>
            </div>
          </div>
        ) : (
          <OtherAssets assets={assets} onOpenFile={onOpenFile} />
        ))}

      {category === 'personalization' && runtimeTab !== 'codex' && (
        <div className="space-y-3">
          <p className="text-[11px] text-neutral-500">
            {isGlobal ? '全局 Claude 个性化配置（模板）' : 'Claude Code 个性化配置'}
            {statuslineSource && (
              <span className="ml-2">
                statusline：{statuslineSource === 'custom' ? '项目自定义' : '跟随全局模板'}
              </span>
            )}
          </p>
          <StatuslinePanel
            key={`${projectId}-${isGlobal ? 'global' : 'project'}-${statuslineNonce}`}
            projectId={projectId}
            initialTab={isGlobal ? 'global' : 'project'}
          />
        </div>
      )}

      {category === 'personalization' && runtimeTab !== 'claude' && (
        <CodexPlaceholder text="Codex 个性化配置（statusline / 主题等）暂未接入。weave 目前仅管理 Claude Code 的 harness 资产，Codex 配置将在后续版本提供。" />
      )}

      {isOver && <p className="text-xs text-blue-300">Drop to install skill</p>}
    </div>
  );
}

/** Shown for the Codex tab in categories whose data source is Claude-only. */
function CodexPlaceholder({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-white/[0.1] bg-neutral-900/40 p-8 flex flex-col items-center justify-center text-center gap-3">
      <Code2 className="h-8 w-8 text-neutral-600" />
      <p className="text-xs text-neutral-500 max-w-xs">{text}</p>
    </div>
  );
}
