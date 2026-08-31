import { useCallback, useEffect, useMemo, useState } from 'react';
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import {
  api,
  type AssetEntry,
  type AssetChangeEvent,
  type AssetScope,
  type HookEventRow,
  type McpServerConfig,
  type ProjectRow,
  type SkillAsset,
  type StatuslineSource,
  type UpdateReport,
  type ProjectConfig,
  type GlobalSkillGroup,
  type PluginEnabledMap,
  type PluginRuntime,
  type GlobalSkillSource,
} from '@/lib/api';
import { ProjectList } from '@/components/ProjectList';
import { CategoryBar, type MainCategory, type CategoryBarData } from '@/components/CategoryBar';
import { CategoryDetail, type Mode } from '@/components/CategoryDetail';
import { SkillDetailDrawer } from '@/components/SkillDetailDrawer';
import { TaskView } from '@/components/TaskView';
import { LibraryPanel } from '@/components/LibraryPanel';
import { FileViewer } from '@/components/FileViewer';
import { Resizer } from '@/components/Resizer';
import { cn } from '@/lib/utils';

const LEFT_MIN = 176;
const LEFT_MAX = 320;
const RIGHT_MIN = 260;
const RIGHT_MAX = 440;
const TASK_MIN = 96;
const TASK_MAX = 520;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export default function App() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [selected, setSelected] = useState<ProjectRow | null>(null);
  const [globalMode, setGlobalMode] = useState(false);
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [hooks, setHooks] = useState<HookEventRow[]>([]);
  const [mcpServers, setMcpServers] = useState<{
    project: Record<string, McpServerConfig>;
    global: Record<string, McpServerConfig>;
  }>({ project: {}, global: {} });
  const [updates, setUpdates] = useState<UpdateReport | null>(null);
  const [globalSkillGroups, setGlobalSkillGroups] = useState<GlobalSkillGroup[]>([]);
  const [pluginEnabled, setPluginEnabled] = useState<PluginEnabledMap>({ claude: {}, codex: {} });
  const [projectConfig, setProjectConfig] = useState<ProjectConfig>({
    autoSync: false,
    lastSyncAt: null,
  });
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Main area
  const [mainCategory, setMainCategory] = useState<MainCategory>('skills');
  const [statuslineNonce, setStatuslineNonce] = useState(0);
  const [statuslineSource, setStatuslineSource] = useState<StatuslineSource | null>(null);
  const [drawerSkill, setDrawerSkill] = useState<{
    name: string;
    scope: AssetScope;
    source?: GlobalSkillSource;
    pluginKey?: string;
  } | null>(null);

  const [leftW, setLeftW] = useState<number>(() => {
    const v = Number(localStorage.getItem('weave:col-left'));
    return Number.isFinite(v) && v > 0 ? clamp(v, LEFT_MIN, LEFT_MAX) : 224;
  });
  const [rightW, setRightW] = useState<number>(() => {
    const v = Number(localStorage.getItem('weave:col-right'));
    return Number.isFinite(v) && v > 0 ? clamp(v, RIGHT_MIN, RIGHT_MAX) : 288;
  });
  const [taskH, setTaskH] = useState<number>(() => {
    const v = Number(localStorage.getItem('weave:task-height'));
    return Number.isFinite(v) && v > 0 ? clamp(v, TASK_MIN, TASK_MAX) : 176;
  });
  useEffect(() => localStorage.setItem('weave:col-left', String(leftW)), [leftW]);
  useEffect(() => localStorage.setItem('weave:col-right', String(rightW)), [rightW]);
  useEffect(() => localStorage.setItem('weave:task-height', String(taskH)), [taskH]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => {
    api.listProjects().then(setProjects).catch((e) => setError(String(e)));
  }, []);

  const refreshAssets = useCallback((p: ProjectRow) => {
    api.listAssets(p.path).then(setAssets).catch(() => {});
  }, []);

  const refreshMcp = useCallback((p: ProjectRow) => {
    api.listMcp(p.id).then(setMcpServers).catch(() => {});
  }, []);

  const refreshUpdates = useCallback((p: ProjectRow) => {
    api.listUpdates(p.id).then(setUpdates).catch(() => {});
  }, []);

  const refreshGlobalSkills = useCallback((p: ProjectRow) => {
    api.listGlobalSkills(p.id).then(setGlobalSkillGroups).catch(() => {});
  }, []);
  const refreshPluginEnabled = useCallback((p: ProjectRow) => {
    api.getPluginEnabled(p.id).then(setPluginEnabled).catch(() => {});
  }, []);

  const refreshConfig = useCallback((p: ProjectRow) => {
    api.getProjectConfig(p.id).then(setProjectConfig).catch(() => {});
  }, []);

  const loadProject = useCallback(
    (p: ProjectRow) => {
      setSelected(p);
      setGlobalMode(false);
      setAssets([]);
      setHooks([]);
      setMcpServers({ project: {}, global: {} });
      setUpdates(null);
      setGlobalSkillGroups([]);
      setPluginEnabled({ claude: {}, codex: {} });
      setSelectedFile(null);
      setDrawerSkill(null);
      setMainCategory('skills');
      setStatuslineSource(null);
      setError(null);
      api.listAssets(p.path).then(setAssets).catch((e) => setError(String(e)));
      api.listHooks(p.id).then(setHooks).catch((e) => setError(String(e)));
      refreshMcp(p);
      refreshUpdates(p);
      refreshGlobalSkills(p);
      refreshPluginEnabled(p);
      refreshConfig(p);
      api
        .getStatusline(p.id)
        .then((r) => setStatuslineSource(r.config.source))
        .catch(() => {});
    },
    [refreshMcp, refreshUpdates, refreshGlobalSkills, refreshPluginEnabled, refreshConfig],
  );

  /** Enter the global pseudo-project. Global data is machine-wide, so any
   * registered project can serve as the read anchor. */
  const selectGlobal = useCallback(() => {
    const anchor = selected ?? projects[0];
    if (!anchor) return;
    setGlobalMode(true);
    setSelectedFile(null);
    setDrawerSkill(null);
    setMainCategory('skills');
    setStatuslineSource('global');
    setError(null);
    refreshGlobalSkills(anchor);
    refreshPluginEnabled(anchor);
    refreshMcp(anchor);
    refreshUpdates(anchor);
  }, [selected, projects, refreshGlobalSkills, refreshPluginEnabled, refreshMcp, refreshUpdates]);

  // Land in the global pseudo-project once the project list arrives. The
  // "nothing selected yet" state (no project + not in global mode) is only
  // ever the boot state — every navigation path sets one or the other — so
  // this can't re-fire after the user navigates.
  useEffect(() => {
    if (globalMode || selected || projects.length === 0) return;
    selectGlobal();
  }, [globalMode, selected, projects, selectGlobal]);

  // Skill names already installed (project assets + machine-global set), for the
  // ✓ mark in the library panel. In global mode the project list is empty, so
  // the global set (all groups flattened) is what marks skills as installed.
  const installedSkillNames = useMemo(() => {
    const s = new Set<string>();
    for (const g of globalSkillGroups) for (const k of g.skills) s.add(k.name);
    for (const a of assets) {
      if (a.category === 'skill') {
        const n = a.relPath.match(/^\.claude\/skills\/([^/]+)\//)?.[1];
        if (n) s.add(n);
      }
    }
    return s;
  }, [globalSkillGroups, assets]);

  const assetCounts = useMemo(() => {
    const skillNames = new Set<string>();
    let command = 0;
    for (const a of assets) {
      if (a.category === 'skill') {
        const n = a.relPath.match(/^\.claude\/skills\/([^/]+)\//)?.[1];
        if (n) skillNames.add(n);
      } else if (a.category === 'command') {
        command++;
      }
    }
    const mcp = Object.keys(mcpServers.project).length + Object.keys(mcpServers.global).length;
    return { skill: skillNames.size, mcp, command };
  }, [assets, mcpServers]);

  const categoryData = useMemo<CategoryBarData>(() => {
    if (globalMode) {
      const globalSkillCount = globalSkillGroups.reduce((n, g) => n + g.skills.length, 0);
      return {
        skills: globalSkillCount,
        mcp: Object.keys(mcpServers.global).length,
        commands: 0,
        outdatedSkills: (updates?.skills ?? []).filter((u) => u.scope === 'global' && u.outdated).length,
        outdatedMcp: (updates?.mcp ?? []).filter((u) => u.scope === 'global' && u.outdated).length,
        autoSync: null,
        statuslineSource: 'global',
      };
    }
    const otherCount = assets.filter((a) => a.category !== 'skill' && a.category !== 'mcp').length;
    return {
      skills: assetCounts.skill,
      mcp: assetCounts.mcp,
      commands: otherCount,
      outdatedSkills: (updates?.skills ?? []).filter((u) => u.outdated).length,
      outdatedMcp: (updates?.mcp ?? []).filter((u) => u.outdated).length,
      autoSync: projectConfig.autoSync,
      statuslineSource,
    };
  }, [globalMode, globalSkillGroups, mcpServers, updates, assets, assetCounts, projectConfig, statuslineSource]);

  // SSE: live asset updates. The daemon's watch service detects the files
  // written by install/uninstall/statusline and pushes changes here automatically.
  useEffect(() => {
    const es = new EventSource(api.eventsUrl());
    es.onmessage = (ev) => {
      try {
        const change = JSON.parse(ev.data) as AssetChangeEvent;
        if (!selected || change.projectPath !== selected.path) return;
        setAssets((prev) => {
          if (change.kind === 'unlink') return prev.filter((a) => a.relPath !== change.relPath);
          const entry: AssetEntry = {
            absPath: change.absPath,
            relPath: change.relPath,
            category: change.category,
            mtimeMs: Date.now(),
          };
          const idx = prev.findIndex((a) => a.relPath === change.relPath);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = entry;
            return next;
          }
          return [...prev, entry];
        });
        if (change.category === 'mcp') refreshMcp(selected);
        if (change.category === 'skill') refreshGlobalSkills(selected);
        // any asset change may affect update availability
        refreshUpdates(selected);
      } catch {
        // ignore malformed frames
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do.
    };
    return () => es.close();
  }, [selected, refreshMcp, refreshUpdates, refreshGlobalSkills]);

  const handleInstallSkill = useCallback(
    async (skill: SkillAsset, scope: AssetScope = 'project') => {
      if (!selected && !globalMode) return;
      const target = selected ?? projects[0];
      if (!target) return;
      setError(null);
      const res = await api.install(target.id, {
        category: 'skill',
        name: skill.name,
        sourceDir: skill.dirPath,
        scope,
      });
      if (!res.ok) {
        setError(`Install failed: ${res.status} ${await res.text()}`);
        return;
      }
      refreshAssets(target);
      refreshGlobalSkills(target);
      refreshUpdates(target);
    },
    [selected, projects, globalMode, refreshAssets, refreshGlobalSkills, refreshUpdates],
  );

  const handleInstallMcp = useCallback(
    async (name: string, config: McpServerConfig, scope: AssetScope = 'project') => {
      if (!selected && !globalMode) return;
      const target = selected ?? projects[0];
      if (!target) return;
      setError(null);
      const res = await api.install(target.id, { category: 'mcp', name, mcpConfig: config, scope });
      if (!res.ok) {
        setError(`MCP install failed: ${res.status} ${await res.text()}`);
        return;
      }
      refreshAssets(target);
      refreshMcp(target);
      refreshUpdates(target);
    },
    [selected, projects, globalMode, refreshAssets, refreshMcp, refreshUpdates],
  );

  const handleUninstallSkill = useCallback(
    async (name: string, scope: AssetScope = 'project') => {
      const target = selected ?? projects[0];
      if (!target) return;
      setError(null);
      const res = await api.uninstall(target.id, { category: 'skill', name, scope });
      if (!res.ok) {
        setError(`Uninstall failed: ${res.status} ${await res.text()}`);
        return;
      }
      refreshAssets(target);
      refreshGlobalSkills(target);
      refreshUpdates(target);
    },
    [selected, projects, refreshAssets, refreshGlobalSkills, refreshUpdates],
  );

  const handleUninstallMcp = useCallback(
    async (name: string, scope: AssetScope = 'project') => {
      const target = selected ?? projects[0];
      if (!target) return;
      setError(null);
      const res = await api.uninstall(target.id, { category: 'mcp', name, scope });
      if (!res.ok) {
        setError(`MCP uninstall failed: ${res.status} ${await res.text()}`);
        return;
      }
      refreshAssets(target);
      refreshMcp(target);
      refreshUpdates(target);
    },
    [selected, projects, refreshAssets, refreshMcp, refreshUpdates],
  );

  const handleSyncAll = useCallback(async () => {
    const target = selected ?? projects[0];
    if (!target) return;
    setError(null);
    const res = await api.syncAll(target.id);
    if (!res.ok) {
      setError(`Sync failed: ${res.status} ${await res.text()}`);
      return;
    }
    refreshUpdates(target);
    refreshAssets(target);
  }, [selected, projects, refreshUpdates, refreshAssets]);

  const handleUpdateAsset = useCallback(
    async (category: 'skill' | 'mcp', name: string, scope: AssetScope) => {
      const target = selected ?? projects[0];
      if (!target) return;
      setError(null);
      const res = await api.updateAsset(target.id, { category, name, scope });
      if (!res.ok) {
        setError(`Update failed: ${res.status} ${await res.text()}`);
        return;
      }
      refreshUpdates(target);
      refreshAssets(target);
      if (category === 'mcp') refreshMcp(target);
      if (category === 'skill') refreshGlobalSkills(target);
    },
    [selected, projects, refreshUpdates, refreshAssets, refreshMcp, refreshGlobalSkills],
  );

  const handleToggleAutoSync = useCallback(async () => {
    if (!selected) return;
    setError(null);
    const next = { ...projectConfig, autoSync: !projectConfig.autoSync };
    setProjectConfig(next);
    const res = await api.putProjectConfig(selected.id, next);
    if (!res.ok) {
      setError(`Config update failed: ${res.status} ${await res.text()}`);
      refreshConfig(selected);
    }
  }, [selected, projectConfig, refreshConfig]);

  /** Toggle a plugin's enable state in the host config (Claude settings.json or
   * Codex config.toml). Optimistically updates the local map, then persists;
   * reloads groups on success so enable badges stay in sync. */
  const handleTogglePlugin = useCallback(
    async (runtime: PluginRuntime, key: string, enabled: boolean) => {
      const target = selected ?? projects[0];
      if (!target) return;
      setError(null);
      setPluginEnabled((prev) => ({ ...prev, [runtime]: { ...prev[runtime], [key]: enabled } }));
      const res = await api.putPluginEnabled(target.id, { runtime, key, enabled });
      if (!res.ok) {
        setError(`Plugin toggle failed: ${res.status} ${await res.text()}`);
        refreshPluginEnabled(target);
        return;
      }
      refreshGlobalSkills(target);
    },
    [selected, projects, refreshPluginEnabled, refreshGlobalSkills],
  );

  const selectCategory = useCallback((c: MainCategory) => {
    setMainCategory(c);
    if (c === 'personalization') setStatuslineNonce((n) => n + 1);
  }, []);

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || over.id !== 'project-assets') return;
    const data = active.data.current as { sourceDir?: string; name?: string } | undefined;
    if (data?.sourceDir && data?.name) {
      void handleInstallSkill({ name: data.name, dirPath: data.sourceDir } as SkillAsset);
    }
  }

  // Drawer data for the open skill (project-scope files; global rows have none).
  const drawerFiles = useMemo(() => {
    if (!drawerSkill || drawerSkill.scope === 'global') return [];
    const prefix = `.claude/skills/${drawerSkill.name}/`;
    return assets.filter((a) => a.relPath.startsWith(prefix));
  }, [drawerSkill, assets]);

  const drawerUpdate = useMemo(
    () =>
      drawerSkill
        ? updates?.skills.find((u) => u.name === drawerSkill.name && u.scope === drawerSkill.scope)
        : undefined,
    [drawerSkill, updates],
  );

  const mode: Mode = globalMode ? 'global' : 'project';
  const activeProject = selected ?? projects[0];
  const noAnchor = globalMode && !activeProject;

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="h-screen p-4 bg-neutral-950">
        <div className="h-full flex flex-col rounded-2xl border border-white/[0.08] bg-neutral-900/40 shadow-mac overflow-hidden">
          <div className="h-11 shrink-0 flex items-center gap-3 px-4 border-b border-white/[0.06] frosted">
            <TrafficLight />
            <span className="text-sm font-semibold tracking-tight text-neutral-200">Weave</span>
            <span className="text-xs text-neutral-500">{projects.length} projects</span>
          </div>

          <div className="flex flex-1 overflow-hidden">
            {/* Level 1 — global config (pseudo-project) + projects */}
            <aside
              style={{ width: leftW }}
              className="shrink-0 border-r border-white/[0.06] frosted overflow-y-auto"
            >
              <ProjectList
                projects={projects}
                selectedId={selected?.id}
                globalActive={globalMode}
                onSelect={loadProject}
                onSelectGlobal={selectGlobal}
              />
            </aside>
            <Resizer onResize={(d) => setLeftW((w) => clamp(w + d, LEFT_MIN, LEFT_MAX))} title="拖拽调整左侧宽度" />

            {/* Level 2 + 3 — categories + detail */}
            <main className="flex-1 flex flex-col overflow-hidden relative">
              {error && <p className="text-red-400 text-xs px-3 py-1">{error}</p>}
              {activeProject ? (
                <>
                  <div className="px-4 py-2 border-b border-white/[0.06] flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <h2 className="text-sm font-semibold truncate">
                        {globalMode ? '全局配置' : (selected?.name ?? '')}
                      </h2>
                      <p className="text-[11px] text-neutral-500 truncate">
                        {globalMode ? '机器级 harness 默认模板 · 作用于所有项目' : (selected?.path ?? '')}
                      </p>
                    </div>
                    {!globalMode && updates && updates.available > 0 && (
                      <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-orange-900/40 text-orange-300 px-2.5 py-1 text-xs font-medium">
                        {updates.available} update{updates.available > 1 ? 's' : ''}
                      </span>
                    )}
                    {!globalMode && updates && updates.available > 0 && (
                      <button
                        onClick={handleSyncAll}
                        className="shrink-0 inline-flex items-center gap-1 rounded-full bg-blue-900/40 text-blue-300 px-2.5 py-1 text-xs font-medium hover:bg-blue-900/60"
                      >
                        Sync all
                      </button>
                    )}
                    {!globalMode && selected && (
                      <button
                        onClick={handleToggleAutoSync}
                        className={cn(
                          'shrink-0 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
                          projectConfig.autoSync
                            ? 'bg-emerald-900/40 text-emerald-300'
                            : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700',
                        )}
                      >
                        Auto-sync {projectConfig.autoSync ? 'ON' : 'OFF'}
                      </button>
                    )}
                  </div>

                  <CategoryBar
                    category={mainCategory}
                    onSelect={selectCategory}
                    data={categoryData}
                  />

                  <div className="flex-1 overflow-y-auto p-3 relative">
                    {noAnchor ? (
                      <p className="text-xs text-neutral-500">
                        需要至少注册一个项目作为全局数据源。
                      </p>
                    ) : (
                      <CategoryDetail
                        projectId={activeProject!.id}
                        mode={mode}
                        category={mainCategory}
                        statuslineNonce={statuslineNonce}
                        assets={assets}
                        mcpServers={mcpServers}
                        updates={updates}
                        globalSkillGroups={globalSkillGroups}
                        pluginEnabled={pluginEnabled}
                        statuslineSource={statuslineSource}
                        onUninstallSkill={handleUninstallSkill}
                        onUninstallMcp={handleUninstallMcp}
                        onTogglePlugin={handleTogglePlugin}
                        onOpenFile={setSelectedFile}
                        onOpenSkillDetail={(name, sc, source, pluginKey) =>
                          setDrawerSkill({ name, scope: sc, source, pluginKey })
                        }
                      />
                    )}
                    {selectedFile && (
                      <div className="absolute inset-0 z-20 frosted-strong">
                        <FileViewer
                          projectId={activeProject!.id}
                          relPath={selectedFile}
                          onClose={() => setSelectedFile(null)}
                        />
                      </div>
                    )}
                  </div>

                  <Resizer
                    orientation="vertical"
                    onResize={(d) => setTaskH((h) => clamp(h - d, TASK_MIN, TASK_MAX))}
                    title="拖拽调整任务区高度"
                  />
                  <div
                    style={{ height: taskH }}
                    className="shrink-0 border-t border-white/[0.06] overflow-y-auto p-3"
                  >
                    <TaskView events={hooks} />
                  </div>
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm">
                  Select a project
                </div>
              )}

              {/* Skill detail drawer overlays the main column */}
              {drawerSkill && (
                <SkillDetailDrawer
                  key={`${drawerSkill.scope}-${drawerSkill.name}`}
                  projectId={activeProject?.id ?? 0}
                  name={drawerSkill.name}
                  scope={drawerSkill.scope}
                  source={drawerSkill.source}
                  pluginKey={drawerSkill.pluginKey}
                  files={drawerFiles}
                  readOnly={!globalMode && drawerSkill.scope === 'global'}
                  outdated={drawerUpdate?.outdated ?? false}
                  custom={drawerUpdate?.custom ?? false}
                  onUninstall={() => {
                    void handleUninstallSkill(drawerSkill.name, drawerSkill.scope);
                    setDrawerSkill(null);
                  }}
                  onClose={() => setDrawerSkill(null)}
                />
              )}
            </main>

            <Resizer onResize={(d) => setRightW((w) => clamp(w + d, RIGHT_MIN, RIGHT_MAX))} title="拖拽调整右侧宽度" />

            {/* Right — installable asset library, scope follows the active context */}
            <aside
              style={{ width: rightW }}
              className="shrink-0 border-l border-white/[0.06] frosted overflow-hidden"
            >
              {activeProject ? (
                <LibraryPanel
                  installedSkillNames={installedSkillNames}
                  onInstallSkill={handleInstallSkill}
                  onInstallMcp={handleInstallMcp}
                  updates={updates}
                  onUpdateAsset={handleUpdateAsset}
                  category={mainCategory}
                  scope={mode}
                />
              ) : (
                <div className="p-3 text-xs text-neutral-500">
                  Select a project to install assets into.
                </div>
              )}
            </aside>
          </div>
        </div>
      </div>
    </DndContext>
  );
}

function TrafficLight() {
  return (
    <div className="flex gap-1.5 shrink-0">
      <span className="h-3 w-3 rounded-full bg-mac-red" />
      <span className="h-3 w-3 rounded-full bg-mac-yellow" />
      <span className="h-3 w-3 rounded-full bg-mac-green" />
    </div>
  );
}
