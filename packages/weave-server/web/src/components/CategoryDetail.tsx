import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/core';
import {
  skillSourceRuntime,
  type AssetEntry,
  type AssetAgent,
  type McpRow,
  type UpdateReport,
  type AssetScope,
  type StatuslineSource,
  type GlobalSkillGroup,
  type GlobalSkillSource,
  type PluginRow,
  type PluginRuntime,
  type ProjectRow,
} from '@/lib/api';
import type { Harness } from '@weavecode/core/harness';
import type { EnableOverride, ToolScope } from '@weavecode/core/tool';
import { HARNESS_ORDER, harnessUiOf } from '@/lib/harness-meta';
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
import { McpGrid } from '@/components/McpGrid';
import { StatusPill, statusTone } from '@/components/ui/status-pill';
import { countEffectiveSkills } from '@/lib/skill-stats';
import { AgentBadge } from '@/components/AgentBadge';
import { FileAssetTree } from '@/components/FileAssetTree';
import { StatuslinePanel } from '@/components/StatuslinePanel';
import { HooksPanel } from '@/components/HooksPanel';
import { PluginAssetsPanel } from '@/components/PluginAssetsPanel';
import { TasksPanel } from '@/components/tasks/TasksPanel';
import { GlobalTasksOverview } from '@/components/tasks/GlobalTasksOverview';
import { SequenceCanvas } from '@/components/tasks/SequenceCanvas';
import { type MainCategory } from '@/components/CategoryBar';
import type { MessageKey } from '@/i18n/dict';
import { ChevronDown, ChevronRight, Code2, PackageX } from 'lucide-react';

export type Mode = 'project' | 'global';

/**
 * 资源管理页的**视图**（不是类型 tab）：以插件包为准的主视图，与只读的文件视图。
 * 原「文件/技能/MCP/插件」四 tab 层已去掉——技能与 MCP 里不属任何包的（外置）并进
 * 主视图的「外部资源」折叠块，包内的随包启停（不在此露面）。
 */
export type ResourceView = 'packs' | 'files';

/** 视图按钮表（顺序即展示顺序）。 */
const VIEWS: { key: ResourceView; label: MessageKey }[] = [
  { key: 'packs', label: 'assetView.packs' },
  { key: 'files', label: 'assetView.files' },
];

/** 外置 = 不属于任何包的技能分组（包内的随包启停，不进「外部资源」块）。 */
function externalGroups<T extends { pluginKey?: string }>(groups: readonly T[]): T[] {
  return groups.filter((group) => !group.pluginKey);
}

/**
 * 外部块的「已生效」计数：MCP 行读行上的 `effective`；技能按同一口径（只有显式禁用
 * 才算不生效；项目态技能行没有包级禁用概念 → 全算生效）。
 */
function externalEffectiveCount(
  skills: readonly unknown[],
  mcp: readonly { effective?: boolean }[],
  groups: readonly SkillGroup[] | undefined,
): number {
  const skillDone = groups ? countEffectiveSkills(externalGroups(groups)).effective : skills.length;
  return skillDone + mcp.filter((row) => row.effective !== false).length;
}

/**
 * 主视图里的「外部资源」折叠块：装的是**不属于任何插件包**的技能与 MCP（包内的随包
 * 启停，不在这里露面）。默认展开——它是看到外置条目的唯一入口。
 */
function ExternalAssetsSection({
  title,
  note,
  tag,
  children,
}: {
  title: string;
  note: string;
  tag?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  // 默认折叠（与资源管理其余折叠条一致）
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-xl border border-white/[0.06] bg-neutral-900/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title={open ? t('common.collapse') : t('common.expand')}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left [&_svg]:pointer-events-none"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 text-neutral-500" />
        ) : (
          <ChevronRight className="h-3 w-3 text-neutral-500" />
        )}
        <span className="text-xs font-semibold text-neutral-300">{title}</span>
        {tag}
        <span className="text-[11px] text-neutral-500">{note}</span>
      </button>
      {open && <div className="space-y-2 px-3 pb-3">{children}</div>}
    </section>
  );
}


/** Harness-tool filter for the sections on the 资源管理 page. */
export type RuntimeTab = Harness | 'all';

/** 页签数组：每个 harness 一个 + 末尾「全部」。名表单点 = harness-meta。 */
const RUNTIME_TABS: readonly RuntimeTab[] = [...HARNESS_ORDER, 'all'];

/** 摆放元数据（拍板 7-5/7-7）：视图 → 该视图可写的插件启用档。user 归全局
 *  配置区，project/local 归项目下方；新档位 = 加一行，视图与控件不写死。 */
const GROUP_VIEW_SCOPES: Record<Mode, readonly ToolScope[]> = {
  global: ['user'],
  project: ['project', 'local'],
};

export function CategoryDetail({
  projectId,
  mode,
  category,
  resourceView,
  onResourceViewChange,
  statuslineNonce,
  assets,
  globalAssets,
  mcpRows,
  updates,
  globalSkillGroups,
  pluginRows,
  statuslineSource,
  onUninstallSkill,
  onUninstallMcp,
  onCycleMcpEnable,
  onCyclePluginState,
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
  /** 资源管理页视图（提升到 App，切分类来回不丢）。 */
  resourceView: ResourceView;
  onResourceViewChange: (view: ResourceView) => void;
  /** Bumped when re-entering the statusline panel → remounts with a fresh tab. */
  statuslineNonce: number;
  assets: AssetEntry[];
  /** Machine-level harness files for the global 资源管理 tree. */
  globalAssets: AssetEntry[];
  mcpRows: McpRow[];
  updates: UpdateReport | null;
  globalSkillGroups: GlobalSkillGroup[];
  pluginRows: PluginRow[];
  /** Statusline source, used only to render the Claude config sub-header. */
  statuslineSource: StatuslineSource | null;
  onUninstallSkill: (name: string, scope: AssetScope, agent?: AssetAgent) => void | Promise<void>;
  onUninstallMcp: (name: string, scope: AssetScope, agent?: AssetAgent) => void | Promise<void>;
  /** MCP 启停三态循环：落盘与行刷新由 App 统一负责。 */
  onCycleMcpEnable: (name: string, next: EnableOverride) => void | Promise<void>;
  /** 插件逐档启用覆写循环（§4 ②推广）：交语义（harness + 键 + 档位 + 下一态）。 */
  onCyclePluginState: (
    runtime: PluginRuntime,
    key: string,
    scope: ToolScope,
    state: EnableOverride,
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
  const scope: AssetScope = isGlobal ? 'user' : 'project';
  const t = useT();

  // 资产面板动作的按钮级反馈（FeedbackIcon 三态 + toast）已随按钮本体落位：
  // SkillGrid / McpGrid / FileAssetTree 各自 fb.run 自洽（App 的 handler 失败
  // 必抛，由各按钮的 fail 文案统一报错），这里只透传。
  // 落点属性判定（与按钮 disabled 同谓词）：拖拽中且不合法 → 红圈 + not-allowed + 原因。
  const dropVerdict = dragPayload
    ? canInstall(dragPayload.attrs, { scope, agent: dragPayload.targetAgent })
    : null;
  const dropBlocked = dragPayload !== null && dropVerdict !== null && !dropVerdict.ok;

  // Harness-tool tab: globally effective skills differ per tool, so the asset
  // categories filter by runtime instead of mixing them.
  const [runtimeTab, setRuntimeTab] = useState<RuntimeTab>(HARNESS_ORDER[0] ?? 'claude');
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
      const runtime: PluginRuntime | null = skillSourceRuntime(g.source);
      const isRow = (r: PluginRow) => r.harness === runtime && r.key === g.pluginKey;
      const rows = g.pluginKey && runtime ? pluginRows.filter(isRow) : [];
      const enabled =
        g.pluginKey && runtime ? rows.some((r) => r.effective) : undefined;
      // 逐档启用面（§4 ②推广·摆放）：只投影本视图可写的档（user 归全局、
      // project/local 归项目），enable 为 null 的面无启停语义不进。
      const viewScopes = GROUP_VIEW_SCOPES[mode];
      const scopeStates = rows
        .filter((r) => viewScopes.includes(r.scope) && r.enable !== null)
        .map((r) => ({ scope: r.scope, enable: r.enable!, installScopes: r.installScopes }));
      return {
        label: g.label,
        source: g.source,
        pluginKey: g.pluginKey,
        // 服务端已按 harness 面拆好市场名；前端只透传，不解析键形。
        namespace: g.namespace,
        enabled,
        // §6-4 卸载门控去硬编码：该 harness 的插件行有安装面（installScopes
        // 非空）→ 可整包卸载，不再写死 runtime === 'claude'。
        installSurface:
          g.pluginKey && runtime ? rows.some((r) => r.installScopes.length > 0) : undefined,
        ...(scopeStates.length > 0 ? { scopeStates } : {}),
        skills: g.skills.map((k) => ({
          name: k.name,
          scope: 'user' as const,
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
  }, [mode, globalSkillGroups, pluginRows, runtimeTab]);

  // MCP rows for the active runtime tab. 行自带 (harness, scope) 面与
  // installScopes：视图规则 = 卡面取 installScopes 含当前 scope 的那档，否则
  // 回落首档（codex 无 project 档 → 项目视图展示其 user 档）。'all' 合并全部。
  const mcp = useMemo<McpRow[]>(() => {
    const rowsFor = (h: Harness): McpRow[] => {
      const ofH = mcpRows.filter((r) => r.harness === h);
      if (ofH.length === 0) return [];
      const card = ofH[0].installScopes.includes(scope) ? scope : ofH[0].installScopes[0];
      return ofH.filter((r) => r.scope === card);
    };
    if (runtimeTab === 'all') return HARNESS_ORDER.flatMap(rowsFor);
    return rowsFor(runtimeTab);
  }, [mcpRows, scope, runtimeTab]);

  const skillUpdates = updates?.skills.filter((u) => u.scope === scope);
  // Non-claude harness MCP servers are user-level (scope-agnostic), so their
  // updates show whenever that harness's servers are visible; claude's updates
  // track the current scope and hide under another harness's tab.
  const mcpUpdates = updates?.mcp.filter((u) => {
    const h = u.agent && u.agent !== 'claude' ? u.agent : null;
    if (h) return runtimeTab === 'all' || runtimeTab === h;
    return u.scope === scope && (runtimeTab === 'all' || runtimeTab === 'claude');
  });
  const fileUpdates = updates?.files.filter((u) => u.scope === scope);

  // 资源管理文件树：只按 runtime tab 过滤（只信服务端给的 agent），
  // 类型显隐交给树内 chips（tagsOf）。
  const treeAssets = useMemo(
    () => assets.filter((a) => runtimeTab === 'all' || a.agent === runtimeTab),
    [assets, runtimeTab],
  );

  // 全局资源文件：同一过滤跑在机器级（~/.claude + ~/.codex）行上。
  const globalTreeAssets = useMemo(
    () => globalAssets.filter((a) => runtimeTab === 'all' || a.agent === runtimeTab),
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
          {RUNTIME_TABS.map((tab) => (
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
                  : t('category.tabToolTip', { tool: harnessUiOf(tab).tooltip })
              }
            >
              {tab === 'all' ? t('category.tabAll') : harnessUiOf(tab).label}
            </button>
          ))}
        </div>
      )}

      {/* 资源管理页：**视图**切换（插件包为主 / 查看文件只读）——不再是类型 tab 层 */}
      {category === 'files' && (
        <div className="flex items-center gap-1 rounded-lg bg-neutral-900/60 border border-white/[0.06] p-0.5 w-fit">
          {VIEWS.map((view) => (
            <button
              key={view.key}
              onClick={() => onResourceViewChange(view.key)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150',
                resourceView === view.key
                  ? 'bg-neutral-800 text-neutral-100 shadow-mac-sm'
                  : 'text-neutral-500 hover:text-neutral-300',
              )}
            >
              {t(view.label)}
            </button>
          ))}
        </div>
      )}

      {/* 查看文件（只读视图）：目录树照旧按类型 chips 筛选，但**不给管理动作**
          ——装/卸/启停归主视图（插件包/外部资源），这里只负责看。 */}
      {category === 'files' &&
        resourceView === 'files' &&
        !isGlobal &&
        (treeAssets.length === 0 ? (
          runtimeTab !== 'claude' && runtimeTab !== 'all' ? (
            <RuntimePlaceholder
              harness={runtimeTab}
              text={
                runtimeTab === 'codex'
                  ? t('category.codexFilesPlaceholder')
                  : t('category.emptyFilesOtherHarness', {
                      harness: harnessUiOf(runtimeTab).label,
                    })
              }
            />
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
            onOpenFile={onOpenFile}
          />
        ))}

      {category === 'files' &&
        resourceView === 'files' &&
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
            onOpenFile={onOpenFile}
          />
        ))}

      {category === 'files' && resourceView === 'packs' && (
        <>
          {/* 主区：插件包（包内技能/MCP 随包启停，不另行露面） */}
          <PluginAssetsPanel projectId={projectId} mode={mode} runtimeTab={runtimeTab} />

          {/* 外部资源：不属于任何包的 skills / MCP 自成一折叠块（用户定：外置单独一块） */}
          <ExternalAssetsSection
            title={t('category.externalAssets')}
            note={t('category.externalAssetsNote')}
            tag={
              <StatusPill
                tone={statusTone(
                  externalEffectiveCount(skills, mcp, isGlobal ? groups : undefined),
                  skills.length + mcp.length,
                )}
              >
                {t('category.externalAssetsSummary', {
                  skills: skills.length,
                  mcp: mcp.length,
                })}
              </StatusPill>
            }
          >
            <SkillGrid
              skills={skills}
              groups={isGlobal ? externalGroups(groups) : undefined}
              globalGroupsReadOnly={isGlobal ? undefined : externalGroups(groups)}
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
              onCyclePluginState={onCyclePluginState}
              onUninstallPlugin={onUninstallPlugin}
            />
            <McpGrid
              rows={mcp}
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
              onCycleMcpEnable={onCycleMcpEnable}
            />
          </ExternalAssetsSection>
        </>
      )}

      {category === 'weave' && <HooksPanel projectId={projectId} mode={mode} />}

      {/* 任务：项目级 = 分组事件链视图；全局级 = 跨项目只读总览 */}
      {category === 'tasks' &&
        (isGlobal ? (
          <GlobalTasksOverview projects={projects} onOpenSession={onOpenSession} />
        ) : (
          <TasksPanel
            projectId={projectId}
            initialSessionId={initialSessionId}
            projectLabel={projects.find((p) => p.id === projectId)?.name ?? ''}
            harnesses={projects.find((p) => p.id === projectId)?.harnesses ?? []}
          />
        ))}

      {/* 编排：项目级 = 跨会话序列画布；全局级 = 占位（序列目标随项目会话走）。 */}
      {category === 'orchestrate' &&
        (isGlobal ? (
          <p className="pt-6 text-center text-xs text-neutral-600">{t('orch.globalHint')}</p>
        ) : (
          <SequenceCanvas
            projectId={projectId}
            projectLabel={projects.find((p) => p.id === projectId)?.name ?? ''}
          />
        ))}

      {/* statusline 是 claude 专属特性：只在覆盖 claude 的页签（claude / 全部）显示。 */}
      {category === 'personalization' && (runtimeTab === 'claude' || runtimeTab === 'all') && (
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

      {/* 非 claude 页签（codex / 全部 / 未来 harness）显示「无对等个性化」占位。 */}
      {category === 'personalization' && runtimeTab !== 'claude' && (
        <RuntimePlaceholder
          harness={runtimeTab === 'all' ? 'codex' : runtimeTab}
          text={
            runtimeTab === 'all' || runtimeTab === 'codex'
              ? t('category.codexPersonalizationPlaceholder')
              : t('category.personalizationUnsupported', {
                  harness: harnessUiOf(runtimeTab).label,
                })
          }
        />
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

/** Shown for a non-claude harness tab in categories whose data source is Claude-only. */
function RuntimePlaceholder({ harness, text }: { harness: Harness; text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-white/[0.1] bg-neutral-900/40 p-8 flex flex-col items-center justify-center text-center gap-3">
      <Code2 className="h-8 w-8 text-neutral-600" />
      <AgentBadge agent={harness} />
      <p className="text-xs text-neutral-500 max-w-xs">{text}</p>
    </div>
  );
}
