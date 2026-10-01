import { useCallback, useEffect, useMemo, useState } from 'react';
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import {
  api,
  type AssetEntry,
  type AssetAgent,
  type AssetChangeEvent,
  type AssetScope,
  type FileAssetCategory,
  type FileAssetTemplate,
  type HookEventRow,
  type McpServerConfig,
  type McpServerMap,
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
import { type FileAssetRow } from '@/components/FileAssetTree';
import { SkillDetailDrawer } from '@/components/SkillDetailDrawer';
import { TaskView } from '@/components/TaskView';
import { LibraryPanel } from '@/components/LibraryPanel';
import { FileViewer } from '@/components/FileViewer';
import { Resizer } from '@/components/Resizer';
import { SettingsModal } from '@/components/SettingsModal';
import { cn } from '@/lib/utils';
import { countEffectiveSkills } from '@/lib/skill-stats';
import { useT } from '@/i18n/I18nProvider';
import { Settings } from 'lucide-react';

const LEFT_MIN = 176;
const LEFT_MAX = 320;
const RIGHT_MIN = 260;
const RIGHT_MAX = 440;
const TASK_MIN = 96;
const TASK_MAX = 520;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export default function App() {
  const t = useT();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [selected, setSelected] = useState<ProjectRow | null>(null);
  const [globalMode, setGlobalMode] = useState(false);
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  // Machine-level harness files (~/.claude, ~/.codex) — fetched lazily, only
  // when the global 文件资产 page is opened.
  const [globalAssets, setGlobalAssets] = useState<AssetEntry[]>([]);
  const [hooks, setHooks] = useState<HookEventRow[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerMap>({
    project: {},
    global: {},
    codex: {},
  });
  const [updates, setUpdates] = useState<UpdateReport | null>(null);
  const [globalSkillGroups, setGlobalSkillGroups] = useState<GlobalSkillGroup[]>([]);
  const [pluginEnabled, setPluginEnabled] = useState<PluginEnabledMap>({ claude: {}, codex: {} });
  const [projectConfig, setProjectConfig] = useState<ProjectConfig>({
    autoSync: false,
    lastSyncAt: null,
  });
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Main area
  const [mainCategory, setMainCategory] = useState<MainCategory>('skills');
  const [statuslineNonce, setStatuslineNonce] = useState(0);
  const [statuslineSource, setStatuslineSource] = useState<StatuslineSource | null>(null);
  const [drawerSkill, setDrawerSkill] = useState<{
    name: string;
    scope: AssetScope;
    source?: GlobalSkillSource;
    pluginKey?: string;
    agent?: AssetAgent;
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
      setMcpServers({ project: {}, global: {}, codex: {} });
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
    setStatuslineSource(null); // no source badge/sub-text in the template view
    setError(null);
    // One bounded whitelist walk of ~/.claude + ~/.codex — cheap enough to
    // run on every entry, and it keeps the 文件资产 card count honest.
    api
      .listGlobalFileAssets()
      .then(setGlobalAssets)
      .catch((e) => setError(String(e)));
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
        const n = a.relPath.match(/^(?:\.claude|\.codex)\/skills\/([^/]+)\//)?.[1];
        if (n) s.add(n);
      }
    }
    return s;
  }, [globalSkillGroups, assets]);

  const assetCounts = useMemo(() => {
    const skillNames = new Set<string>();
    for (const a of assets) {
      if (a.category === 'skill') {
        const n = a.relPath.match(/^(?:\.claude|\.codex)\/skills\/([^/]+)\//)?.[1];
        if (n) skillNames.add(n);
      }
    }
    const mcp = Object.keys(mcpServers.project).length + Object.keys(mcpServers.global).length;
    return { skill: skillNames.size, mcp };
  }, [assets, mcpServers]);

  // Machine-wide skills actually in effect: a plugin group that is switched
  // off contributes nothing. The enable state is re-derived from the live map
  // (same rule as the section pills in CategoryDetail) rather than trusting
  // the group's own `enabled`, which the server can have stale.
  const effectiveGlobalSkills = useMemo(
    () =>
      countEffectiveSkills(
        globalSkillGroups.map((g) => {
          const runtime: PluginRuntime | null = g.source.startsWith('claude')
            ? 'claude'
            : g.source.startsWith('codex')
              ? 'codex'
              : null;
          const enabled =
            g.pluginKey && runtime ? pluginEnabled[runtime][g.pluginKey] ?? false : undefined;
          return { enabled, skills: g.skills };
        }),
      ).effective,
    [globalSkillGroups, pluginEnabled],
  );

  const categoryData = useMemo<CategoryBarData>(() => {
    // Codex MCP servers live in ~/.codex/config.toml, so they belong to the
    // machine, not the scope — both views count them (their tab is visible in
    // both).
    const codexMcp = Object.keys(mcpServers.codex).length;
    if (globalMode) {
      return {
        skills: effectiveGlobalSkills,
        mcp: Object.keys(mcpServers.global).length + codexMcp,
        // machine-level file assets (~/.claude, ~/.codex) — the global tree
        commands: globalAssets.length,
        outdatedSkills: (updates?.skills ?? []).filter((u) => u.scope === 'global' && u.outdated).length,
        outdatedMcp: (updates?.mcp ?? []).filter((u) => u.scope === 'global' && u.outdated).length,
        // The global view IS the template — a 跟随全局 badge would be noise.
        statuslineSource: null,
      };
    }
    const otherCount = assets.filter((a) => a.category !== 'skill' && a.category !== 'mcp').length;
    return {
      // project skills + machine-wide skills in effect — the page shows both
      // sections, so the card counts what they contain together
      skills: assetCounts.skill + effectiveGlobalSkills,
      // this view's Claude scope (project), matching what the MCP page shows
      // under the Claude tab, plus the machine-wide Codex surface
      mcp: Object.keys(mcpServers.project).length + codexMcp,
      commands: otherCount,
      outdatedSkills: (updates?.skills ?? []).filter((u) => u.outdated).length,
      outdatedMcp: (updates?.mcp ?? []).filter((u) => u.outdated).length,
      statuslineSource,
    };
  }, [globalMode, globalSkillGroups, mcpServers, updates, assets, globalAssets, assetCounts, pluginEnabled, effectiveGlobalSkills, projectConfig, statuslineSource]);

  // Asset entry backing the open file preview — supplies the agent badge in
  // the drawer header. Missing rows (cache lag) fall back to plain Claude.
  const selectedAsset = useMemo<AssetEntry | null>(() => {
    if (!selectedFile) return null;
    const pool = globalMode ? globalAssets : assets;
    return pool.find((a) => a.relPath === selectedFile) ?? null;
  }, [globalMode, globalAssets, assets, selectedFile]);


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
            agent: change.agent,
            ...(change.isSymlink ? { isSymlink: true } : {}),
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
    async (skill: SkillAsset, scope: AssetScope = 'project', agent: AssetAgent = 'claude') => {
      if (!selected && !globalMode) return;
      const target = selected ?? projects[0];
      if (!target) return;
      setError(null);
      const res = await api.install(target.id, {
        category: 'skill',
        name: skill.name,
        sourceDir: skill.dirPath,
        scope,
        agent,
      });
      if (!res.ok) {
        setError(t('errors.installFailed', { error: `${res.status} ${await res.text()}` }));
        return;
      }
      refreshAssets(target);
      refreshGlobalSkills(target);
      refreshUpdates(target);
    },
    [t, selected, projects, globalMode, refreshAssets, refreshGlobalSkills, refreshUpdates],
  );

  /** Install a single-file asset (command / agent / workflow / rule / output-style). */
  const handleInstallFileAsset = useCallback(
    async (file: FileAssetTemplate, scope: AssetScope = 'project') => {
      if (!selected && !globalMode) return;
      const target = selected ?? projects[0];
      if (!target) return;
      setError(null);
      const res = await api.install(target.id, {
        category: file.category,
        name: file.name,
        sourceFile: file.filePath,
        scope,
      });
      if (!res.ok) {
        setError(t('errors.installFailed', { error: `${res.status} ${await res.text()}` }));
        return;
      }
      refreshAssets(target);
      refreshUpdates(target);
    },
    [t, selected, projects, globalMode, refreshAssets, refreshUpdates],
  );

  const handleInstallMcp = useCallback(
    async (
      name: string,
      config: McpServerConfig,
      scope: AssetScope = 'project',
      agent: AssetAgent = 'claude',
    ) => {
      if (!selected && !globalMode) return;
      const target = selected ?? projects[0];
      if (!target) return;
      setError(null);
      // Codex MCP servers only live in ~/.codex/config.toml (user-level).
      const effectiveScope = agent === 'codex' ? 'global' : scope;
      const res = await api.install(target.id, {
        category: 'mcp',
        name,
        mcpConfig: config,
        scope: effectiveScope,
        agent,
      });
      if (!res.ok) {
        setError(t('errors.mcpInstallFailed', { error: `${res.status} ${await res.text()}` }));
        return;
      }
      refreshAssets(target);
      refreshMcp(target);
      refreshUpdates(target);
    },
    [t, selected, projects, globalMode, refreshAssets, refreshMcp, refreshUpdates],
  );

  const handleUninstallSkill = useCallback(
    async (name: string, scope: AssetScope = 'project', agent?: AssetAgent) => {
      const target = selected ?? projects[0];
      if (!target) return;
      setError(null);
      const res = await api.uninstall(target.id, {
        category: 'skill',
        name,
        scope,
        agent: agent ?? 'claude',
      });
      if (!res.ok) {
        setError(t('errors.uninstallFailed', { error: `${res.status} ${await res.text()}` }));
        return;
      }
      refreshAssets(target);
      refreshGlobalSkills(target);
      refreshUpdates(target);
    },
    [t, selected, projects, refreshAssets, refreshGlobalSkills, refreshUpdates],
  );

  const handleUninstallFileAsset = useCallback(
    async (row: FileAssetRow, scope: AssetScope = 'project') => {
      const target = selected ?? projects[0];
      if (!target) return;
      setError(null);
      const res = await api.uninstall(target.id, {
        category: row.category as FileAssetCategory,
        name: row.name,
        scope,
        ...(row.agent ? { agent: row.agent } : {}),
      });
      if (!res.ok) {
        setError(t('errors.uninstallFailed', { error: `${res.status} ${await res.text()}` }));
        return;
      }
      refreshAssets(target);
      refreshUpdates(target);
    },
    [t, selected, projects, refreshAssets, refreshUpdates],
  );

  const handleUninstallMcp = useCallback(
    async (name: string, scope: AssetScope = 'project', agent?: AssetAgent) => {
      const target = selected ?? projects[0];
      if (!target) return;
      setError(null);
      // Codex servers are user-level — uninstall always targets the TOML file.
      const res = await api.uninstall(target.id, {
        category: 'mcp',
        name,
        scope: agent === 'codex' ? 'global' : scope,
        ...(agent ? { agent } : {}),
      });
      if (!res.ok) {
        setError(t('errors.mcpUninstallFailed', { error: `${res.status} ${await res.text()}` }));
        return;
      }
      refreshAssets(target);
      refreshMcp(target);
      refreshUpdates(target);
    },
    [t, selected, projects, refreshAssets, refreshMcp, refreshUpdates],
  );

  const handleSyncAll = useCallback(async () => {
    const target = selected ?? projects[0];
    if (!target) return;
    setError(null);
    const res = await api.syncAll(target.id);
    if (!res.ok) {
      setError(t('errors.syncFailed', { error: `${res.status} ${await res.text()}` }));
      return;
    }
    refreshUpdates(target);
    refreshAssets(target);
  }, [t, selected, projects, refreshUpdates, refreshAssets]);

  const handleUpdateAsset = useCallback(
    async (
      category: 'skill' | 'mcp' | FileAssetCategory,
      name: string,
      scope: AssetScope,
      agent?: AssetAgent,
    ) => {
      const target = selected ?? projects[0];
      if (!target) return;
      setError(null);
      const res = await api.updateAsset(target.id, {
        category,
        name,
        scope,
        ...(category === 'skill' || category === 'mcp' ? { agent: agent ?? 'claude' } : {}),
      });
      if (!res.ok) {
        setError(t('errors.updateFailed', { error: `${res.status} ${await res.text()}` }));
        return;
      }
      refreshUpdates(target);
      refreshAssets(target);
      if (category === 'mcp') refreshMcp(target);
      if (category === 'skill') refreshGlobalSkills(target);
    },
    [t, selected, projects, refreshUpdates, refreshAssets, refreshMcp, refreshGlobalSkills],
  );

  const handleToggleAutoSync = useCallback(async () => {
    if (!selected) return;
    setError(null);
    const next = { ...projectConfig, autoSync: !projectConfig.autoSync };
    setProjectConfig(next);
    const res = await api.putProjectConfig(selected.id, next);
    if (!res.ok) {
      setError(t('errors.configUpdateFailed', { error: `${res.status} ${await res.text()}` }));
      refreshConfig(selected);
    }
  }, [t, selected, projectConfig, refreshConfig]);

  /** Context-menu action: open a project's folder in the file manager / terminal. */
  const handleOpenProject = useCallback(
    async (p: ProjectRow, target: 'explorer' | 'terminal') => {
      setError(null);
      try {
        await api.openProject(p.id, target);
      } catch (e) {
        setError(t('errors.openFailed', { error: e instanceof Error ? e.message : String(e) }));
      }
    },
    [t],
  );

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
        setError(t('errors.pluginToggleFailed', { error: `${res.status} ${await res.text()}` }));
        refreshPluginEnabled(target);
        return;
      }
      refreshGlobalSkills(target);
    },
    [t, selected, projects, refreshPluginEnabled, refreshGlobalSkills],
  );

  const selectCategory = useCallback((c: MainCategory) => {
    setMainCategory(c);
    if (c === 'personalization') setStatuslineNonce((n) => n + 1);
  }, []);

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || over.id !== 'project-assets') return;
    const data = active.data.current as
      | { sourceDir?: string; name?: string; agent?: AssetAgent }
      | undefined;
    if (data?.sourceDir && data?.name) {
      void handleInstallSkill(
        { name: data.name, dirPath: data.sourceDir } as SkillAsset,
        'project',
        data.agent ?? 'claude',
      );
    }
  }

  // Drawer data for the open skill (project-scope files; global rows have none).
  const drawerFiles = useMemo(() => {
    if (!drawerSkill || drawerSkill.scope === 'global') return [];
    const root = drawerSkill.agent === 'codex' ? '.codex' : '.claude';
    const prefix = `${root}/skills/${drawerSkill.name}/`;
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
            <span className="text-xs text-neutral-500">
              {t('app.projectCount', { n: projects.length })}
            </span>
            <button
              onClick={() => setSettingsOpen(true)}
              className="ml-auto p-1.5 rounded-lg text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60 transition-colors"
              title={t('app.settingsTooltip')}
            >
              <Settings className="h-4 w-4" />
            </button>
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
                onOpenExplorer={(p) => void handleOpenProject(p, 'explorer')}
                onOpenTerminal={(p) => void handleOpenProject(p, 'terminal')}
              />
            </aside>
            <Resizer onResize={(d) => setLeftW((w) => clamp(w + d, LEFT_MIN, LEFT_MAX))} title={t('app.resizeLeft')} />

            {/* Level 2 + 3 — categories + detail */}
            <main className="flex-1 flex flex-col overflow-hidden relative">
              {error && <p className="text-red-400 text-xs px-3 py-1">{error}</p>}
              {activeProject ? (
                <>
                  <div className="px-4 py-2 border-b border-white/[0.06] flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <h2 className="text-sm font-semibold truncate">
                        {globalMode ? t('app.globalTitle') : (selected?.name ?? '')}
                      </h2>
                      <p className="text-[11px] text-neutral-500 truncate">
                        {globalMode ? t('app.globalSubtitle') : (selected?.path ?? '')}
                      </p>
                    </div>
                    {!globalMode && updates && updates.available > 0 && (
                      <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-orange-900/40 text-orange-300 px-2.5 py-1 text-xs font-medium">
                        {updates.available === 1
                          ? t('app.updateCountOne')
                          : t('app.updateCount', { n: updates.available })}
                      </span>
                    )}
                    {!globalMode && updates && updates.available > 0 && (
                      <button
                        onClick={handleSyncAll}
                        title={t('app.syncAllTooltip', { n: updates.available })}
                        className="shrink-0 inline-flex items-center gap-1 rounded-full bg-blue-900/40 text-blue-300 px-2.5 py-1 text-xs font-medium hover:bg-blue-900/60"
                      >
                        {t('app.syncAll')}
                      </button>
                    )}
                    {!globalMode && selected && (
                      <>
                        {/* Both controls below run the same server-side syncAll,
                            so one chip states the scope for the pair. */}
                        <span
                          className="shrink-0 rounded-full bg-neutral-800/60 text-neutral-500 px-2.5 py-1 text-[11px]"
                          title={t('app.scopeCoverageTooltip')}
                        >
                          {t('app.scopeCoverageChip')}
                        </span>
                        <button
                          onClick={handleToggleAutoSync}
                          aria-pressed={projectConfig.autoSync}
                          title={
                            projectConfig.autoSync
                              ? t('app.autoSyncOnTooltip')
                              : t('app.autoSyncOffTooltip')
                          }
                          className={cn(
                            'shrink-0 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
                            projectConfig.autoSync
                              ? 'bg-emerald-900/40 text-emerald-300'
                              : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700',
                          )}
                        >
                          {projectConfig.autoSync ? t('app.autoSyncOn') : t('app.autoSyncOff')}
                        </button>
                      </>
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
                        {t('app.needProjectAnchor')}
                      </p>
                    ) : (
                      <CategoryDetail
                        projectId={activeProject!.id}
                        mode={mode}
                        category={mainCategory}
                        statuslineNonce={statuslineNonce}
                        assets={assets}
                        globalAssets={globalAssets}
                        mcpServers={mcpServers}
                        updates={updates}
                        globalSkillGroups={globalSkillGroups}
                        pluginEnabled={pluginEnabled}
                        statuslineSource={statuslineSource}
                        onUninstallSkill={handleUninstallSkill}
                        onUninstallMcp={handleUninstallMcp}
                        onUninstallFileAsset={handleUninstallFileAsset}
                        onTogglePlugin={handleTogglePlugin}
                        onOpenFile={(relPath) => {
                          setSelectedFile(relPath);
                          setDrawerSkill(null);
                        }}
                        onOpenSkillDetail={(name, sc, source, pluginKey, agent) => {
                          setSelectedFile(null);
                          setDrawerSkill({ name, scope: sc, source, pluginKey, agent });
                        }}
                      />
                    )}
                  </div>

                  <Resizer
                    orientation="vertical"
                    onResize={(d) => setTaskH((h) => clamp(h - d, TASK_MIN, TASK_MAX))}
                    title={t('app.resizeTaskHeight')}
                  />
                  <div
                    style={{ height: taskH }}
                    className="shrink-0 border-t border-white/[0.06] overflow-y-auto p-3"
                  >
                    <TaskView key={activeProject.id} events={hooks} />
                  </div>
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm">
                  {t('app.selectProject')}
                </div>
              )}

              {/* File preview drawer — same right-side slot as the skill drawer */}
              {selectedFile && activeProject && (
                <FileViewer
                  projectId={activeProject.id}
                  relPath={selectedFile}
                  global={globalMode}
                  agent={selectedAsset ? (selectedAsset.agent ?? 'claude') : undefined}
                  onClose={() => setSelectedFile(null)}
                />
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
                  agent={drawerSkill.agent}
                  files={drawerFiles}
                  readOnly={!globalMode && drawerSkill.scope === 'global'}
                  outdated={drawerUpdate?.outdated ?? false}
                  custom={drawerUpdate?.custom ?? false}
                  onUninstall={() => {
                    void handleUninstallSkill(drawerSkill.name, drawerSkill.scope, drawerSkill.agent);
                    setDrawerSkill(null);
                  }}
                  onClose={() => setDrawerSkill(null)}
                />
              )}
            </main>

            {/* Sign matters: this handle sits to the LEFT of the panel, so
                dragging left (negative delta) has to make it wider. */}
            <Resizer onResize={(d) => setRightW((w) => clamp(w - d, RIGHT_MIN, RIGHT_MAX))} title={t('app.resizeRight')} />

            {/* Right — installable asset library, scope follows the active context */}
            <aside
              style={{ width: rightW }}
              className="shrink-0 border-l border-white/[0.06] frosted overflow-hidden"
            >
              {activeProject ? (
                <LibraryPanel
                  installedSkillNames={installedSkillNames}
                  onInstallSkill={handleInstallSkill}
                  onInstallFileAsset={handleInstallFileAsset}
                  onInstallMcp={handleInstallMcp}
                  updates={updates}
                  onUpdateAsset={handleUpdateAsset}
                  category={mainCategory}
                  scope={mode}
                />
              ) : (
                <div className="p-3 text-xs text-neutral-500">
                  {t('app.selectProjectForAssets')}
                </div>
              )}
            </aside>
          </div>
        </div>
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
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
