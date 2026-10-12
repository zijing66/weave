import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  api,
  type AssetEntry,
  type AssetAgent,
  type AssetChangeEvent,
  type AssetScope,
  type FileAssetCategory,
  type FileAssetTemplate,
  type HookRule,
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
  type InstallCapabilities,
} from '@/lib/api';
import { canInstall, type DragPayload } from '@/lib/install-capabilities';
import { subscribeSse } from '@/lib/sse';
import { ProjectList } from '@/components/ProjectList';
import { useSessionStatus } from '@/components/tasks/session-status-store';
import { CategoryBar, type MainCategory, type CategoryBarData } from '@/components/CategoryBar';
import { CategoryDetail, type Mode, type AssetTab } from '@/components/CategoryDetail';
import { type FileAssetRow } from '@/components/FileAssetTree';
import { SkillDetailDrawer } from '@/components/SkillDetailDrawer';
import { LibraryPanel } from '@/components/LibraryPanel';
import { FileViewer } from '@/components/FileViewer';
import { Resizer } from '@/components/Resizer';
import { SettingsModal } from '@/components/SettingsModal';
import { cn } from '@/lib/utils';
import { countEffectiveSkills } from '@/lib/skill-stats';
import { useT } from '@/i18n/I18nProvider';
import { Settings } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { errorText, useActionFeedback } from '@/lib/action-feedback';

const LEFT_MIN = 176;
const LEFT_MAX = 320;
const RIGHT_MIN = 260;
const RIGHT_MAX = 440;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export default function App() {
  const t = useT();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [selected, setSelected] = useState<ProjectRow | null>(null);
  const [globalMode, setGlobalMode] = useState(false);
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  // Machine-level harness files (~/.claude, ~/.codex) — fetched lazily, only
  // when the global 资源管理 page is opened.
  const [globalAssets, setGlobalAssets] = useState<AssetEntry[]>([]);
  // 会话与状态全部来自全局状态总线（Provider 挂在 main.tsx）——App 只读计数，
  // 不再自拉一份（与项目行徽标/任务视图同源，状态不会各页漂移）。
  const { sessions: allSessions, projectStats } = useSessionStatus();
  // 全局总览跳进项目任务视图的初始选中会话（离开任务视图即失效）。
  const [initialSessionId, setInitialSessionId] = useState<string | null>(null);
  // All hook rules (global + per project) — drives the Weave card count; the
  // panel refetches its own copy after every mutation.
  const [hookRules, setHookRules] = useState<HookRule[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerMap>({
    project: {},
    global: {},
    codex: {},
  });
  const [updates, setUpdates] = useState<UpdateReport | null>(null);
  const [globalSkillGroups, setGlobalSkillGroups] = useState<GlobalSkillGroup[]>([]);
  const [pluginEnabled, setPluginEnabled] = useState<PluginEnabledMap>({ claude: {}, codex: {} });
  // Per-project config cache (autoSync etc.) — single source for the top bar
  // chip (selected project) and the row quick-action toggles alike.
  const [configMap, setConfigMap] = useState<Record<number, ProjectConfig>>({});
  // Row pending-update counts — hover-lazy + cached per project id.
  const [updatesMap, setUpdatesMap] = useState<Record<number, number>>({});
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  // 统一消息提示：原先是顶栏下一行小红字（滚走就看不见）→ 一律走 toast。
  // setError 保留原名，全部既有调用点自动改道（一次改，处处统一）。
  const { show } = useToast();
  const setError = useCallback(
    (message: string | null) => {
      if (message) show('error', message);
    },
    [show],
  );
  /** 按钮反馈（loading → ✅ → 2s 复原），按 key 记状态。 */
  const fb = useActionFeedback();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Main area
  const [mainCategory, setMainCategory] = useState<MainCategory>('tasks');
  // Files-page asset tab: lifted here so it survives category switches
  // (leaving files and coming back keeps the tab; starts on skills).
  const [assetTab, setAssetTab] = useState<AssetTab>('files');
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
  useEffect(() => localStorage.setItem('weave:col-left', String(leftW)), [leftW]);
  useEffect(() => localStorage.setItem('weave:col-right', String(rightW)), [rightW]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => {
    api.listProjects().then(setProjects).catch((e) => setError(String(e)));
  }, []);

  // 安装属性矩阵（静态）：启动拉一次，下发 LibraryPanel（M6 拖拽 canDrop 也用）。
  const [installCaps, setInstallCaps] = useState<InstallCapabilities | null>(null);
  useEffect(() => {
    api.capabilities().then(setInstallCaps).catch(() => {});
  }, []);

  // 拖拽中的统一 payload（onDragStart 提升）：落点 canInstall 判定与落定分派共用。
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);

  // 项目列表刷新：SSE project 帧（另一进程 weave init/scan 落库 → daemon
  // reconcile 检出）触发整表重拉；visibilitychange 兜底 ≤5s reconcile 窗口。
  const refreshProjects = useCallback(() => {
    api.listProjects().then(setProjects).catch(() => {});
  }, []);

  // 项目行拖拽排序落定：乐观重排（落点即时反馈），持久化失败回滚到服务端
  // 真值并报因（失败不静默）。
  const handleProjectReorder = useCallback(
    (ids: number[]) => {
      setProjects((prev) => {
        const byId = new Map(prev.map((p) => [p.id, p]));
        const next = ids.map((id) => byId.get(id)).filter((p): p is ProjectRow => !!p);
        for (const p of prev) if (!ids.includes(p.id)) next.push(p);
        return next;
      });
      api.reorderProjects(ids).catch((e) => {
        setError(t('errors.projectReorderFailed', { error: String(e) }));
        refreshProjects();
      });
    },
    [refreshProjects, t],
  );

  // 项目卡终端角标（已开终端窗口数）：初值拉一次，之后由服务端 push 帧驱动——
  // 后端「有人看时每 30s 探一次、只在值变化时推」。前端不再有任何定时器：探测
  // 本身要 spawn `wezterm cli`，轮询留在前端会按打开的看板数翻倍。
  const [terminalCounts, setTerminalCounts] = useState<Record<number, number>>({});
  useEffect(() => {
    let cancelled = false;
    api
      .getTerminalCounts()
      .then((counts) => {
        if (!cancelled) setTerminalCounts(counts);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshProjects();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refreshProjects]);

  const refreshAssets = useCallback((p: ProjectRow) => {
    api.listAssets(p.path).then(setAssets).catch(() => {});
  }, []);

  const refreshMcp = useCallback((p: ProjectRow) => {
    api.listMcp(p.id).then(setMcpServers).catch(() => {});
  }, []);

  const refreshUpdates = useCallback((p: ProjectRow) => {
    api.listUpdates(p.id).then(setUpdates).catch(() => {});
  }, []);

  // 选中项目的既有 updates 刷新结果回填行计数缓存 —— 顶栏/任务页与行内按钮
  // 共用同一份取数，不为行列表单独再拉。
  useEffect(() => {
    if (selected && updates) {
      setUpdatesMap((prev) => ({ ...prev, [selected.id]: updates.available }));
    }
  }, [updates, selected]);

  const refreshGlobalSkills = useCallback((p: ProjectRow) => {
    api.listGlobalSkills(p.id).then(setGlobalSkillGroups).catch(() => {});
  }, []);
  const refreshPluginEnabled = useCallback((p: ProjectRow) => {
    api.getPluginEnabled(p.id).then(setPluginEnabled).catch(() => {});
  }, []);

  const refreshConfig = useCallback((p: ProjectRow) => {
    api.getProjectConfig(p.id)
      .then((c) => setConfigMap((prev) => ({ ...prev, [p.id]: c })))
      .catch(() => {});
  }, []);

  // 行内 autoSync 供给：项目列表到达时按 id 各拉一次 config 并缓存（已有/在途
  // 跳过）——一次批量轻拉后全程复用，避免每行渲染各发一请求。
  const configInFlight = useRef<Set<number>>(new Set());
  useEffect(() => {
    for (const p of projects) {
      if (configMap[p.id] || configInFlight.current.has(p.id)) continue;
      configInFlight.current.add(p.id);
      api.getProjectConfig(p.id)
        .then((c) => setConfigMap((prev) => ({ ...prev, [p.id]: c })))
        .catch(() => configInFlight.current.delete(p.id));
    }
  }, [projects, configMap]);

  // 行内 updates 计数：行 hover 懒加载 + 按 id 缓存（listUpdates 要算指纹，
  // 不做全量预拉）；force 供行同步后重拉。
  const updatesInFlight = useRef<Set<number>>(new Set());
  const ensureUpdates = useCallback(
    (projectId: number, force = false) => {
      if (updatesInFlight.current.has(projectId)) return;
      if (!force && updatesMap[projectId] !== undefined) return;
      updatesInFlight.current.add(projectId);
      api.listUpdates(projectId)
        .then((r) => {
          updatesInFlight.current.delete(projectId);
          setUpdatesMap((prev) => ({ ...prev, [projectId]: r.available }));
        })
        .catch(() => updatesInFlight.current.delete(projectId));
    },
    [updatesMap],
  );

  /** Refresh the hooks rule set (card count). */
  const refreshHookRules = useCallback(() => {
    api.listHooksRules().then(setHookRules).catch(() => {});
  }, []);

  useEffect(() => {
    refreshHookRules();
  }, [refreshHookRules]);

  // HooksPanel announces rule mutations with this event so the category card
  // count stays honest without threading callbacks through CategoryDetail.
  useEffect(() => {
    window.addEventListener('weave:rules-changed', refreshHookRules);
    return () => window.removeEventListener('weave:rules-changed', refreshHookRules);
  }, [refreshHookRules]);

  const loadProject = useCallback(
    (p: ProjectRow) => {
      setSelected(p);
      setGlobalMode(false);
      setAssets([]);
      setMcpServers({ project: {}, global: {}, codex: {} });
      setUpdates(null);
      setGlobalSkillGroups([]);
      setPluginEnabled({ claude: {}, codex: {} });
      setSelectedFile(null);
      setDrawerSkill(null);
      setMainCategory('tasks');
      setInitialSessionId(null);
      setStatuslineSource(null);
      setError(null);
      api.listAssets(p.path).then(setAssets).catch((e) => setError(String(e)));
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
    setMainCategory('tasks');
    setInitialSessionId(null);
    setStatuslineSource(null); // no source badge/sub-text in the template view
    setError(null);
    // One bounded whitelist walk of ~/.claude + ~/.codex — cheap enough to
    // run on every entry, and it keeps the 资源管理 card count honest.
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
      const outdatedSkills = (updates?.skills ?? []).filter(
        (u) => u.scope === 'global' && u.outdated,
      ).length;
      const outdatedMcp = (updates?.mcp ?? []).filter(
        (u) => u.scope === 'global' && u.outdated,
      ).length;
      return {
        // machine-wide skills in effect + MCP servers + the global file tree
        // (~/.claude, ~/.codex) — the merged 资源管理 card count
        files:
          effectiveGlobalSkills +
          Object.keys(mcpServers.global).length +
          codexMcp +
          globalAssets.length,
        outdated: outdatedSkills + outdatedMcp,
        // The global view IS the template — a 跟随全局 badge would be noise.
        statuslineSource: null,
        hooksRules: hookRules.length,
        sessions: allSessions?.length ?? 0,
      };
    }
    const otherCount = assets.filter((a) => a.category !== 'skill' && a.category !== 'mcp').length;
    return {
      // project skills + machine-wide skills in effect + this view's MCP
      // servers + every other file asset — the page shows them together under
      // the 资源管理 card
      files:
        assetCounts.skill +
        effectiveGlobalSkills +
        Object.keys(mcpServers.project).length +
        codexMcp +
        otherCount,
      outdated:
        (updates?.skills ?? []).filter((u) => u.outdated).length +
        (updates?.mcp ?? []).filter((u) => u.outdated).length,
      statuslineSource,
      // same rule as the server's ?projectId= filter: global rules + own rules
      hooksRules: hookRules.filter(
        (r) => r.projectId === null || r.projectId === selected?.id,
      ).length,
      sessions: (allSessions ?? []).filter((s) => s.projectId === selected?.id).length,
    };
  }, [globalMode, globalSkillGroups, mcpServers, updates, assets, globalAssets, assetCounts, pluginEnabled, effectiveGlobalSkills, statuslineSource, hookRules, selected, allSessions]);

  // Asset entry backing the open file preview — supplies the agent badge in
  // the drawer header. Missing rows (cache lag) fall back to plain Claude.
  const selectedAsset = useMemo<AssetEntry | null>(() => {
    if (!selectedFile) return null;
    const pool = globalMode ? globalAssets : assets;
    return pool.find((a) => a.relPath === selectedFile) ?? null;
  }, [globalMode, globalAssets, assets, selectedFile]);


  // 全站唯一 SSE 连接（lib/sse）：资产 / 项目 / hook / 数据帧都从这一条来。
  // selected 走 ref 读、不进依赖数组——否则每切一次项目就断线重连。
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(
    () =>
      subscribeSse((frame) => {
        // 项目注册表变更帧：必须先于 asset 过滤处理（它没有 selected 项目语义），
        // 整表重拉后 ProjectList 自然出现新项目。
        if (frame.type === 'project') {
          refreshProjects();
          return;
        }
        // Hook frames ({ type: 'hook', kind: 'dispatch.*' }) go out on the same
        // stream; the Hooks / Tasks panels listen for them on `weave:hook`.
        // 会话状态/计数由全局状态总线按同一批帧维护（main.tsx 挂的 Provider）。
        if (frame.type === 'hook') {
          window.dispatchEvent(new CustomEvent('weave:hook', { detail: frame }));
          return;
        }
        // 数据帧：后端已算好的载荷直接写状态（目前只有终端角标）。
        if (frame.type === 'push' && frame.key === 'terminalCounts') {
          setTerminalCounts((frame.payload as { counts: Record<number, number> }).counts);
          return;
        }
        // 其余数据帧是失效键，收到后按 key 调既有 fetcher 重拉（后续逐个接入）。
        if (frame.type !== 'asset') return;
        const change = frame as unknown as AssetChangeEvent;
        const sel = selectedRef.current;
        if (!sel || change.projectPath !== sel.path) return;
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
        if (change.category === 'mcp') refreshMcp(sel);
        if (change.category === 'skill') refreshGlobalSkills(sel);
        // any asset change may affect update availability
        refreshUpdates(sel);
      }),
    [refreshMcp, refreshUpdates, refreshGlobalSkills, refreshProjects],
  );

  // 安装/卸载/更新 handler 失败必抛（同 handleSyncAll）：文案归调用方的 fb.run /
  // 兜底 catch——handler 内先报错又正常 resolve 的话，调用方会在失败时也弹成功。
  const handleInstallSkill = useCallback(
    async (skill: SkillAsset, scope: AssetScope = 'project', agent: AssetAgent = 'claude') => {
      if (!selected && !globalMode) return;
      const target = selected ?? projects[0];
      if (!target) return;
      const res = await api.install(target.id, {
        category: 'skill',
        name: skill.name,
        sourceDir: skill.dirPath,
        scope,
        agent,
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      refreshAssets(target);
      refreshGlobalSkills(target);
      refreshUpdates(target);
    },
    [selected, projects, globalMode, refreshAssets, refreshGlobalSkills, refreshUpdates],
  );

  /** Install a single-file asset (command / agent / workflow / rule / output-style). */
  const handleInstallFileAsset = useCallback(
    async (file: FileAssetTemplate, scope: AssetScope = 'project') => {
      if (!selected && !globalMode) return;
      const target = selected ?? projects[0];
      if (!target) return;
      const res = await api.install(target.id, {
        category: file.category,
        name: file.name,
        sourceFile: file.filePath,
        scope,
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      refreshAssets(target);
      refreshUpdates(target);
    },
    [selected, projects, globalMode, refreshAssets, refreshUpdates],
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
      // Codex MCP servers only live in ~/.codex/config.toml (user-level).
      const effectiveScope = agent === 'codex' ? 'global' : scope;
      const res = await api.install(target.id, {
        category: 'mcp',
        name,
        mcpConfig: config,
        scope: effectiveScope,
        agent,
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      refreshAssets(target);
      refreshMcp(target);
      refreshUpdates(target);
    },
    [selected, projects, globalMode, refreshAssets, refreshMcp, refreshUpdates],
  );

  const handleUninstallSkill = useCallback(
    async (name: string, scope: AssetScope = 'project', agent?: AssetAgent) => {
      const target = selected ?? projects[0];
      if (!target) return;
      const res = await api.uninstall(target.id, {
        category: 'skill',
        name,
        scope,
        agent: agent ?? 'claude',
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      refreshAssets(target);
      refreshGlobalSkills(target);
      refreshUpdates(target);
    },
    [selected, projects, refreshAssets, refreshGlobalSkills, refreshUpdates],
  );

  const handleUninstallFileAsset = useCallback(
    async (row: FileAssetRow, scope: AssetScope = 'project') => {
      const target = selected ?? projects[0];
      if (!target) return;
      const res = await api.uninstall(target.id, {
        category: row.category as FileAssetCategory,
        name: row.name,
        scope,
        ...(row.agent ? { agent: row.agent } : {}),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      refreshAssets(target);
      refreshUpdates(target);
    },
    [selected, projects, refreshAssets, refreshUpdates],
  );

  const handleUninstallMcp = useCallback(
    async (name: string, scope: AssetScope = 'project', agent?: AssetAgent) => {
      const target = selected ?? projects[0];
      if (!target) return;
      // Codex servers are user-level — uninstall always targets the TOML file.
      const res = await api.uninstall(target.id, {
        category: 'mcp',
        name,
        scope: agent === 'codex' ? 'global' : scope,
        ...(agent ? { agent } : {}),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      refreshAssets(target);
      refreshMcp(target);
      refreshUpdates(target);
    },
    [selected, projects, refreshAssets, refreshMcp, refreshUpdates],
  );

  // 参数化：顶栏不传参走当前项目，行内按钮传本行项目（同一回调）。失败抛出，由
  // 调用方的 fb.run 统一报错（toast）；成功返回服务端 payload 的更新条数——此前
  // 这个 payload 被整个丢掉，才出现"点了立即同步看不到效果"。
  const handleSyncAll = useCallback(
    async (target?: ProjectRow): Promise<{ updated: number }> => {
      const p = target ?? selected ?? projects[0];
      if (!p) return { updated: 0 };
      const res = await api.syncAll(p.id);
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const data = (await res.json().catch(() => null)) as { updated?: unknown } | null;
      // 只有当前视图项目才刷新共享的 updates/assets 状态；其他行只回填自己的
      // 计数缓存（assets 是选中项目的镜像，别行同步不得覆盖）。
      if (!globalMode && selected && p.id === selected.id) {
        refreshUpdates(p);
        refreshAssets(p);
      } else {
        ensureUpdates(p.id, true);
      }
      return { updated: Array.isArray(data?.updated) ? data.updated.length : 0 };
    },
    [selected, projects, globalMode, refreshUpdates, refreshAssets, ensureUpdates],
  );

  const handleUpdateAsset = useCallback(
    async (
      category: 'skill' | 'mcp' | FileAssetCategory,
      name: string,
      scope: AssetScope,
      agent?: AssetAgent,
    ) => {
      const target = selected ?? projects[0];
      if (!target) return;
      const res = await api.updateAsset(target.id, {
        category,
        name,
        scope,
        ...(category === 'skill' || category === 'mcp' ? { agent: agent ?? 'claude' } : {}),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      refreshUpdates(target);
      refreshAssets(target);
      if (category === 'mcp') refreshMcp(target);
      if (category === 'skill') refreshGlobalSkills(target);
    },
    [selected, projects, refreshUpdates, refreshAssets, refreshMcp, refreshGlobalSkills],
  );

  const handleToggleAutoSync = useCallback(
    async (target?: ProjectRow): Promise<boolean> => {
      const p = target ?? selected;
      if (!p) return false;
      // 配置缓存未加载时先取真值——否则会拿 {autoSync:false,lastSyncAt:null} 兜底，
      // 把 lastSyncAt 覆写成 null（服务端的 `??` 救不了显式 null）。
      const current = configMap[p.id] ?? (await api.getProjectConfig(p.id));
      const next = { ...current, autoSync: !current.autoSync };
      setConfigMap((prev) => ({ ...prev, [p.id]: next }));
      const res = await api.putProjectConfig(p.id, next);
      if (!res.ok) {
        refreshConfig(p);
        throw new Error(`${res.status} ${await res.text()}`);
      }
      return next.autoSync;
    },
    [selected, configMap, refreshConfig],
  );

  // 行内与顶栏共用的反馈包装：state 按 key 记（行内按项目 id，顶栏用 current/all）。
  const autoSyncActionStateOf = useCallback((id: number) => fb.stateOf(`auto:${id}`), [fb]);
  const syncActionStateOf = useCallback((id: number) => fb.stateOf(`sync:${id}`), [fb]);
  const toggleAutoSyncWithFeedback = useCallback(
    (p: ProjectRow) =>
      fb.run(
        `auto:${p.id}`,
        async () => {
          const on = await handleToggleAutoSync(p);
          show('success', on ? t('toast.autoSyncOn') : t('toast.autoSyncOff'));
        },
        { fail: (e) => t('errors.configUpdateFailed', { error: errorText(e) }) },
      ),
    [fb, handleToggleAutoSync, show, t],
  );
  const syncNowWithFeedback = useCallback(
    (p: ProjectRow) =>
      fb.run(
        `sync:${p.id}`,
        async () => {
          const { updated } = await handleSyncAll(p);
          if (updated > 0) show('success', t('toast.synced', { n: updated }));
          else show('info', t('toast.nothingToSync'));
        },
        { fail: (e) => t('errors.syncFailed', { error: errorText(e) }) },
      ),
    [fb, handleSyncAll, show, t],
  );

  /** 开目录/终端条按钮：explorer/terminal 各一把 fb 键（行内三态 + 吞连点），
      失败 toast；成功无 toast——窗口弹出本身就是反馈。 */
  const openProjectWithFeedback = useCallback(
    (p: ProjectRow, target: 'explorer' | 'terminal') =>
      void fb.run(
        `open-${target}:${p.id}`,
        async () => {
          await api.openProject(p.id, target);
          // 新窗落地到 cwd 上报有一拍延迟：略等再对一次账。服务端开窗后的对账
          // 是**立刻**发的，那时 wezterm 还没报出新窗 cwd，所以这里补一枪一次性
          // 拉取（不是轮询：只在用户点了按钮之后发生一次）。
          if (target === 'terminal') {
            window.setTimeout(() => {
              api.getTerminalCounts().then(setTerminalCounts).catch(() => {});
            }, 600);
          }
        },
        { fail: (e) => t('errors.openFailed', { error: errorText(e) }) },
      ),
    [fb, t],
  );
  const openExplorerStateOf = useCallback((id: number) => fb.stateOf(`open-explorer:${id}`), [fb]);
  const openTerminalProjectStateOf = useCallback(
    (id: number) => fb.stateOf(`open-terminal:${id}`),
    [fb],
  );

  /** Toggle a plugin's enable state in the host config (Claude settings.json or
   * Codex config.toml). Optimistically updates the local map, then persists;
   * reloads groups on success so enable badges stay in sync. On failure refetches
   * to revert the optimistic flip and throws (caller reports). */
  const handleTogglePlugin = useCallback(
    async (runtime: PluginRuntime, key: string, enabled: boolean) => {
      const target = selected ?? projects[0];
      if (!target) return;
      setPluginEnabled((prev) => ({ ...prev, [runtime]: { ...prev[runtime], [key]: enabled } }));
      const res = await api.putPluginEnabled(target.id, { runtime, key, enabled });
      if (!res.ok) {
        refreshPluginEnabled(target);
        throw new Error(`${res.status} ${await res.text()}`);
      }
      refreshGlobalSkills(target);
    },
    [selected, projects, refreshPluginEnabled, refreshGlobalSkills],
  );

  // 直连 fire-and-forget 调用点（拖拽落定 / 库面板安装·更新 / 抽屉卸载）没有
  // 按钮本体可挂三态反馈，就地兜一条错误 toast：失败必有一条提示、也不产生
  // unhandled rejection；成功维持无 toast（由 SSE 刷新与 ✓ 标呈现）。
  const installSkillSafely = useCallback(
    (skill: SkillAsset, scope: AssetScope, agent: AssetAgent) => {
      void handleInstallSkill(skill, scope, agent).catch((e) =>
        show('error', t('errors.installFailed', { error: errorText(e) })),
      );
    },
    [handleInstallSkill, show, t],
  );
  const installFileAssetSafely = useCallback(
    (file: FileAssetTemplate, scope: AssetScope) => {
      void handleInstallFileAsset(file, scope).catch((e) =>
        show('error', t('errors.installFailed', { error: errorText(e) })),
      );
    },
    [handleInstallFileAsset, show, t],
  );
  const installMcpSafely = useCallback(
    (name: string, config: McpServerConfig, scope: AssetScope, agent?: AssetAgent) => {
      void handleInstallMcp(name, config, scope, agent).catch((e) =>
        show('error', t('errors.mcpInstallFailed', { error: errorText(e) })),
      );
    },
    [handleInstallMcp, show, t],
  );
  const updateAssetSafely = useCallback(
    (
      category: 'skill' | 'mcp' | FileAssetCategory,
      name: string,
      scope: AssetScope,
      agent?: AssetAgent,
    ) => {
      void handleUpdateAsset(category, name, scope, agent).catch((e) =>
        show('error', t('errors.updateFailed', { error: errorText(e) })),
      );
    },
    [handleUpdateAsset, show, t],
  );
  const uninstallSkillSafely = useCallback(
    (name: string, scope: AssetScope, agent?: AssetAgent) => {
      void handleUninstallSkill(name, scope, agent).catch((e) =>
        show('error', t('errors.uninstallFailed', { error: errorText(e) })),
      );
    },
    [handleUninstallSkill, show, t],
  );

  const selectCategory = useCallback((c: MainCategory) => {
    setMainCategory(c);
    // 初始选中会话只在任务视图内有效（回看时回落默认最新组/会话）
    if (c !== 'tasks') setInitialSessionId(null);
    if (c === 'personalization') setStatuslineNonce((n) => n + 1);
    // reopen → pick up rule changes made elsewhere before the card count shows
    if (c === 'weave') refreshHookRules();
  }, [refreshHookRules]);

  /** 全局任务总览行点击：退出全局 → 载入对应项目 → 任务视图选中该会话。 */
  const openSessionInProject = useCallback(
    (projectId: number, sessionId: string) => {
      const target = projects.find((p) => p.id === projectId);
      if (!target) return;
      loadProject(target); // 同批内已把 mainCategory 置为 tasks（默认卡），这里仅选中会话
      setInitialSessionId(sessionId);
      setMainCategory('tasks');
    },
    [projects, loadProject],
  );

  function onDragStart(e: DragStartEvent) {
    setDragPayload((e.active.data.current as DragPayload | undefined) ?? null);
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    const data = active.data.current as DragPayload | undefined;
    setDragPayload(null);
    if (!over || over.id !== 'project-assets' || !data) return;
    const scope: AssetScope = globalMode ? 'global' : 'project';
    // 属性判定单点：不合法 → 顶栏报因、不安装（与按钮 disabled 同谓词）。
    const verdict = canInstall(data.attrs, { scope, agent: data.targetAgent });
    if (!verdict.ok) {
      if (verdict.reasonKey) setError(t(verdict.reasonKey));
      return;
    }
    if (data.installKind === 'skill' && data.sourceDir && data.name) {
      installSkillSafely(
        { name: data.name, dirPath: data.sourceDir } as SkillAsset,
        scope,
        data.targetAgent,
      );
    } else if (data.installKind === 'file' && data.sourceFile && data.name) {
      installFileAssetSafely(
        { name: data.name, filePath: data.sourceFile, category: data.category } as FileAssetTemplate,
        scope,
      );
    } else if (data.installKind === 'mcp' && data.mcpConfig && data.name) {
      installMcpSafely(data.name, data.mcpConfig, scope, data.targetAgent);
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
  // 顶栏自动同步开关：与行内按钮同读 configMap（选中项目一条数据源）。
  const autoSyncOn = selected ? (configMap[selected.id]?.autoSync ?? false) : false;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragPayload(null)}
    >
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
                onOpenExplorer={(p) => openProjectWithFeedback(p, 'explorer')}
                onOpenTerminal={(p) => openProjectWithFeedback(p, 'terminal')}
                openExplorerStateOf={openExplorerStateOf}
                openTerminalStateOf={openTerminalProjectStateOf}
                onHoverProject={ensureUpdates}
                autoSyncOf={(id) => configMap[id]?.autoSync}
                updatesOf={(id) => updatesMap[id]}
                autoSyncStateOf={autoSyncActionStateOf}
                syncStateOf={syncActionStateOf}
                onToggleAutoSync={(p) => void toggleAutoSyncWithFeedback(p)}
                onSyncNow={(p) => void syncNowWithFeedback(p)}
                sessionStatsOf={(id) => projectStats.get(id)}
                terminalsOf={(id) => terminalCounts[id] ?? 0}
                onReorder={handleProjectReorder}
              />
            </aside>
            <Resizer onResize={(d) => setLeftW((w) => clamp(w + d, LEFT_MIN, LEFT_MAX))} title={t('app.resizeLeft')} />

            {/* Level 2 + 3 — categories + detail */}
            <main className="flex-1 flex flex-col overflow-hidden relative">
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
                        onClick={() =>
                          void fb.run(
                            'sync:all',
                            async () => {
                              const { updated } = await handleSyncAll();
                              if (updated > 0) show('success', t('toast.synced', { n: updated }));
                              else show('info', t('toast.nothingToSync'));
                            },
                            { fail: (e) => t('errors.syncFailed', { error: errorText(e) }) },
                          )
                        }
                        title={`${t('app.syncAllTooltip', { n: updates.available })}\n\n${t('app.scopeCoverageTooltip')}`}
                        className="shrink-0 inline-flex items-center gap-1 rounded-full bg-blue-900/40 text-blue-300 px-2.5 py-1 text-xs font-medium hover:bg-blue-900/60"
                      >
                        <FeedbackIcon state={fb.stateOf('sync:all')} className="h-3 w-3" />
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
                          onClick={() =>
                            void fb.run(
                              'auto:current',
                              async () => {
                                const on = await handleToggleAutoSync();
                                show('success', on ? t('toast.autoSyncOn') : t('toast.autoSyncOff'));
                              },
                              { fail: (e) => t('errors.configUpdateFailed', { error: errorText(e) }) },
                            )
                          }
                          aria-pressed={autoSyncOn}
                          title={`${autoSyncOn ? t('app.autoSyncOnTooltip') : t('app.autoSyncOffTooltip')}\n\n${t('app.scopeCoverageTooltip')}`}
                          className={cn(
                            'shrink-0 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
                            autoSyncOn
                              ? 'bg-emerald-900/40 text-emerald-300'
                              : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700',
                          )}
                        >
                          <FeedbackIcon state={fb.stateOf('auto:current')} className="h-3 w-3" />
                          {autoSyncOn ? t('app.autoSyncOn') : t('app.autoSyncOff')}
                        </button>
                      </>
                    )}
                  </div>

                  <CategoryBar
                    category={mainCategory}
                    onSelect={selectCategory}
                    data={categoryData}
                  />

                  {/* 任务视图自管两栏内部滚动（全高），其余分类沿用外层滚动 */}
                  <div
                    className={cn(
                      'flex-1 relative',
                      mainCategory === 'tasks' && !globalMode
                        ? 'overflow-hidden !p-0'
                        : 'overflow-y-auto p-3',
                    )}
                  >
                    {noAnchor ? (
                      <p className="text-xs text-neutral-500">
                        {t('app.needProjectAnchor')}
                      </p>
                    ) : (
                      <CategoryDetail
                        projectId={activeProject!.id}
                        mode={mode}
                        category={mainCategory}
                        assetTab={assetTab}
                        onAssetTabChange={setAssetTab}
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
                        projects={projects}
                        onOpenSession={openSessionInProject}
                        initialSessionId={initialSessionId ?? undefined}
                        dragPayload={dragPayload}
                      />
                    )}
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
                    uninstallSkillSafely(drawerSkill.name, drawerSkill.scope, drawerSkill.agent);
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
                  onInstallSkill={installSkillSafely}
                  onInstallFileAsset={installFileAssetSafely}
                  onInstallMcp={installMcpSafely}
                  updates={updates}
                  onUpdateAsset={updateAssetSafely}
                  category={mainCategory}
                  assetTab={assetTab}
                  scope={mode}
                  capabilities={installCaps}
                  projectId={activeProject.id}
                  onSyncAll={() => void syncNowWithFeedback(activeProject)}
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
