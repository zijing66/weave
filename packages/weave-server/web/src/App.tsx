import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  api,
  skillSourceRuntime,
  type AssetEntry,
  type AssetAgent,
  type AssetChangeEvent,
  type AssetScope,
  type FileAssetCategory,
  type FileAssetTemplate,
  type HookRule,
  type McpServerConfig,
  type McpRow,
  type ProjectRow,
  type SkillAsset,
  type StatuslineSource,
  type UpdateReport,
  type ProjectConfig,
  type GlobalSkillGroup,
  type PluginRow,
  type PluginRuntime,
  type GlobalSkillSource,
  type InstallCapabilities,
} from '@/lib/api';
import { canInstall, capabilitiesOf, type DragPayload } from '@/lib/install-capabilities';
import { HARNESS_ORDER } from '@/lib/harness-meta';
import type { EnableOverride, ToolScope } from '@weavecode/core/tool';
import { registerInvalidator, subscribeSse } from '@/lib/sse';
import { sessionLabel } from '@/lib/hook-payload';
import { notifyBrowser } from '@/lib/browser-notify';
import { ProjectList } from '@/components/ProjectList';
import { useSessionStatus } from '@/components/tasks/session-status-store';
import { CategoryBar, type MainCategory, type CategoryBarData } from '@/components/CategoryBar';
import { CategoryDetail, type Mode, type ResourceView } from '@/components/CategoryDetail';
import { SkillDetailDrawer } from '@/components/SkillDetailDrawer';
import { LibraryPanel } from '@/components/LibraryPanel';
import { FileViewer } from '@/components/FileViewer';
import { Resizer } from '@/components/Resizer';
import { SettingsModal } from '@/components/SettingsModal';
import { cn } from '@/lib/utils';
import { countEffectiveSkills } from '@/lib/skill-stats';
import { useT } from '@/i18n/I18nProvider';
import { useMediaQuery } from '@/lib/use-media-query';
import { Github, Library, LogOut, PanelLeft, Settings, X } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import { logout, refreshAuth, useAuthState } from '@/lib/auth';
import { WEAVE_REPO_URL, formatStars, useRepoStars } from '@/lib/github';
import { LoginPage } from '@/components/LoginPage';
import { AiAssistant } from '@/components/AiAssistant';
import { SkeletonMain, SkeletonRows } from '@/components/ui/skeleton';

const LEFT_MIN = 176;
const LEFT_MAX = 320;
const RIGHT_MIN = 260;
const RIGHT_MAX = 440;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** 生效查表（链解析在服务端，前端只读行上的 effective）。 */
const pluginEffective = (rows: readonly PluginRow[], runtime: PluginRuntime, key: string): boolean =>
  rows.some((r) => r.harness === runtime && r.key === key && r.effective);

/**
 * 认证门：未探测 → 极简骨架（不闪内容）；未登录 → **默认落登录页**（仅密码，
 * 无改密入口——改密只走 CLI）；已登录 → 原 dashboard 本体。
 * 任一 API 401 / SSE 被拒也会把状态打回 anonymous（见 lib/api.ts、lib/sse.ts）。
 */
export default function App() {
  const auth = useAuthState();
  useEffect(() => {
    void refreshAuth();
  }, []);
  if (auth === 'unknown') {
    return (
      <div className="grid min-h-dvh place-items-center bg-neutral-950 text-xs text-neutral-600">
        weave
      </div>
    );
  }
  if (auth === 'anonymous') return <LoginPage />;
  return <Dashboard />;
}

function Dashboard() {
  const t = useT();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  // 首屏门：项目列表回来前，左侧列表与主区用骨架屏顶住——首次访问不再「先空一下再蹦」。
  const [shellReady, setShellReady] = useState(false);
  // 顶栏 GitHub 链接的 star 数（浏览器直取 + localStorage 缓存；未知 = null）
  const stars = useRepoStars();
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
  // MCP 工具行（每行一个 (harness, scope) 面；enable/effective 服务端算好）。
  const [mcpRows, setMcpRows] = useState<McpRow[]>([]);
  const [updates, setUpdates] = useState<UpdateReport | null>(null);
  const [globalSkillGroups, setGlobalSkillGroups] = useState<GlobalSkillGroup[]>([]);
  const [pluginRows, setPluginRows] = useState<PluginRow[]>([]);
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
  // 移动端外壳（<1024px 单栏）：左右栏改滑出抽屉；拖拽 sensor 按指针类型分流。
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const finePointer = useMediaQuery('(pointer: fine)');
  const [mobilePanel, setMobilePanel] = useState<'projects' | 'library' | null>(null);

  // Main area
  const [mainCategory, setMainCategory] = useState<MainCategory>('tasks');
  // Files-page asset tab: lifted here so it survives category switches
  // (leaving files and coming back keeps the tab; starts on skills).
  // 资源管理页视图（提升到此，切分类来回不丢）：'packs' = 以插件包为主；'files' = 只读文件视图
  const [resourceView, setResourceView] = useState<ResourceView>('packs');
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

  // 拖拽激活按指针分流：鼠标 = 5px 位移即拖（现状）；触屏 = 长按 200ms 才拖——
  // PointerSensor 挂触摸会把列表滚动劫持成拖拽（dnd-kit 只在拖拽浮层设
  // touch-action:none，改用 TouchSensor 后行本身的滚动不受影响）。
  const mouseSensor = useSensor(PointerSensor, { activationConstraint: { distance: 5 } });
  const touchSensor = useSensor(TouchSensor, {
    activationConstraint: { delay: 200, tolerance: 8 },
  });
  const sensors = useSensors(finePointer ? mouseSensor : touchSensor);

  useEffect(() => {
    api
      .listProjects()
      .then(setProjects)
      .catch((e) => setError(String(e)))
      .finally(() => setShellReady(true));
    api.listArchivedProjects().then(setArchivedProjects).catch(() => {});
  }, []);

  // 安装属性矩阵（静态）：启动拉一次，下发 LibraryPanel（M6 拖拽 canDrop 也用）。
  const [installCaps, setInstallCaps] = useState<InstallCapabilities | null>(null);
  useEffect(() => {
    api.capabilities().then(setInstallCaps).catch(() => {});
  }, []);

  // 拖拽中的统一 payload（onDragStart 提升）：落点 canInstall 判定与落定分派共用。
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);

  // 归档项目面数据：与活跃列表同源刷新（归档/恢复/SSE project 帧都会带动）。
  const [archivedProjects, setArchivedProjects] = useState<ProjectRow[]>([]);
  // 项目列表刷新：SSE project 帧（另一进程 weave init/scan 落库 → daemon
  // reconcile 检出）触发整表重拉；visibilitychange 兜底 ≤5s reconcile 窗口。
  // 归档面一并重拉——归档/恢复后 dataBus 的 projects 失效键走同一条路。
  const refreshProjects = useCallback(() => {
    api.listProjects().then(setProjects).catch(() => {});
    api.listArchivedProjects().then(setArchivedProjects).catch(() => {});
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
    api.listMcp(p.id).then(setMcpRows).catch(() => {});
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
  const refreshPluginRows = useCallback((p: ProjectRow) => {
    api.listPluginState(p.id).then(setPluginRows).catch(() => {});
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
      setMcpRows([]);
      setUpdates(null);
      setGlobalSkillGroups([]);
      setPluginRows([]);
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
      refreshPluginRows(p);
      refreshConfig(p);
      api
        .getStatusline(p.id)
        .then((r) => setStatuslineSource(r.config.source))
        .catch(() => {});
    },
    [refreshMcp, refreshUpdates, refreshGlobalSkills, refreshPluginRows, refreshConfig],
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
    refreshPluginRows(anchor);
    refreshMcp(anchor);
    refreshUpdates(anchor);
  }, [selected, projects, refreshGlobalSkills, refreshPluginRows, refreshMcp, refreshUpdates]);

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
        const n = a.relPath.match(/^[^/]+\/skills\/([^/]+)\//)?.[1];
        if (n) s.add(n);
      }
    }
    return s;
  }, [globalSkillGroups, assets]);

  const assetCounts = useMemo(() => {
    const skillNames = new Set<string>();
    for (const a of assets) {
      if (a.category === 'skill') {
        const n = a.relPath.match(/^[^/]+\/skills\/([^/]+)\//)?.[1];
        if (n) skillNames.add(n);
      }
    }
    const mcp = mcpRows.filter((r) => r.harness === 'claude').length;
    return { skill: skillNames.size, mcp };
  }, [assets, mcpRows]);

  // Machine-wide skills actually in effect: a plugin group that is switched
  // off contributes nothing. The enable state is re-derived from the live map
  // (same rule as the section pills in CategoryDetail) rather than trusting
  // the group's own `enabled`, which the server can have stale.
  const effectiveGlobalSkills = useMemo(
    () =>
      countEffectiveSkills(
        globalSkillGroups.map((g) => {
          const runtime: PluginRuntime | null = skillSourceRuntime(g.source);
          const enabled =
            g.pluginKey && runtime
              ? pluginEffective(pluginRows, runtime, g.pluginKey)
              : undefined;
          return { enabled, skills: g.skills };
        }),
      ).effective,
    [globalSkillGroups, pluginRows],
  );

  const categoryData = useMemo<CategoryBarData>(() => {
    // 无 project 档的 harness（codex）MCP 行属机器级，两个视图都计数（其页签
    // 两视图可见）；判据 = 行随身带的 installScopes（§4 收编：不再点名 harness）。
    const machineMcp = mcpRows.filter((r) => !r.installScopes.includes('project')).length;
    const scopedMcp = (s: AssetScope) =>
      mcpRows.filter((r) => r.installScopes.includes('project') && r.scope === s).length;
    if (globalMode) {
      const outdatedSkills = (updates?.skills ?? []).filter(
        (u) => u.scope === 'user' && u.outdated,
      ).length;
      const outdatedMcp = (updates?.mcp ?? []).filter(
        (u) => u.scope === 'user' && u.outdated,
      ).length;
      return {
        // machine-wide skills in effect + MCP servers + the global file tree
        // (~/.claude, ~/.codex) — the merged 资源管理 card count
        files:
          effectiveGlobalSkills +
          scopedMcp('user') +
          machineMcp +
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
        scopedMcp('project') +
        machineMcp +
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
  }, [globalMode, globalSkillGroups, mcpRows, updates, assets, globalAssets, assetCounts, pluginRows, effectiveGlobalSkills, statuslineSource, hookRules, selected, allSessions]);

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

  // 服务端写操作后推 invalidate('projects')（如 PUT /projects/order 排序落定），
  // 接到既有的重拉函数上——不再写「成功后手动 refresh」的胶水。
  useEffect(() => registerInvalidator('projects', refreshProjects), [refreshProjects]);

  // 插件启停/安装域变化（invalidate('toolkit')：toolkit 路由 + /plugins/state 与
  // plugin 安装路由）→ 重拉工具行——SkillGrid 徽标与计数同源刷新。
  useEffect(
    () =>
      registerInvalidator('toolkit', () => {
        const target = selected ?? projects[0];
        if (target) refreshPluginRows(target);
      }),
    [selected, projects, refreshPluginRows],
  );

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
          // 空闲订阅落定（批 2）：dashboard 订阅 toast 提醒——会话订阅的通知已由
          // 服务端注入其线程（message.* 帧走面板弹窗），这里不重复打扰。
          if (
            frame.kind === 'watch.fired' &&
            frame.watcherSessionId == null &&
            typeof frame.targetSessionId === 'string'
          ) {
            const row = allSessions?.find((s) => s.sessionId === frame.targetSessionId);
            const label = sessionLabel(row?.title ?? null, frame.targetSessionId);
            // 正文按命中的触发类型措辞（session_watches.onEvents 的那一项）
            const body = t(
              frame.reason === 'turnEnd'
                ? 'tasks.watchTurnEnd'
                : frame.reason === 'messageFailed'
                  ? 'tasks.watchMsgFailed'
                  : 'tasks.watchOn',
              { label },
            );
            show('info', body);
            // toast 之外补系统通知：标签页切走/最小化时 toast 看不见，通知才叫「提醒」
            notifyBrowser(t('tasks.watchNotifyTitle'), body);
          }
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
    async (
      skill: SkillAsset,
      scope: AssetScope = 'project',
      agent: AssetAgent = HARNESS_ORDER[0] ?? 'claude',
    ) => {
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
      agent: AssetAgent = HARNESS_ORDER[0] ?? 'claude',
    ) => {
      if (!selected && !globalMode) return;
      const target = selected ?? projects[0];
      if (!target) return;
      // 卡面规则与视图同源（CategoryDetail rowsFor）：该 harness 的 MCP 面含
      // 当前 scope → 用之；否则回落首档（codex 无 project 档 → user）。
      // 判据出自安装属性矩阵，不再点名 harness（§4 收编）。
      const mcpScopes =
        capabilitiesOf('mcp', installCaps).surfaces.find((s) => s.harness === agent)?.scopes ?? [];
      const effectiveScope = mcpScopes.includes(scope) ? scope : mcpScopes[0] ?? 'user';
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
    [selected, projects, globalMode, installCaps, refreshAssets, refreshMcp, refreshUpdates],
  );

  const handleUninstallSkill = useCallback(
    async (name: string, scope: AssetScope = 'project', agent?: AssetAgent) => {
      const target = selected ?? projects[0];
      if (!target) return;
      const res = await api.uninstall(target.id, {
        category: 'skill',
        name,
        scope,
        ...(agent ? { agent } : {}),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      refreshAssets(target);
      refreshGlobalSkills(target);
      refreshUpdates(target);
    },
    [selected, projects, refreshAssets, refreshGlobalSkills, refreshUpdates],
  );

  // 说明：文件类资产的卸载入口随「文件视图降级为只读」一并撤下（资源管理以插件包为准）；
  // 服务端 POST /projects/:id/uninstall 仍在，日后要恢复入口只需再加回一个 handler。

  const handleUninstallMcp = useCallback(
    async (name: string, scope: AssetScope = 'project', agent?: AssetAgent) => {
      const target = selected ?? projects[0];
      if (!target) return;
      // claude 以外 harness 的 MCP 住用户级文件——卸载恒指用户级（同安装侧判定）。
      const res = await api.uninstall(target.id, {
        category: 'mcp',
        name,
        scope: (agent ?? HARNESS_ORDER[0]) === 'claude' ? scope : 'user',
        ...(agent ? { agent } : {}),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      refreshAssets(target);
      refreshMcp(target);
      refreshUpdates(target);
    },
    [selected, projects, refreshAssets, refreshMcp, refreshUpdates],
  );

  // MCP 启停三态循环（on/off/inherit）：服务端解析 effective 并随行回传，
  // 落盘成功即整表刷新（不乐观覆盖——行数据是唯一事实源）。
  const handleCycleMcpEnable = useCallback(
    async (name: string, next: EnableOverride) => {
      const target = selected ?? projects[0];
      if (!target) return;
      await api.putMcpEnable(target.id, name, next);
      refreshMcp(target);
    },
    [selected, projects, refreshMcp],
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
        ...((category === 'skill' || category === 'mcp') && agent ? { agent } : {}),
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

  /** 归档：确认在 ProjectList（右键菜单）；此处只跑动作 + 汇报清空规模。
   *  被归档的是当前选中项目时切到下一个活跃项目——不留幽灵详情。 */
  const handleArchiveProject = useCallback(
    (p: ProjectRow) =>
      void fb.run(
        `archive:${p.id}`,
        async () => {
          const { purged } = await api.archiveProject(p.id);
          show(
            'success',
            t('toast.projectArchived', {
              name: p.name,
              sessions: purged.sessions,
              events: purged.events,
            }),
          );
          if (selected?.id === p.id) {
            const next = projects.find((x) => x.id !== p.id);
            if (next) loadProject(next);
            else setSelected(null); // 没有活跃项目了 → 主区回落空态
          }
          refreshProjects();
        },
        { fail: (e) => t('errors.archiveFailed', { error: errorText(e) }) },
      ),
    [fb, selected, projects, loadProject, show, t, refreshProjects],
  );
  const handleRestoreProject = useCallback(
    (p: ProjectRow) =>
      void fb.run(
        `restore:${p.id}`,
        async () => {
          await api.restoreProject(p.id);
          show('success', t('toast.projectRestored', { name: p.name }));
          refreshProjects();
        },
        { fail: (e) => t('errors.restoreFailed', { error: errorText(e) }) },
      ),
    [fb, show, t, refreshProjects],
  );
  const restoreActionStateOf = useCallback((id: number) => fb.stateOf(`restore:${id}`), [fb]);

  /** Toggle a plugin's user-scope enable override (on/off) in the host config
   * (Claude settings.json / Codex config.toml). Rows are the single source of
   * truth — no optimistic flip, just refetch (effective is server-resolved).
   * Reloads groups on success so enable badges stay in sync. Throws on failure
   * (caller's fb.run reports). */
  /** 插件逐档启用覆写循环（§4 ②推广·拍板 7-5/7-7 摆放）：档位由控件随行
   *  交来（全局视图 user、项目视图 project/local），此处只落盘与刷新。 */
  const handleCyclePluginState = useCallback(
    async (runtime: PluginRuntime, key: string, scope: ToolScope, state: EnableOverride) => {
      const target = selected ?? projects[0];
      if (!target) return;
      await api.putPluginState(target.id, runtime, key, scope, state);
      refreshPluginRows(target);
      refreshGlobalSkills(target);
    },
    [selected, projects, refreshPluginRows, refreshGlobalSkills],
  );

  /** 卸载 CC 插件包（harness 注册表级；apiFetch 非 2xx 抛错，调用方 fb.run 报错）。 */
  const handleUninstallPlugin = useCallback(
    async (runtime: PluginRuntime, key: string) => {
      const target = selected ?? projects[0];
      if (!target) return;
      await api.uninstallPluginPack(target.id, { runtime, key });
      refreshGlobalSkills(target);
      refreshPluginRows(target);
    },
    [selected, projects, refreshGlobalSkills, refreshPluginRows],
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
    const scope: AssetScope = globalMode ? 'user' : 'project';
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
  // Files match by skill-dir name + the skill's server-set agent — no harness
  // path is written into the client.
  const drawerFiles = useMemo(() => {
    if (!drawerSkill || drawerSkill.scope === 'user') return [];
    const { name, agent } = drawerSkill;
    return assets.filter((a) => {
      const skillName = a.relPath.match(/^[^/]+\/skills\/([^/]+)\//)?.[1];
      return skillName === name && (!agent || a.agent === agent);
    });
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

  // 左右两栏各只挂载一份：桌面 inline 栏与移动滑出抽屉复用同一 JSX（isDesktop
  // 互斥渲染，不会双挂载）。移动端选中项目顺手收抽屉（setMobilePanel(null)
  // 在桌面是空操作）。
  const projectListEl = shellReady ? (
    <ProjectList
      projects={projects}
      selectedId={selected?.id}
      globalActive={globalMode}
      onSelect={(p) => {
        loadProject(p);
        setMobilePanel(null);
      }}
      onSelectGlobal={() => {
        selectGlobal();
        setMobilePanel(null);
      }}
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
      archivedProjects={archivedProjects}
      onArchive={handleArchiveProject}
      onRestore={handleRestoreProject}
      restoreStateOf={restoreActionStateOf}
    />
  ) : (
    <SkeletonRows rows={7} />
  );
  const libraryPanelEl = activeProject ? (
    <LibraryPanel
      installedSkillNames={installedSkillNames}
      onInstallSkill={installSkillSafely}
      onInstallFileAsset={installFileAssetSafely}
      onInstallMcp={installMcpSafely}
      updates={updates}
      onUpdateAsset={updateAssetSafely}
      category={mainCategory}
      scope={globalMode ? 'user' : 'project'}
      capabilities={installCaps}
      projectId={activeProject.id}
      onSyncAll={() => void syncNowWithFeedback(activeProject)}
    />
  ) : (
    <div className="p-3 text-xs text-neutral-500">
      {t('app.selectProjectForAssets')}
    </div>
  );

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragPayload(null)}
    >
      <div className="h-dvh p-0 lg:p-4 bg-neutral-950">
        <div className="h-full flex flex-col rounded-none lg:rounded-2xl border border-white/[0.08] bg-neutral-900/40 shadow-mac overflow-hidden">
          <div className="h-11 shrink-0 flex items-center gap-2 lg:gap-3 px-4 border-b border-white/[0.06] frosted">
            {/* <lg：左右栏收进滑出抽屉，顶栏放两个入口 */}
            <button
              onClick={() => setMobilePanel('projects')}
              className={cn(
                'rounded-lg p-1.5 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60 transition-colors',
                isDesktop && 'hidden',
              )}
              title={t('app.mobileProjects')}
            >
              <PanelLeft className="h-4 w-4" />
            </button>
            <TrafficLight />
            <span className="text-sm font-semibold tracking-tight text-neutral-200">Weave</span>
            <span className="text-xs text-neutral-500">
              {t('app.projectCount', { n: projects.length })}
            </span>
            <button
              onClick={() => setMobilePanel('library')}
              className={cn(
                'rounded-lg p-1.5 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60 transition-colors',
                (isDesktop || !activeProject) && 'hidden',
              )}
              title={t('app.mobileLibrary')}
            >
              <Library className="h-4 w-4" />
            </button>
            {/* GitHub 访问链接（含 star 数；取不到就只显示图标）——设置按钮左边。
                不挂 title：图标语义自明，悬停提示属噪音（保留 aria-label 供读屏）。 */}
            <a
              href={WEAVE_REPO_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="GitHub"
              className="ml-auto inline-flex items-center gap-1 rounded-lg px-1.5 py-1 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60 transition-colors"
            >
              <Github className="h-4 w-4" />
              {stars !== null && (
                <span className="text-[11px] tabular-nums">{formatStars(stars)}</span>
              )}
            </a>
            <button
              onClick={() => setSettingsOpen(true)}
              className="p-1.5 rounded-lg text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60 transition-colors"
              title={t('app.settingsTooltip')}
            >
              <Settings className="h-4 w-4" />
            </button>
            <button
              onClick={() => void logout()}
              className="p-1.5 rounded-lg text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60 transition-colors"
              title={t('auth.logout')}
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>

          <div className="flex flex-1 overflow-hidden">
            {/* Level 1 — global config (pseudo-project) + projects。
                <lg 收进滑出抽屉（见底部 mobilePanel overlay）。 */}
            {isDesktop && (
              <>
                <aside
                  style={{ width: leftW }}
                  className="shrink-0 border-r border-white/[0.06] frosted overflow-y-auto"
                >
                  {projectListEl}
                </aside>
                <Resizer onResize={(d) => setLeftW((w) => clamp(w + d, LEFT_MIN, LEFT_MAX))} title={t('app.resizeLeft')} />
              </>
            )}

            {/* Level 2 + 3 — categories + detail */}
            <main className="flex-1 flex flex-col overflow-hidden relative">
              {activeProject ? (
                <>
                  <div className="px-4 py-2 border-b border-white/[0.06] flex flex-wrap items-center gap-x-3 gap-y-1">
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
                          className="shrink-0 hidden lg:inline-flex rounded-full bg-neutral-800/60 text-neutral-500 px-2.5 py-1 text-[11px]"
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
                    ) : !shellReady ? (
                      // 首次访问：主区（分类栏 + 技能/资产列表）用骨架顶住
                      <SkeletonMain />
                    ) : (
                      <CategoryDetail
                        projectId={activeProject!.id}
                        mode={mode}
                        category={mainCategory}
                        resourceView={resourceView}
                        onResourceViewChange={setResourceView}
                        statuslineNonce={statuslineNonce}
                        assets={assets}
                        globalAssets={globalAssets}
                        mcpRows={mcpRows}
                        updates={updates}
                        globalSkillGroups={globalSkillGroups}
                        pluginRows={pluginRows}
                        statuslineSource={statuslineSource}
                        onUninstallSkill={handleUninstallSkill}
                        onUninstallMcp={handleUninstallMcp}
                        onCycleMcpEnable={handleCycleMcpEnable}
                        onCyclePluginState={handleCyclePluginState}
                        onUninstallPlugin={handleUninstallPlugin}
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
                  agent={selectedAsset?.agent}
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
                  readOnly={!globalMode && drawerSkill.scope === 'user'}
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

            {/* Right — installable asset library, scope follows the active context。
                <lg 同样收进滑出抽屉。 */}
            {isDesktop && (
              <>
                {/* Sign matters: this handle sits to the LEFT of the panel, so
                    dragging left (negative delta) has to make it wider. */}
                <Resizer onResize={(d) => setRightW((w) => clamp(w - d, RIGHT_MIN, RIGHT_MAX))} title={t('app.resizeRight')} />
                <aside
                  style={{ width: rightW }}
                  className="shrink-0 border-l border-white/[0.06] frosted overflow-hidden"
                >
                  {libraryPanelEl}
                </aside>
              </>
            )}
          </div>
        </div>
      </div>

      {/* <lg：左右栏滑出抽屉——与桌面栏复用同一 JSX 常量（isDesktop 互斥，不双挂载） */}
      {!isDesktop && mobilePanel !== null && (
        <div className="fixed inset-0 z-40">
          <button
            aria-label={t('app.mobileDrawerClose')}
            onClick={() => setMobilePanel(null)}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm drawer-fade"
          />
          <aside
            className={cn(
              'absolute top-0 bottom-0 w-[min(88vw,360px)] bg-neutral-900 border-white/[0.08] shadow-mac flex flex-col',
              mobilePanel === 'projects'
                ? 'left-0 border-r drawer-left'
                : 'right-0 border-l drawer-right',
            )}
          >
            <div className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-white/[0.06] frosted">
              <span className="text-sm font-semibold tracking-tight text-neutral-200">
                {mobilePanel === 'projects' ? t('app.mobileProjects') : t('app.mobileLibrary')}
              </span>
              <button
                onClick={() => setMobilePanel(null)}
                className="ml-auto rounded-lg p-1.5 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60 transition-colors"
                title={t('app.mobileDrawerClose')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {mobilePanel === 'projects' ? (
              <div className="flex-1 overflow-y-auto">{projectListEl}</div>
            ) : (
              <div className="flex-1 overflow-hidden">{libraryPanelEl}</div>
            )}
          </aside>
        </div>
      )}

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {/* 右下角 AI 助手（配置齐才显示按钮；系统上下文由服务端注入） */}
      <AiAssistant />
    </DndContext>
  );
}

function TrafficLight() {
  return (
    <div className="hidden sm:flex gap-1.5 shrink-0">
      <span className="h-3 w-3 rounded-full bg-mac-red" />
      <span className="h-3 w-3 rounded-full bg-mac-yellow" />
      <span className="h-3 w-3 rounded-full bg-mac-green" />
    </div>
  );
}
