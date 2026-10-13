import { useMemo, useState } from 'react';
import {
  skillSourceRuntime,
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
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import type { EnableOverride, ToolScope } from '@weavecode/core/tool';

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
  /** 该组 harness 的插件行有安装面（installScopes 非空）→ 可整包卸载；
   *  undefined → 非插件组（§6-4 卸载门控数据行驱动）。 */
  installSurface?: boolean;
  /** 三档启用面（§4 ②推广·拍板 7-5/7-7 摆放）：视图相关档的行随组携带
   *  （user 归全局配置区、project/local 归项目下方，由 CategoryDetail 按摆放
   *  元数据过滤），PackBlock 逐行渲染循环钮；空/缺省 = 非插件组或无面。 */
  scopeStates?: GroupScopeState[];
  skills: SkillRow[];
}

/** 插件组单档启用面：CategoryDetail 从 PluginRow 行投影，PackBlock 只消费。 */
export interface GroupScopeState {
  scope: ToolScope;
  /** 该档覆写（行 enable 非 null 的投影；词表 on/off/inherit）。 */
  enable: EnableOverride;
  /** 行随身判据（与 server PUT 同分支）：非空 = 有安装面的 harness →
   *  三档三态循环；空 = 仅启用面 harness → on/off 布尔循环。 */
  installScopes: readonly ToolScope[];
}

/** 插件组的写回 harness（个人组无；由来源前缀派生，不写死两 harness）。 */
function groupRuntime(source: GlobalSkillSource): PluginRuntime | null {
  return source.endsWith('-plugin') ? skillSourceRuntime(source) : null;
}

/** 三态循环 inherit → on → off（仅启用面 harness 走 on ↔ off 二态，见下）。 */
const NEXT_STATE: Record<EnableOverride, EnableOverride> = {
  inherit: 'on',
  on: 'off',
  off: 'inherit',
};

const STATE_LABEL: Record<EnableOverride, 'skillGrid.enableDefault' | 'skillGrid.enableOn' | 'skillGrid.enableOff'> = {
  inherit: 'skillGrid.enableDefault',
  on: 'skillGrid.enableOn',
  off: 'skillGrid.enableOff',
};

const SCOPE_LABEL: Record<ToolScope, 'skillGrid.scopeUser' | 'skillGrid.scopeProject' | 'skillGrid.scopeLocal'> = {
  user: 'skillGrid.scopeUser',
  project: 'skillGrid.scopeProject',
  local: 'skillGrid.scopeLocal',
};

/** 行随身判据（与 server PUT 同分支）：有安装面的 harness 三档三态；
 *  仅启用面的 harness（如 codex）on/off 布尔循环（inherit → 400）。 */
const nextStateOf = (s: GroupScopeState): EnableOverride =>
  s.installScopes.length > 0 ? NEXT_STATE[s.enable] : s.enable === 'on' ? 'off' : 'on';

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
  // 全局卸载删的是用户技能位上的真文件（副本会递归删），破坏性 → 先确认；
  // 项目卸载维持现状直删。
  const [confirming, setConfirming] = useState(false);
  const runUninstall = () =>
    void fb.run(
      uninstallKey,
      async () => {
        await onUninstallSkill(row.name, row.scope, row.agent);
        show('success', t('skillGrid.uninstalled', { name: row.name }));
      },
      { fail: (e) => t('errors.uninstallFailed', { error: errorText(e) }) },
    );
  // 装面形态只在全局位置有意义，且只在 weave 自己铺的个人技能根（`<h>-personal`）——
  // 项目技能按设计一律是副本，插件缓存是 CC 的，都不该标「副本」让人以为可改。
  const personal = row.source?.endsWith('-personal') ?? false;
  const showForm = row.scope === 'user' && personal && row.form !== undefined;
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
            onClick={() => (row.scope === 'user' ? setConfirming(true) : runUninstall())}
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
      {row.scope === 'user' && (
        <ConfirmDialog
          open={confirming}
          title={t('skillGrid.uninstallGlobalTitle')}
          message={t('skillGrid.uninstallGlobalConfirm', { name: row.name })}
          confirmLabel={t('common.confirm')}
          onConfirm={runUninstall}
          onClose={() => setConfirming(false)}
        />
      )}
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
  onCyclePluginState,
  onUninstallPlugin,
}: {
  /** Flat skill list (project mode). */
  skills?: SkillRow[];
  /** Grouped skills (global mode). When present, renders collapsible groups. */
  groups?: SkillGroup[];
  /** Global skill groups shown read-only beneath the project list (project
   * mode): tagged 全局, no pack uninstall；project/local 档启用覆写仍可写
   *  （拍板 7-7：项目下方两档控制）。 */
  globalGroupsReadOnly?: SkillGroup[];
  /** Update info already filtered to this mode's scope. */
  updates?: SkillUpdate[];
  empty: string;
  onUninstallSkill: (name: string, scope: AssetScope, agent?: AssetAgent) => void | Promise<void>;
  onOpenDetail: OpenDetailFn;
  /** 三档启用覆写循环（§4 ②推广）：交语义（档位 + 下一态），落盘与刷新由 App 统一。 */
  onCyclePluginState?: (
    runtime: PluginRuntime,
    key: string,
    scope: ToolScope,
    state: EnableOverride,
  ) => void | Promise<void>;
  /** 卸载 CC 插件包（harness 级，按注册键）；仅 claude-plugin 组消费。 */
  onUninstallPlugin?: (runtime: PluginRuntime, key: string) => void | Promise<void>;
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
        onCyclePluginState={onCyclePluginState}
        onUninstallPlugin={onUninstallPlugin}
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
          onCyclePluginState={onCyclePluginState}
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
  onCyclePluginState,
  onUninstallPlugin,
  readOnly,
}: {
  group: SkillGroup;
  collapsed: boolean;
  onToggle: () => void;
  findUpdate: (name: string) => SkillUpdate | undefined;
  onUninstallSkill: (name: string, scope: AssetScope, agent?: AssetAgent) => void | Promise<void>;
  onOpenDetail: OpenDetailFn;
  /** 三档启用覆写循环（§4 ②推广）：交语义（档位 + 下一态），落盘与刷新由 App 统一。 */
  onCyclePluginState?: (
    runtime: PluginRuntime,
    key: string,
    scope: ToolScope,
    state: EnableOverride,
  ) => void | Promise<void>;
  /** 卸载插件包（harness 级，按注册键）；无安装面的 harness（如 codex）门控在
   *  installSurface（installScopes 非空才出按钮）。 */
  onUninstallPlugin?: (runtime: PluginRuntime, key: string) => void | Promise<void>;
  readOnly?: boolean;
}) {
  const t = useT();
  const fb = useActionFeedback();
  const { show } = useToast();
  const [confirming, setConfirming] = useState(false);
  const isPlugin = group.source.endsWith('-plugin');
  const runtime = groupRuntime(group.source);
  // A pack is atomic — its plugin is either enabled or not — so this is either
  // all of its skills or none. Shown anyway so every level reads alike.
  const stats = countEffectiveSkills([group]);
  const canUninstallPack =
    isPlugin && !!group.installSurface && !!onUninstallPlugin && !readOnly && !!group.pluginKey;
  // 逐档循环钮：视图相关档由 CategoryDetail 按摆放元数据随组携带（全局 =
  // user，项目 = project/local），此处不写死档位。
  const canCycle =
    isPlugin && !!runtime && !!onCyclePluginState && (group.scopeStates?.length ?? 0) > 0;
  const packUninstallKey = `pack-uninstall:${group.pluginKey ?? '-'}`;
  const packUninstallState = fb.stateOf(packUninstallKey);
  const runUninstallPack = () => {
    if (!group.pluginKey || !onUninstallPlugin) return;
    void fb.run(
      packUninstallKey,
      async () => {
        await onUninstallPlugin(runtime!, group.pluginKey!);
        show('success', t('skillGrid.packUninstalled', { label: group.label }));
      },
      { fail: (e) => t('errors.uninstallFailed', { error: errorText(e) }) },
    );
  };
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
        <AgentBadge agent={skillSourceRuntime(group.source) ?? undefined} />
        <EffectivePill effective={stats.effective} total={stats.total} />
        {/* 逐档启用覆写循环钮（§4 ②推广）——真 <button>；外层行是 div 避免按钮嵌套。
         * 档位集随组由摆放元数据决定（全局 = user，项目 = project/local），
         * 循环序按行判据：三档三态 / 仅启用面布尔。 */}
        {canCycle && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {group.scopeStates!.map((s) => {
              const stateKey = `plugin-state:${runtime}:${group.pluginKey}:${s.scope}`;
              return (
                <button
                  key={s.scope}
                  type="button"
                  disabled={fb.stateOf(stateKey) === 'loading'}
                  onClick={(e) => {
                    e.stopPropagation();
                    void fb.run(
                      stateKey,
                      async () => {
                        await onCyclePluginState!(runtime!, group.pluginKey!, s.scope, nextStateOf(s));
                      },
                      { fail: (err) => t('errors.pluginToggleFailed', { error: errorText(err) }) },
                    );
                  }}
                  title={t('skillGrid.enableTip', {
                    scope: t(SCOPE_LABEL[s.scope]),
                    state: t(STATE_LABEL[s.enable]),
                  })}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium disabled:cursor-not-allowed [&_svg]:pointer-events-none',
                    s.enable === 'on'
                      ? 'bg-emerald-900/40 text-emerald-300'
                      : 'bg-neutral-800 text-neutral-500',
                  )}
                >
                  <FeedbackIcon
                    state={fb.stateOf(stateKey)}
                    className="h-3 w-3"
                    icon={<Power className="h-3 w-3" />}
                  />
                  {t(SCOPE_LABEL[s.scope])}·{t(STATE_LABEL[s.enable])}
                </button>
              );
            })}
          </span>
        )}
        {/* pack uninstall — harness 注册表级，市场副本保留、可重装。市场源被删后
         * ToolkitSection 不再列出该包，这里是唯一卸载口。 */}
        {canUninstallPack && (
          <button
            type="button"
            disabled={packUninstallState === 'loading'}
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(true);
            }}
            className={cn(
              'shrink-0 text-neutral-500 hover:text-red-400 disabled:cursor-not-allowed [&_svg]:pointer-events-none',
              !canCycle && 'ml-auto',
            )}
            title={t('skillGrid.uninstallPackTitle')}
          >
            <FeedbackIcon
              state={packUninstallState}
              className="h-3.5 w-3.5"
              icon={<Trash2 className="h-3.5 w-3.5" />}
            />
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
      <ConfirmDialog
        open={confirming}
        title={t('skillGrid.uninstallPackTitle')}
        message={t('skillGrid.uninstallPackConfirm', { key: group.pluginKey ?? '' })}
        confirmLabel={t('common.confirm')}
        onConfirm={runUninstallPack}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}

function GroupedSkills({
  groups,
  updates,
  onUninstallSkill,
  onOpenDetail,
  onCyclePluginState,
  onUninstallPlugin,
  readOnly,
}: {
  groups: SkillGroup[];
  updates?: SkillUpdate[];
  onUninstallSkill: (name: string, scope: AssetScope, agent?: AssetAgent) => void | Promise<void>;
  onOpenDetail: OpenDetailFn;
  onCyclePluginState?: (
    runtime: PluginRuntime,
    key: string,
    scope: ToolScope,
    state: EnableOverride,
  ) => void | Promise<void>;
  onUninstallPlugin?: (runtime: PluginRuntime, key: string) => void | Promise<void>;
  /** Read-only context (project view): no pack uninstall, cards tagged 全局；
   *  逐档启用覆写（project/local）仍可写（拍板 7-7：项目下方两档控制）。 */
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
                              canUninstall={!readOnly}
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
                          onCyclePluginState={onCyclePluginState}
                          onUninstallPlugin={onUninstallPlugin}
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
 * The `<harness-root>/skills/<name>/` shape is harness-agnostic (first path
 * segment = the harness root); the agent is taken from the server-set
 * `AssetEntry.agent` (never guessed from the path). Rows are keyed by
 * agent + name so two harnesses' same-named skills stay distinct. */
export function groupSkillRows(assets: AssetEntry[]): SkillRow[] {
  const m = new Map<string, { name: string; agent?: AssetAgent; files: AssetEntry[] }>();
  for (const a of assets) {
    const match = a.relPath.match(/^[^/]+\/skills\/([^/]+)\//);
    if (!match) continue;
    const name = match[1];
    const key = `${a.agent ?? ''}\u0000${name}`;
    const entry = m.get(key) ?? { name, agent: a.agent, files: [] as AssetEntry[] };
    entry.files.push(a);
    m.set(key, entry);
  }
  return [...m.values()]
    .map(({ name, agent, files }) => ({
      name,
      scope: 'project' as AssetScope,
      agent,
      files,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
