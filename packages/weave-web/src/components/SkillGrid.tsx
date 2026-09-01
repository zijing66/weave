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
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Trash2,
  FileCode,
  ChevronDown,
  ChevronRight,
  Power,
  FolderTree,
  ChevronsUpDown,
  ChevronsDownUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';

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
  onUninstallSkill: (name: string, scope: AssetScope, agent?: AssetAgent) => void;
  onOpenDetail: OpenDetailFn;
}) {
  return (
    <Card>
      <CardHeader className="items-center gap-2">
        <button
          onClick={() =>
            onOpenDetail(row.name, row.scope, row.source, row.pluginKey, row.agent)
          }
          className="flex items-center gap-2 text-left flex-1 min-w-0"
          title={`Open ${row.name} detail`}
        >
          <FileCode className="h-3.5 w-3.5 shrink-0 text-blue-400" />
          <CardTitle className="truncate">{row.name}</CardTitle>
          {row.agent === 'codex' && (
            <Badge variant="other" className="ml-1">
              Codex
            </Badge>
          )}
          {readOnly && (
            <Badge variant="settings" className="ml-1">
              全局
            </Badge>
          )}
          {row.files.length > 0 && (
            <Badge variant="skill" className="ml-1">
              {row.files.length}
            </Badge>
          )}
          {update?.outdated && (
            <Badge variant="warning" className="ml-1">
              update
            </Badge>
          )}
          {update?.custom && (
            <Badge variant="other" className="ml-1">
              custom
            </Badge>
          )}
        </button>
        {canUninstall && !readOnly && (
          <button
            onClick={() => onUninstallSkill(row.name, row.scope, row.agent)}
            className="text-neutral-500 hover:text-red-400 shrink-0"
            title={`Uninstall ${row.name}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
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
  onUninstallSkill: (name: string, scope: AssetScope, agent?: AssetAgent) => void;
  onOpenDetail: OpenDetailFn;
  onTogglePlugin?: (runtime: PluginRuntime, key: string, enabled: boolean) => void;
}) {
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
          <h2 className="text-xs font-semibold text-neutral-400 uppercase">Skills ({skills!.length})</h2>
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
  onUninstallSkill: (name: string, scope: AssetScope, agent?: AssetAgent) => void;
  onOpenDetail: OpenDetailFn;
  onTogglePlugin?: (runtime: PluginRuntime, key: string, enabled: boolean) => void;
  /** Read-only context (project view): no enable toggle, cards tagged 全局. */
  readOnly?: boolean;
}) {
  const findUpdate = (name: string) => updates?.find((u) => u.name === name);
  // One collapse flag per group, keyed by source+pluginKey (stable across re-renders).
  const groupKeys = useMemo(
    () => groups.map((g) => `${g.source}:${g.pluginKey ?? '-'}`),
    [groups],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const anyCollapsed = collapsed.size > 0;
  /** One button that flips between expand-all and collapse-all. */
  const toggleAll = () =>
    anyCollapsed ? setCollapsed(new Set()) : setCollapsed(new Set(groupKeys));

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-semibold text-neutral-400 uppercase">
          {readOnly ? '全局生效' : '全局 Skills'} ({groups.reduce((n, g) => n + g.skills.length, 0)})
          {readOnly && <span className="ml-1 text-[10px] text-neutral-600 normal-case">只读</span>}
        </h2>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={toggleAll}
            className="inline-flex items-center gap-1 rounded-full bg-neutral-800 text-neutral-400 px-2 py-0.5 text-[11px] hover:bg-neutral-700"
            title={anyCollapsed ? '展开全部分组' : '折叠全部分组'}
          >
            {anyCollapsed ? (
              <ChevronsUpDown className="h-3 w-3" />
            ) : (
              <ChevronsDownUp className="h-3 w-3" />
            )}
            {anyCollapsed ? '全部展开' : '全部折叠'}
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {groups.map((g, i) => {
          const key = groupKeys[i];
          const isCollapsed = collapsed.has(key);
          const runtime = PLUGIN_RUNTIME[g.source];
          const isPlugin = g.source.endsWith('-plugin');
          const runtimeLabel = g.source.startsWith('claude') ? 'Claude' : 'Codex';
          return (
            <div
              key={key}
              className="rounded-xl border border-white/[0.06] bg-neutral-900/40 overflow-hidden"
            >
              <div
                role="button"
                tabIndex={0}
                onClick={() => toggle(key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggle(key);
                  }
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.02] cursor-pointer"
              >
                {isCollapsed ? (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                )}
                <FolderTree className="h-3.5 w-3.5 shrink-0 text-blue-400" />
                <span className="text-xs font-semibold text-neutral-300 truncate">{g.label}</span>
                {/* prominent source tag: 插件 / 本地 + runtime */}
                <Badge variant={isPlugin ? 'mcp' : 'skill'} className="ml-1">
                  {isPlugin ? '插件' : '本地'}
                </Badge>
                <Badge variant="other">
                  {runtimeLabel}
                </Badge>
                <Badge variant="other">
                  {g.skills.length}
                </Badge>
                {/* plugin enable toggle — a real <button>; the outer row is a div to avoid nested buttons.
                 * Hidden in read-only (project) mode: global config is not edited from a project view. */}
                {isPlugin && runtime && onTogglePlugin && !readOnly && g.enabled !== undefined && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePlugin(runtime, g.pluginKey!, !g.enabled);
                    }}
                    title={`${g.enabled ? '已启用' : '已禁用'} — 点击切换`}
                    className={cn(
                      'ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                      g.enabled
                        ? 'bg-emerald-900/40 text-emerald-300'
                        : 'bg-neutral-800 text-neutral-500',
                    )}
                  >
                    <Power className="h-3 w-3" />
                    {g.enabled ? 'ON' : 'OFF'}
                  </button>
                )}
              </div>
              {!isCollapsed && (
                <div className="px-3 pb-3 pt-1">
                  {g.skills.length === 0 ? (
                    <p className="text-xs text-neutral-600 py-2">无</p>
                  ) : (
                    <div className="grid grid-cols-2 gap-3 items-start">
                      {g.skills.map((s) => (
                        <SkillCard
                          key={`${s.scope}-${s.name}`}
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
