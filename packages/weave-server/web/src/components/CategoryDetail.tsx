import { useMemo, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import {
  type AssetEntry,
  type AssetAgent,
  type McpServerConfig,
  type McpServerMap,
  type UpdateReport,
  type AssetScope,
  type StatuslineSource,
  type GlobalSkillGroup,
  type GlobalSkillSource,
  type PluginEnabledMap,
  type PluginRuntime,
  type ProjectRow,
} from '@/lib/api';
import type { Harness } from '@weavecode/core/harness';
import { canInstall, type DragPayload } from '@/lib/install-capabilities';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';
import {
  SkillGrid,
  groupSkillRows,
  type SkillRow,
  type SkillGroup,
  type OpenDetailFn,
} from '@/components/SkillGrid';
import { McpGrid, type McpRow } from '@/components/McpGrid';
import { AgentBadge } from '@/components/AgentBadge';
import {
  FileAssetTree,
  type FileAssetRow,
} from '@/components/FileAssetTree';
import { StatuslinePanel } from '@/components/StatuslinePanel';
import { HooksPanel } from '@/components/HooksPanel';
import { PluginAssetsPanel } from '@/components/PluginAssetsPanel';
import { TasksPanel } from '@/components/tasks/TasksPanel';
import { GlobalTasksOverview } from '@/components/tasks/GlobalTasksOverview';
import { type MainCategory } from '@/components/CategoryBar';
import type { MessageKey } from '@/i18n/dict';
import { Code2, PackageX } from 'lucide-react';

export type Mode = 'project' | 'global';

/** Second-level tab on the 资源管理 page: which exclusive asset panel shows. */
export type AssetTab = 'files' | 'skills' | 'mcp' | 'plugins';

const ASSET_TABS: AssetTab[] = ['files', 'skills', 'mcp', 'plugins'];

/** Tab labels stay the raw English terms (术语纪律一致). */
const ASSET_TAB_LABELS: Record<AssetTab, MessageKey> = {
  files: 'assetTab.files',
  skills: 'assetTab.skills',
  mcp: 'assetTab.mcp',
  plugins: 'assetTab.plugins',
};

/** Runtime surface of an asset row. Rows scanned before the agent field
 * existed fall back to the server's path rule (Codex owns .codex/ and
 * AGENTS.md anywhere in the tree). */
function agentOf(a: AssetEntry): AssetAgent {
  if (a.agent) return a.agent;
  const base = a.relPath.slice(a.relPath.lastIndexOf('/') + 1);
  return base === 'AGENTS.md' || a.relPath.startsWith('.codex/') ? 'codex' : 'claude';
}

/** Harness-tool filter for the sections on the 资源管理 page. */
export type RuntimeTab = Harness | 'all';

export function CategoryDetail({
  projectId,
  mode,
  category,
  assetTab,
  onAssetTabChange,
  statuslineNonce,
  assets,
  globalAssets,
  mcpServers,
  updates,
  globalSkillGroups,
  pluginEnabled,
  statuslineSource,
  onUninstallSkill,
  onUninstallMcp,
  onUninstallFileAsset,
  onTogglePlugin,
  onUninstallPlugin,
  onOpenFile,
  onOpenSkillDetail,
  projects,
  onOpenSession,
  initialSessionId,
  dragPayload,
}: {
  /** Anchor project id (global mode reuses it to read machine-global data). */
  projectId: number;
  mode: Mode;
  category: MainCategory;
  /** Files-page asset tab (lifted to App so it survives category switches). */
  assetTab: AssetTab;
  onAssetTabChange: (tab: AssetTab) => void;
  /** Bumped when re-entering the statusline panel → remounts with a fresh tab. */
  statuslineNonce: number;
  assets: AssetEntry[];
  /** Machine-level harness files for the global 资源管理 tree. */
  globalAssets: AssetEntry[];
  mcpServers: McpServerMap;
  updates: UpdateReport | null;
  globalSkillGroups: GlobalSkillGroup[];
  pluginEnabled: PluginEnabledMap;
  /** Statusline source, used only to render the Claude config sub-header. */
  statuslineSource: StatuslineSource | null;
  onUninstallSkill: (name: string, scope: AssetScope, agent?: AssetAgent) => void | Promise<void>;
  onUninstallMcp: (name: string, scope: AssetScope, agent?: AssetAgent) => void | Promise<void>;
  onUninstallFileAsset: (row: FileAssetRow, scope?: AssetScope) => void | Promise<void>;
  onTogglePlugin: (
    runtime: PluginRuntime,
    key: string,
    enabled: boolean,
  ) => void | Promise<void>;
  /** 卸载 CC 插件包（harness 级，按注册键；市场副本保留）。 */
  onUninstallPlugin: (runtime: PluginRuntime, key: string) => void | Promise<void>;
  onOpenFile: (relPath: string) => void;
  onOpenSkillDetail: OpenDetailFn;
  /** 全局任务总览的项目名映射与跳转入口。 */
  projects: ProjectRow[];
  onOpenSession: (projectId: number, sessionId: string) => void;
  /** 全局总览跳进项目任务视图时的初始选中会话。 */
  initialSessionId?: string;
  /** 拖拽中的统一 payload（App onDragStart 提升）；null = 无拖拽。 */
  dragPayload: DragPayload | null;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: 'project-assets' });
  const isGlobal = mode === 'global';
  const scope: AssetScope = isGlobal ? 'global' : 'project';
  const t = useT();

  // 资产面板动作的按钮级反馈（FeedbackIcon 三态 + toast）已随按钮本体落位：
  // SkillGrid / McpGrid / FileAssetTree 各自 fb.run 自洽（App 的 handler 失败
  // 必抛，由各按钮的 fail 文案统一报错），这里只透传。
  // 落点属性判定（与按钮 disabled 同谓词）：拖拽中且不合法 → 红圈 + not-allowed + 原因。
  const dropVerdict = dragPayload
    ? canInstall(dragPayload.attrs, { scope, agent: dragPayload.targetAgent })
    : null;
  const dropBlocked = dragPayload !== null && dropVerdict !== null && !dropVerdict.ok;

  // Harness-tool tab: globally effective skills differ per tool (Claude vs
  // Codex), so the asset categories filter by runtime instead of mixing them.
  const [runtimeTab, setRuntimeTab] = useState<RuntimeTab>('claude');
  const showRuntimeTabs = category === 'files' || category === 'personalization';

  // Project mode: a flat skill list from the project's own .claude/skills/ and
  // .codex/skills/, filtered by the runtime tab.
  const skills = useMemo<SkillRow[]>(
    () =>
      isGlobal
        ? []
        : groupSkillRows(assets).filter(
            (s) => runtimeTab === 'all' || s.agent === runtimeTab,
          ),
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
        // 服务端已按 harness 面拆好市场名；前端只透传，不解析键形。
        namespace: g.namespace,
        enabled,
        skills: g.skills.map((k) => ({
          name: k.name,
          scope: 'global' as const,
          files: [],
          source: g.source as GlobalSkillSource,
          pluginKey: g.pluginKey,
          form: k.form,
          // 全局行也带上 runtime：卡片据此显示 claude/codex 徽标，且「本地」把两个
          // personal 组合并成一个扁平网格时，同名技能仍能有唯一 key。
          // （抽屉只在项目态消费 agent，全局态分支不读它。）
          ...(runtime ? { agent: runtime } : {}),
        })),
      };
    });
  }, [globalSkillGroups, pluginEnabled, runtimeTab]);

  // MCP rows for the active runtime tab. Codex servers always come from the
  // user-level ~/.codex/config.toml map; the claude/all tabs show the current
  // scope's map (.mcp.json or ~/.claude.json), 'all' merges both surfaces.
  const mcp = useMemo<McpRow[]>(() => {
    const toRows = (map: Record<string, McpServerConfig>, agent?: AssetAgent) =>
      Object.entries(map).map(([name, config]) => ({ name, config, scope, agent }));
    if (runtimeTab === 'codex') return toRows(mcpServers.codex, 'codex');
    const claude = toRows(isGlobal ? mcpServers.global : mcpServers.project);
    if (runtimeTab === 'all') return [...claude, ...toRows(mcpServers.codex, 'codex')];
    return claude;
  }, [isGlobal, runtimeTab, mcpServers, scope]);

  const skillUpdates = updates?.skills.filter((u) => u.scope === scope);
  // Codex MCP updates are user-level (global scope) and shown whenever the
  // codex servers themselves are visible (codex / all tabs).
  const mcpUpdates = updates?.mcp.filter((u) => {
    if (u.agent === 'codex') return runtimeTab !== 'claude';
    return u.scope === scope && runtimeTab !== 'codex';
  });
  const fileUpdates = updates?.files.filter((u) => u.scope === scope);

  // 资源管理文件树：只按 runtime tab 过滤，类型显隐交给树内 chips（tagsOf）。
  const treeAssets = useMemo(
    () => assets.filter((a) => runtimeTab === 'all' || agentOf(a) === runtimeTab),
    [assets, runtimeTab],
  );

  // 全局资源文件：同一过滤跑在 ~/.claude + ~/.codex 行上。
  const globalTreeAssets = useMemo(
    () => globalAssets.filter((a) => runtimeTab === 'all' || agentOf(a) === runtimeTab),
    [globalAssets, runtimeTab],
  );

  return (
    <div
      ref={setNodeRef}
      className={cn(
        // px-2/pt-2 对齐分类卡的 p-2（内容左缘/上缘与卡区同基准，任务两栏
        // 不再贴主区边）；拖拽高亮用 -m-2 外扩，不改内容 padding。
        'space-y-4 h-full px-2 pt-2',
        dropBlocked
          ? 'ring-1 ring-red-500/60 rounded-md -m-2 bg-red-950/20 cursor-not-allowed'
          : (isOver && 'ring-1 ring-blue-500/60 rounded-md -m-2 bg-blue-950/20'),
      )}
    >
      {showRuntimeTabs && (
        <div className="flex items-center gap-1 rounded-lg bg-neutral-900/60 border border-white/[0.06] p-0.5 w-fit">
          {(['claude', 'codex', 'all'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setRuntimeTab(tab)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150',
                runtimeTab === tab
                  ? 'bg-neutral-800 text-neutral-100 shadow-mac-sm'
                  : 'text-neutral-500 hover:text-neutral-300',
              )}
              title={
                tab === 'all'
                  ? t('category.tabAllTip')
                  : t('category.tabToolTip', {
                      tool: tab === 'claude' ? 'Claude Code' : 'Codex',
                    })
              }
            >
              {tab === 'claude' ? 'Claude' : tab === 'codex' ? 'Codex' : t('category.tabAll')}
            </button>
          ))}
        </div>
      )}

      {/* 资源管理页：AssetTab 行（四个类型 tab 互斥）→ 对应内容 */}
      {category === 'files' && (
        <div className="flex items-center gap-1 rounded-lg bg-neutral-900/60 border border-white/[0.06] p-0.5 w-fit">
          {ASSET_TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => onAssetTabChange(tab)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150',
                assetTab === tab
                  ? 'bg-neutral-800 text-neutral-100 shadow-mac-sm'
                  : 'text-neutral-500 hover:text-neutral-300',
              )}
            >
              {t(ASSET_TAB_LABELS[tab])}
            </button>
          ))}
        </div>
      )}

      {/* 文件 tab：目录树（chips 类型筛选）。修订 ui-redesign D2 并集规则——
          树不再常驻页顶，只在 files tab 下渲染（提交信息声明）。 */}
      {category === 'files' &&
        assetTab === 'files' &&
        !isGlobal &&
        (treeAssets.length === 0 ? (
          runtimeTab === 'codex' ? (
            <CodexPlaceholder text={t('category.codexFilesPlaceholder')} />
          ) : (
            <div className="rounded-xl border border-dashed border-white/[0.1] bg-neutral-900/40 p-8 flex flex-col items-center justify-center text-center gap-3">
              <PackageX className="h-8 w-8 text-neutral-600" />
              <p className="text-xs text-neutral-500">{t('category.emptyFilesProject')}</p>
            </div>
          )
        ) : (
          <FileAssetTree
            scope={scope}
            assets={treeAssets}
            updates={fileUpdates}
            onUninstall={(row) => onUninstallFileAsset(row, 'project')}
            onOpenFile={onOpenFile}
          />
        ))}

      {category === 'files' &&
        assetTab === 'files' &&
        isGlobal &&
        (globalTreeAssets.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/[0.1] bg-neutral-900/40 p-8 flex flex-col items-center justify-center text-center gap-3">
            <PackageX className="h-8 w-8 text-neutral-600" />
            <div>
              <p className="text-sm font-medium text-neutral-300">{t('category.globalFilesTitle')}</p>
              <p className="text-xs text-neutral-500 mt-1 max-w-xs">
                {t('category.emptyFilesGlobalDesc')}
              </p>
            </div>
          </div>
        ) : (
          <FileAssetTree
            scope={scope}
            assets={globalTreeAssets}
            updates={fileUpdates}
            onUninstall={(row) => onUninstallFileAsset(row, 'global')}
            onOpenFile={onOpenFile}
          />
        ))}

      {category === 'files' && assetTab === 'skills' && (
        <SkillGrid
          skills={skills}
          groups={isGlobal ? groups : undefined}
          globalGroupsReadOnly={isGlobal ? undefined : groups}
          updates={skillUpdates}
          empty={
            runtimeTab === 'codex'
              ? isGlobal
                ? t('category.emptySkillsGlobalCodex')
                : t('category.emptySkillsProjectCodex')
              : isGlobal
                ? t('category.emptySkillsGlobal')
                : t('category.emptySkillsProject')
          }
          onUninstallSkill={onUninstallSkill}
          onOpenDetail={onOpenSkillDetail}
          onTogglePlugin={onTogglePlugin}
          onUninstallPlugin={onUninstallPlugin}
        />
      )}

      {category === 'files' && assetTab === 'mcp' && (
        <McpGrid
          projectId={projectId}
          servers={mcp}
          scope={scope}
          updates={mcpUpdates}
          empty={
            runtimeTab === 'codex'
              ? t('category.emptyMcpCodex')
              : isGlobal
                ? t('category.emptyMcpGlobal')
                : t('category.emptyMcpProject')
          }
          onUninstallMcp={onUninstallMcp}
        />
      )}

      {category === 'files' && assetTab === 'plugins' && (
        <PluginAssetsPanel projectId={projectId} mode={mode} runtimeTab={runtimeTab} />
      )}

      {category === 'weave' && <HooksPanel projectId={projectId} mode={mode} />}

      {/* 任务：项目级 = 分组事件链视图；全局级 = 跨项目只读总览 */}
      {category === 'tasks' &&
        (isGlobal ? (
          <GlobalTasksOverview projects={projects} onOpenSession={onOpenSession} />
        ) : (
          <TasksPanel projectId={projectId} initialSessionId={initialSessionId} />
        ))}

      {category === 'personalization' && runtimeTab !== 'codex' && (
        <div className="space-y-3">
          <p className="text-[11px] text-neutral-500">
            {isGlobal
              ? t('category.personalizationGlobal')
              : t('category.personalizationProject')}
            {statuslineSource && (
              <span className="ml-2">
                {t('category.statuslineSource', {
                  source:
                    statuslineSource === 'custom'
                      ? t('category.statuslineCustom')
                      : t('category.statuslineFollowGlobal'),
                })}
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
        <CodexPlaceholder text={t('category.codexPersonalizationPlaceholder')} />
      )}

      {dropBlocked && dropVerdict?.reasonKey && (
        <p className="text-xs text-red-300">{t(dropVerdict.reasonKey)}</p>
      )}
      {!dropBlocked && isOver && (
        <p className="text-xs text-blue-300">{t('category.dropToInstall')}</p>
      )}
    </div>
  );
}

/** Shown for the Codex tab in categories whose data source is Claude-only. */
function CodexPlaceholder({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-white/[0.1] bg-neutral-900/40 p-8 flex flex-col items-center justify-center text-center gap-3">
      <Code2 className="h-8 w-8 text-neutral-600" />
      <AgentBadge agent="codex" />
      <p className="text-xs text-neutral-500 max-w-xs">{text}</p>
    </div>
  );
}
