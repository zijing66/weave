import { useMemo, useState } from 'react';
import {
  type AssetAgent,
  type AssetEntry,
  type AssetScope,
  type SkillUpdate,
  type GlobalSkillSource,
  type PluginRuntime,
} from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { AgentBadge } from '@/components/AgentBadge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { countEffectiveSkills } from '@/lib/skill-stats';
import { groupByRepo, toggleIn, LOCAL_REPO_KEY } from '@/lib/repo-groups';
import {
  Trash2,
  FileCode,
  ChevronDown,
  ChevronRight,
  Power,
  FolderTree,
  Package,
  ChevronsUpDown,
  ChevronsDownUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';
import { useToast } from '@/components/Toast';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { errorText, useActionFeedback } from '@/lib/action-feedback';

export interface SkillRow {
  name: string;
  /** Which scope the row belongs to (project or global mode). */
  scope: AssetScope;
  /** The skill's files inside its directory (empty for global-scope rows). */
  files: AssetEntry[];
  /** Origin source for global skills (drives preview file fetch). */
  source?: GlobalSkillSource;
  /** `plugin@marketplace` for plugin-sourced global skills. */
  pluginKey?: string;
  /** Runtime surface the skill is installed on (project rows only). */
  agent?: AssetAgent;
  /** 装面形态（服务端 lstat 判定，仅陈述事实）。 */
  form?: 'link' | 'copy';
}

/** Open a skill's detail drawer. Global rows carry source/pluginKey so the
 * drawer can fetch files from the right global root; project rows carry the
 * runtime (claude/codex) so files resolve under the right skills/ root. */
export type OpenDetailFn = (
  name: string,
  scope: AssetScope,
  source?: GlobalSkillSource,
  pluginKey?: string,
  agent?: AssetAgent,
) => void;

/** A labelled group of skills (global view only). Plugin groups carry enable
 * state + a runtime so the toggle can write back to the host config. */
export interface SkillGroup {
  label: string;
  source: GlobalSkillSource;
  /** `plugin@marketplace` for plugin groups; undefined for personal groups. */
  pluginKey?: string;
  /** 所属市场 = 仓库 namespace（服务端拆键得来）；个人组 undefined → 归「本地」。
   *  L1 分组与 Plugins 页同源（`lib/repo-groups.ts`）。 */
  namespace?: string;
  /** Enable state for plugin groups (undefined → not applicable). */
  enabled?: boolean;
  skills: SkillRow[];
}

const PLUGIN_RUNTIME: Record<GlobalSkillSource, PluginRuntime | null> = {
  'claude-personal': null,
  'claude-plugin': 'claude',
  'codex-personal': null,
  'codex-plugin': 'codex',
};

function SkillCard({
  row,
  update,
  canUninstall,
  readOnly,
  onUninstallSkill,
  onOpenDetail,
}: {
  row: SkillRow;
  update: SkillUpdate | undefined;
  canUninstall: boolean;
  /** Read-only context (project view showing global skills): show a 全局 tag,
   * never an uninstall button. */
  readOnly?: boolean;
  onUninstallSkill: (name: string, scope: AssetScope, agent?: AssetAgent) => void | Promise<void>;
  onOpenDetail: OpenDetailFn;
}) {
  const t = useT();
  // 卸载按钮本体自持三态反馈（同 FileAssetTree 行节点）：loading 转圈 + 防重入，
  // 成功/失败一律 toast——handler（App）失败必抛，文案在按钮这里给。
  const { show } = useToast();
  const fb = useActionFeedback();
  const uninstallKey = `skill-uninstall:${row.scope}:${row.agent ?? 'claude'}:${row.name}`;
  const uninstallState = fb.stateOf(uninstallKey);
  // 装面形态只在全局位置有意义，且只在 weave 自己铺的那两处（个人技能根）——
  // 项目技能按设计一律是副本，插件缓存是 CC 的，都不该标「副本」让人以为可改。
  const showForm =
    row.scope === 'global' &&
    (row.source === 'claude-personal' || row.source === 'codex-personal') &&
    row.form !== undefined;
  return (
    <Card>
      <CardHeader className="items-center gap-2">
        <button
          onClick={() =>
            onOpenDetail(row.name, row.scope, row.source, row.pluginKey, row.agent)
          }
          className="flex items-center gap-2 text-left flex-1 min-w-0"
          title={t('skillGrid.openDetail', { name: row.name })}
        >
          <FileCode className="h-3.5 w-3.5 shrink-0 text-blue-400" />
          <CardTitle className="truncate">{row.name}</CardTitle>
          <AgentBadge agent={row.agent} className="ml-1" />
          {readOnly ? (
            <Badge variant="settings" className="ml-1">
              {t('skillGrid.globalTag')}
            </Badge>
          ) : (
            row.scope === 'project' && (
              <Badge variant="settings" className="ml-1">
                {t('library.scopeProject')}
              </Badge>
            )
          )}
          {row.files.length > 0 && (
            <Badge variant="skill" className="ml-1">
              {row.files.length}
            </Badge>
          )}
          {update?.outdated && (
            <Badge variant="warning" className="ml-1">
              {t('skillGrid.update')}
            </Badge>
          )}
          {update?.custom && (
            <Badge variant="other" className="ml-1">
              {t('skillGrid.custom')}
            </Badge>
          )}
          {showForm && (
            <span
              className={cn(
                'ml-1 shrink-0 rounded px-1 py-0.5 text-[10px]',
                row.form === 'link'
                  ? 'bg-neutral-800 text-neutral-400'
                  : 'bg-amber-900/30 text-amber-300',
              )}
              title={t('repo.formTip')}
            >
              {row.form === 'link' ? t('repo.formLink') : t('repo.formCopy')}
            </span>
          )}
        </button>
        {canUninstall && !readOnly && (
          <button
            type="button"
            disabled={uninstallState === 'loading'}
            onClick={() =>
              void fb.run(
                uninstallKey,
                async () => {
                  await onUninstallSkill(row.name, row.scope, row.agent);
                  show('success', t('skillGrid.uninstalled', { name: row.name }));
                },
                { fail: (e) => t('errors.uninstallFailed', { error: errorText(e) }) },
              )
            }
            className="text-neutral-500 hover:text-red-400 shrink-0 disabled:cursor-not-allowed [&_svg]:pointer-events-none"
            title={t('skillGrid.uninstall', { name: row.name })}
          >
            <FeedbackIcon
              state={uninstallState}
              className="h-3.5 w-3.5"
              icon={<Trash2 className="h-3.5 w-3.5" />}
            />
          </button>
        )}
      </CardHeader>
    </Card>
  );
}

export function SkillGrid({
  skills,
  groups,
  globalGroupsReadOnly,
  updates,
  empty,
  onUninstallSkill,
  onOpenDetail,
  onTogglePlugin,
}: {
  /** Flat skill list (project mode). */
  skills?: SkillRow[];
  /** Grouped skills (global mode). When present, renders collapsible groups. */
  groups?: SkillGroup[];
  /** Global skill groups shown read-only beneath the project list (project
   * mode): tagged 全局, no uninstall / no enable toggle. */
  globalGroupsReadOnly?: SkillGroup[];
  /** Update info already filtered to this mode's scope. */
  updates?: SkillUpdate[];
  empty: string;
  onUninstallSkill: (name: string, scope: AssetScope, agent?: AssetAgent) => void | Promise<void>;
  onOpenDetail: OpenDetailFn;
  onTogglePlugin?: (
    runtime: PluginRuntime,
    key: string,
    enabled: boolean,
  ) => void | Promise<void>;
}) {
  const t = useT();
  const findUpdate = (name: string) => updates?.find((u) => u.name === name);

  // --- global mode: editable collapsible groups ---
  if (groups !== undefined && groups.length > 0) {
    return (
      <GroupedSkills
        groups={groups}
        updates={updates}
        onUninstallSkill={onUninstallSkill}
        onOpenDetail={onOpenDetail}
        onTogglePlugin={onTogglePlugin}
      />
    );
  }

  // --- project mode: flat project skills + optional read-only global groups ---
  const hasProject = !!skills && skills.length > 0;
  const hasGlobalRO = !!globalGroupsReadOnly && globalGroupsReadOnly.length > 0;
  if (!hasProject && !hasGlobalRO) {
    return (
      <p className="text-xs text-neutral-600 border border-dashed border-white/[0.06] rounded-md p-3">
        {empty}
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {hasProject && (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold text-neutral-400 uppercase">{t('skillGrid.projectHeading')}</h2>
            {/* Project skills have no enable toggle, so this is a count, not
                an effectiveness ratio — same pill shape as the global section
                so the two rows read as one family. */}
            <span className="ml-auto rounded-full bg-neutral-800/60 text-neutral-400 px-2 py-0.5 text-[11px] font-medium tabular-nums">
              {skills!.length}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 items-start">
            {skills!.map((s) => (
              <SkillCard
                key={`${s.scope}-${s.name}`}
                row={s}
                update={findUpdate(s.name)}
                canUninstall={s.scope === 'project'}
                onUninstallSkill={onUninstallSkill}
                onOpenDetail={onOpenDetail}
              />
            ))}
          </div>
        </section>
      )}
      {hasGlobalRO && (
        <GroupedSkills
          groups={globalGroupsReadOnly!}
          updates={updates}
          onUninstallSkill={onUninstallSkill}
          onOpenDetail={onOpenDetail}
          readOnly
        />
      )}
    </div>
  );
}

/** `已生效 N / M` pill — how many of the listed skills are actually in effect.
 * Green when everything is live, amber when a disabled plugin is holding some
 * back, neutral when there is nothing to count. */
function EffectivePill({ effective, total }: { effective: number; total: number }) {
  const t = useT();
  const tone =
    total === 0
      ? 'bg-neutral-800 text-neutral-500'
      : effective === total
        ? 'bg-emerald-900/40 text-emerald-300'
        : 'bg-amber-900/30 text-amber-300';
  const title =
    total === 0
      ? t('skillGrid.effNone')
      : effective === total
        ? t('skillGrid.effAll', { n: total })
        : t('skillGrid.effDisabled', { n: total - effective });

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums',
        tone,
      )}
      title={title}
    >
      <Power className="h-3 w-3" />
      {t('skillGrid.effective', { done: effective, total })}
    </span>
  );
}

/** L2 折叠块：一个插件包（市场里的一个插件文件夹）。 */
function PackBlock({
  group,
  collapsed,
  onToggle,
  findUpdate,
  onUninstallSkill,
  onOpenDetail,
  onTogglePlugin,
  readOnly,
}: {
  group: SkillGroup;
  collapsed: boolean;
  onToggle: () => void;
  findUpdate: (name: string) => SkillUpdate | undefined;
  onUninstallSkill: (name: string, scope: AssetScope, agent?: AssetAgent) => void | Promise<void>;
  onOpenDetail: OpenDetailFn;
  onTogglePlugin?: (runtime: PluginRuntime, key: string, enabled: boolean) => void | Promise<void>;
  readOnly?: boolean;
}) {
  const t = useT();
  const fb = useActionFeedback();
  const isPlugin = group.source.endsWith('-plugin');
  const runtime = PLUGIN_RUNTIME[group.source];
  // A pack is atomic — its plugin is either enabled or not — so this is either
  // all of its skills or none. Shown anyway so every level reads alike.
  const stats = countEffectiveSkills([group]);
  const toggleKey = `plugin-toggle:${runtime}:${group.pluginKey ?? '-'}`;
  const toggleState = fb.stateOf(toggleKey);
  return (
    <div className="rounded-xl border border-white/[0.06] bg-neutral-900/40 overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.02] cursor-pointer"
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
        )}
        <FolderTree className="h-3.5 w-3.5 shrink-0 text-blue-400" />
        <span className="text-xs font-semibold text-neutral-300 truncate">{group.label}</span>
        {/* 注册键 name@marketplace——@后 = 所属市场 = 插件的 namespace（同工具箱行） */}
        {group.pluginKey && (
          <span
            className="shrink-0 font-mono text-[10px] text-neutral-500"
            title={t('skillGrid.keyTip')}
          >
            {group.pluginKey}
          </span>
        )}
        {/* prominent source tag: 插件 / 本地 + runtime */}
        <Badge variant={isPlugin ? 'mcp' : 'skill'} className="ml-1">
          {isPlugin ? t('skillGrid.plugin') : t('repo.local')}
        </Badge>
        <AgentBadge agent={group.source.startsWith('claude') ? 'claude' : 'codex'} />
        <EffectivePill effective={stats.effective} total={stats.total} />
        {/* plugin enable toggle — a real <button>; the outer row is a div to avoid nested buttons.
         * Hidden in read-only (project) mode: global config is not edited from a project view. */}
        {isPlugin && runtime && onTogglePlugin && !readOnly && group.enabled !== undefined && (
          <button
            type="button"
            disabled={toggleState === 'loading'}
            onClick={(e) => {
              e.stopPropagation();
              void fb.run(
                toggleKey,
                async () => {
                  await onTogglePlugin(runtime, group.pluginKey!, !group.enabled);
                },
                { fail: (err) => t('errors.pluginToggleFailed', { error: errorText(err) }) },
              );
            }}
            title={group.enabled ? t('skillGrid.pluginOn') : t('skillGrid.pluginOff')}
            className={cn(
              'ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium disabled:cursor-not-allowed [&_svg]:pointer-events-none',
              group.enabled
                ? 'bg-emerald-900/40 text-emerald-300'
                : 'bg-neutral-800 text-neutral-500',
            )}
          >
            <FeedbackIcon
              state={toggleState}
              className="h-3 w-3"
              icon={<Power className="h-3 w-3" />}
            />
            {group.enabled ? t('skillGrid.on') : t('skillGrid.off')}
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="px-3 pb-3 pt-1">
          {group.skills.length === 0 ? (
            <p className="text-xs text-neutral-600 py-2">{t('common.empty')}</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 items-start">
              {group.skills.map((s) => (
                <SkillCard
                  key={`${s.scope}-${s.agent ?? 'claude'}-${s.name}`}
                  row={s}
                  update={findUpdate(s.name)}
                  canUninstall={false}
                  readOnly={readOnly}
                  onUninstallSkill={onUninstallSkill}
                  onOpenDetail={onOpenDetail}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GroupedSkills({
  groups,
  updates,
  onUninstallSkill,
  onOpenDetail,
  onTogglePlugin,
  readOnly,
}: {
  groups: SkillGroup[];
  updates?: SkillUpdate[];
  onUninstallSkill: (name: string, scope: AssetScope, agent?: AssetAgent) => void | Promise<void>;
  onOpenDetail: OpenDetailFn;
  onTogglePlugin?: (
    runtime: PluginRuntime,
    key: string,
    enabled: boolean,
  ) => void | Promise<void>;
  /** Read-only context (project view): no enable toggle, cards tagged 全局. */
  readOnly?: boolean;
}) {
  const t = useT();
  const findUpdate = (name: string) => updates?.find((u) => u.name === name);

  // 三级折叠：L1 仓库 namespace → L2 插件包 → L3 技能卡片。
  // 折叠集记「用户打开过的」而非「关掉的」：数据异步到达、切 runtime tab 时，
  // 展开集能保住已展开项，折叠集会因新 key 出现而失忆。
  const repoGroups = useMemo(() => groupByRepo(groups), [groups]);
  const packKeys = useMemo(
    () => groups.map((g) => `${g.source}:${g.pluginKey ?? '-'}`),
    [groups],
  );
  // 「本地」例外地默认展开：那是用户手装的独立技能，进页面就该能看见，
  // 否则首屏是个全折叠的空壳。市场块按用户口径默认折叠。
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set([LOCAL_REPO_KEY]));
  const [expandedPacks, setExpandedPacks] = useState<Set<string>>(new Set());
  const anyExpanded = expandedRepos.size > 0 || expandedPacks.size > 0;
  /** One button that flips every level between expand-all and collapse-all. */
  const toggleAll = () => {
    if (anyExpanded) {
      setExpandedRepos(new Set());
      setExpandedPacks(new Set());
    } else {
      setExpandedRepos(new Set(repoGroups.map((r) => r.key)));
      setExpandedPacks(new Set(packKeys));
    }
  };

  // How many of the listed skills are actually live. The heading used to carry
  // the total; the pill shows effective/total, so that count would be a repeat.
  const { effective, total } = countEffectiveSkills(groups);

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-semibold text-neutral-400 uppercase">
          {/* Same name in both modes; `只读` marks the project view, where the
              global groups are shown but not editable. */}
          {t('skillGrid.globalHeading')}
          {readOnly && (
            <span className="ml-1 text-[10px] text-neutral-600 normal-case">
              {t('skillGrid.readOnly')}
            </span>
          )}
        </h2>
        <div className="ml-auto flex items-center gap-1">
          <EffectivePill effective={effective} total={total} />
          <button
            onClick={toggleAll}
            className="inline-flex items-center gap-1 rounded-full bg-neutral-800 text-neutral-400 px-2 py-0.5 text-[11px] hover:bg-neutral-700"
            title={
              anyExpanded ? t('skillGrid.collapseAllGroups') : t('skillGrid.expandAllGroups')
            }
          >
            {anyExpanded ? (
              <ChevronsDownUp className="h-3 w-3" />
            ) : (
              <ChevronsUpDown className="h-3 w-3" />
            )}
            {anyExpanded ? t('skillGrid.collapseAll') : t('skillGrid.expandAll')}
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {repoGroups.map((repo) => {
          const namespace = repo.namespace;
          const isLocal = namespace === undefined;
          const repoCollapsed = !expandedRepos.has(repo.key);
          const repoStats = countEffectiveSkills(repo.groups);
          const skillCount = repo.groups.reduce((n, g) => n + g.skills.length, 0);
          return (
            <div
              key={repo.key}
              className="rounded-2xl border border-white/[0.08] bg-neutral-900/60 overflow-hidden"
            >
              <div
                role="button"
                tabIndex={0}
                onClick={() => setExpandedRepos((prev) => toggleIn(prev, repo.key))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setExpandedRepos((prev) => toggleIn(prev, repo.key));
                  }
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.03] cursor-pointer"
              >
                {repoCollapsed ? (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                )}
                <Package className="h-3.5 w-3.5 shrink-0 text-violet-400" />
                {/* 一级 = 仓库 namespace：市场名原样显示，本地则是一块收敛的个人技能。 */}
                <span className="text-xs font-semibold text-neutral-200 truncate">
                  {isLocal ? t('repo.local') : namespace}
                </span>
                {!isLocal && (
                  <span
                    className="shrink-0 text-[10px] text-neutral-600"
                    title={t('repo.namespaceTip')}
                  >
                    {t('repo.packCount', { n: repo.groups.length })}
                  </span>
                )}
                {/* 「本地」= weave 亲手装到全局位置的技能，只有这里我们才决定得了
                    链接还是副本——CC 自有的 plugins/cache 副本不在此列（那是 CC 解引用
                    后自己复制的，提示用户改设置是误导）。 */}
                {isLocal && (
                  <span
                    className="shrink-0 text-[10px] text-neutral-600"
                    title={t('repo.formTip')}
                  >
                    {t('repo.formLegend')}
                  </span>
                )}
                <Badge variant="skill" className="ml-1">
                  {skillCount}
                </Badge>
                <EffectivePill effective={repoStats.effective} total={repoStats.total} />
              </div>
              {!repoCollapsed &&
                (isLocal ? (
                  <div className="px-3 pb-3 pt-1">
                    {skillCount === 0 ? (
                      <p className="text-xs text-neutral-600 py-2">{t('common.empty')}</p>
                    ) : (
                      <div className="grid grid-cols-2 gap-3 items-start">
                        {repo.groups
                          .flatMap((g) => g.skills)
                          .map((s) => (
                            <SkillCard
                              key={`${s.scope}-${s.agent ?? 'claude'}-${s.name}`}
                              row={s}
                              update={findUpdate(s.name)}
                              canUninstall={false}
                              readOnly={readOnly}
                              onUninstallSkill={onUninstallSkill}
                              onOpenDetail={onOpenDetail}
                            />
                          ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="px-3 pb-3 pt-1 space-y-2">
                    {repo.groups.map((g) => {
                      const packKey = `${g.source}:${g.pluginKey ?? '-'}`;
                      return (
                        <PackBlock
                          key={packKey}
                          group={g}
                          collapsed={!expandedPacks.has(packKey)}
                          onToggle={() => setExpandedPacks((prev) => toggleIn(prev, packKey))}
                          findUpdate={findUpdate}
                          onUninstallSkill={onUninstallSkill}
                          onOpenDetail={onOpenDetail}
                          onTogglePlugin={onTogglePlugin}
                          readOnly={readOnly}
                        />
                      );
                    })}
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Group project-scope skill files by their containing skill directory.
 * Matches both `.claude/skills/` and `.codex/skills/` roots; the agent is
 * carried on each row so uninstall targets the right surface. */
export function groupSkillRows(assets: AssetEntry[]): SkillRow[] {
  const m = new Map<string, { agent: AssetAgent; files: AssetEntry[] }>();
  for (const a of assets) {
    const match = a.relPath.match(/^(?:\.claude|\.codex)\/skills\/([^/]+)\//);
    if (!match) continue;
    const name = match[1];
    const agent: AssetAgent = a.relPath.startsWith('.codex') ? 'codex' : 'claude';
    const entry = m.get(name) ?? { agent, files: [] as AssetEntry[] };
    entry.files.push(a);
    m.set(name, entry);
  }
  return [...m.entries()]
    .map(([name, { agent, files }]) => ({
      name,
      scope: 'project' as AssetScope,
      agent,
      files,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
