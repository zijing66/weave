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
  type OrchestrationRow,
  type McpServerConfig,
  type McpRow,
  type ProjectRow,
  type SkillAsset,
  type StatuslineSource,
  type UpdateReport,
  type ProjectUpdateSummary,
  type GlobalSkillGroup,
  type PluginRow,
  type PluginRuntime,
  type GlobalSkillSource,
  type InstallCapabilities,
} from '@/lib/api';
import { canInstall, capabilitiesOf, type DragPayload } from '@/lib/install-capabilities';
import { HARNESS_ORDER } from '@/lib/harness-meta';
import type { EnableOverride, ToolScope } from '@weavecode/core/tool';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { registerInvalidator, subscribeFrame, subscribeHook, subscribePush } from '@/lib/sse';
import { sessionLabel } from '@/lib/hook-payload';
import { notifyBrowser } from '@/lib/browser-notify';
import { ProjectList } from '@/components/ProjectList';
import { useSessionStatus } from '@/components/tasks/session-status-store';
import { CategoryBar, type MainCategory, type CategoryBarData } from '@/components/CategoryBar';
import { CategoryDetail, type Mode, type ResourceView } from '@/components/CategoryDetail';
import { DashboardOverview } from '@/components/DashboardOverview';
import { SkillDetailDrawer } from '@/components/SkillDetailDrawer';
import { LibraryPanel } from '@/components/LibraryPanel';
import { FileViewer } from '@/components/FileViewer';
import { Resizer } from '@/components/Resizer';
import { SettingsModal } from '@/components/SettingsModal';
import { cn } from '@/lib/utils';
import { countEffectiveSkills } from '@/lib/skill-stats';
import { navigate, parseRoute, useRoutePath } from '@/lib/route';
import { toggleTheme, useTheme } from '@/lib/theme';
import { useT } from '@/i18n/I18nProvider';
import { useMediaQuery } from '@/lib/use-media-query';
import { ChevronDown, Github, Library, LogOut, Moon, PanelLeft, Settings, Sun, X } from 'lucide-react';
import type { MessageKey } from '@/i18n/dict';
import { useToast } from '@/components/Toast';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import { logout, refreshAuth, useAuthState } from '@/lib/auth';
import { WEAVE_REPO_URL, formatStars, useRepoStars } from '@/lib/github';
import { LoginPage } from '@/components/LoginPage';
import { BootSplash } from '@/components/BootSplash';
import { WeaveLogo } from '@/components/WeaveLogo';
import { AiAssistant } from '@/components/AiAssistant';
import { SkeletonMain, SkeletonRows } from '@/components/ui/skeleton';
import { createAwaitGate } from '@/lib/await-gate';

const LEFT_MIN = 176;
const LEFT_MAX = 320;
const RIGHT_MIN = 260;
const RIGHT_MAX = 440;
/** 开终端后等角标上涨的上限：窗口起来 + cwd 上报 + 对账那一拍（服务端 600ms
 *  后自对账）通常 1~2s；口径只在可枚举的终端后端上成立，探不到就照旧提前收圈，
 *  别把按钮钉在转圈上。 */
const OPEN_TERMINAL_COUNT_MS = 8_000;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** 「n 个更新」展开面的一行。 */
interface UpdateRow {
  kind: MessageKey;
  name: string;
  scope: AssetScope | null;
  note: string | null;
}
const UPDATE_SCOPE_KEY = { project: 'skillGrid.scopeProject', user: 'skillGrid.scopeUser' } as const;

/** 生效查表（链解析在服务端，前端只读行上的 effective）。 */
const pluginEffective = (rows: readonly PluginRow[], runtime: PluginRuntime, key: string): boolean =>
  rows.some((r) => r.harness === runtime && r.key === key && r.effective);

/**
 * 认证门：未探测 → 启动页（不闪内容）；未登录 → **默认落登录页**（仅密码，
 * 无改密入口——改密只走 CLI）；已登录 → 原 dashboard 本体。
 * 任一 API 401 / SSE 被拒也会把状态打回 anonymous（见 lib/api.ts、lib/sse.ts）。
 */
export default function App() {
  const auth = useAuthState();
  useEffect(() => {
    void refreshAuth();
  }, []);
  // 启动页在认证探测期间就挂上（此时下面什么都还没渲染），一路活到「登录页出现」
  // 或「dashboard 首份数据就位」——换挂载点会让那段生长动画重头再来一遍。
  const [bootReady, setBootReady] = useState(false);
  const handleBootReady = useCallback(() => setBootReady(true), []);
  return (
    <>
      {auth === 'anonymous' && <LoginPage />}
      {auth === 'authenticated' && <Dashboard onBootReady={handleBootReady} />}
      <BootSplash ready={auth === 'anonymous' || (auth === 'authenticated' && bootReady)} />
    </>
  );
}

function Dashboard({ onBootReady }: { onBootReady: () => void }) {
  const t = useT();
  // 项目列表 + 归档面（TanStack Query 缓存域·试点，后续域逐个并入）：fetch/缓存/
  // 失效归 useQuery，重拉统一走 refreshProjects()（= invalidateQueries——SSE 帧
  // 与变更后的落定都指它）。refetchOnWindowFocus 覆写全局缺省：后台 daemon 侧
  // reconcile 有 ≤5s 窗口，切回标签页补一枪（替掉原手挂的 visibilitychange 监听）。
  const queryClient = useQueryClient();
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
    staleTime: Infinity,
    refetchOnWindowFocus: 'always',
    retry: false,
  });
  const archivedQuery = useQuery({
    queryKey: ['projects', 'archived'],
    queryFn: () => api.listArchivedProjects(),
    staleTime: Infinity,
    refetchOnWindowFocus: 'always',
    retry: false,
  });
  const projects = projectsQuery.data ?? [];
  const archivedProjects = archivedQuery.data ?? [];
  const refreshProjects = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  }, [queryClient]);
  // 首屏门：项目列表回来前，左侧列表与主区用骨架屏顶住——首次访问不再「先空一下再蹦」。
  // 同一个门也给启动页（App 的 BootSplash）放行；查询失败同样算就位，别把启动页焊在屏幕上。
  const shellReady = !projectsQuery.isPending;
  useEffect(() => {
    if (shellReady) onBootReady();
  }, [shellReady, onBootReady]);
  /** 位置（`lib/route.ts`）：URL 是唯一真源，手势只写它，状态由下面那条 effect 落。 */
  const path = useRoutePath();
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
  const { sessions: allSessions, projectStats, statuses: sessionStatuses } = useSessionStatus();
  // 全局总览跳进项目任务视图的初始选中会话（离开任务视图即失效）。
  const [initialSessionId, setInitialSessionId] = useState<string | null>(null);
  // All hook rules (global + per project) — drives the Weave card count; the
  // panel refetches its own copy after every mutation.
  const [hookRules, setHookRules] = useState<HookRule[]>([]);
  // 全部编排定义（不分项目）——编排卡计数按当前视图过滤；画布改了定义会
  // 发 `weave:orchestrations-changed` 让这里重拉。
  const [orchestrations, setOrchestrations] = useState<OrchestrationRow[]>([]);
  // MCP 工具行（每行一个 (harness, scope) 面；enable/effective 服务端算好）。
  const [mcpRows, setMcpRows] = useState<McpRow[]>([]);
  const [updates, setUpdates] = useState<UpdateReport | null>(null);
  /** 「n 个更新」标签的展开态：点开看这批更新到底是谁。 */
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [globalSkillGroups, setGlobalSkillGroups] = useState<GlobalSkillGroup[]>([]);
  const [pluginRows, setPluginRows] = useState<PluginRow[]>([]);
  // Per-project update summary — hover-lazy + cached per project id. Carries
  // both the badge count and the 「待 init」 reminder (same fetch, one cache).
  const [updatesMap, setUpdatesMap] = useState<
    Record<number, { available: number; needsInit: boolean }>
  >({});
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
  const themeMode = useTheme();
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

  // 首拉失败（还没有任何数据可显示）toast 报因；此后刷新失败静默——与旧 fetcher
  // 的口径一致（refreshProjects 的 catch 本来就吞错）。
  useEffect(() => {
    if (projectsQuery.isError && projectsQuery.data === undefined) {
      setError(String(projectsQuery.error));
    }
  }, [projectsQuery.isError, projectsQuery.data, projectsQuery.error, setError]);

  // 安装属性矩阵（静态）：启动拉一次，下发 LibraryPanel（M6 拖拽 canDrop 也用）。
  const [installCaps, setInstallCaps] = useState<InstallCapabilities | null>(null);
  useEffect(() => {
    api.capabilities().then(setInstallCaps).catch(() => {});
  }, []);

  // 拖拽中的统一 payload（onDragStart 提升）：落点 canInstall 判定与落定分派共用。
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);

  // 归档面与 SSE/变更刷新的说明见顶部查询块（['projects'] 前缀两面齐刷）。

  // 项目行拖拽排序落定：乐观重排（落点即时反馈），持久化失败回滚到服务端
  // 真值并报因（失败不静默）。乐观更新直接写查询缓存（setQueryData）。
  const handleProjectReorder = useCallback(
    (ids: number[]) => {
      queryClient.setQueryData<ProjectRow[]>(['projects'], (prev) => {
        if (!prev) return prev;
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
    [queryClient, setError, t, refreshProjects],
  );

  // 项目卡终端角标（已开终端数，单位 = 可见屏幕）：纯 push 帧驱动——SSE 接入即补上次快照
  // 首帧、后台对账后推差量。前端零请求零定时器：探测要 spawn `wezterm cli`，
  // 任何前端主动拉都会把 spawn 带回请求关键路径。
  const [terminalCounts, setTerminalCounts] = useState<Record<number, number>>({});
  /** 「开终端」loading 的放行闸：等的是角标上涨（= 那个窗口真起来了）——
   *  同开会话/新建会话两个按钮的口径，见 lib/await-gate.ts。 */
  const countsRef = useRef(terminalCounts);
  countsRef.current = terminalCounts;
  const terminalGate = useRef(createAwaitGate(OPEN_TERMINAL_COUNT_MS));
  useEffect(() => {
    terminalGate.current.poke();
  }, [terminalCounts]);
  useEffect(() => () => terminalGate.current.releaseAll(), []);

  const refreshAssets = useCallback((p: ProjectRow) => {
    api.listAssets(p.path).then(setAssets).catch(() => {});
  }, []);

  const refreshMcp = useCallback((projectId: number) => {
    api.listMcp(projectId).then(setMcpRows).catch(() => {});
  }, []);

  // `listUpdates` 每轮都要在项目里起 git 子进程（Windows 上数百毫秒），而 `asset`
  // 帧是成批到的——同一项目的在飞请求直接复用，别一帧一次。
  const updatesFlight = useRef<Map<number, Promise<UpdateReport>>>(new Map());
  const fetchUpdates = useCallback((projectId: number): Promise<UpdateReport> => {
    const flying = updatesFlight.current.get(projectId);
    if (flying) return flying;
    const p = api.listUpdates(projectId).finally(() => updatesFlight.current.delete(projectId));
    updatesFlight.current.set(projectId, p);
    return p;
  }, []);

  const refreshUpdates = useCallback(
    (projectId: number) => {
      fetchUpdates(projectId).then(setUpdates).catch(() => {});
    },
    [fetchUpdates],
  );

  // 选中项目的既有 updates 刷新结果回填行计数缓存 —— 顶栏/任务页与行内按钮
  // 共用同一份取数，不为行列表单独再拉。
  useEffect(() => {
    if (selected && updates) {
      setUpdatesMap((prev) => ({
        ...prev,
        [selected.id]: { available: updates.available, needsInit: updates.needsInit },
      }));
    }
  }, [updates, selected]);

  // 「n 个更新」点开的明细：与 available 同一口径（可代写的过期项），逐项一句话。
  // 换项目/更新清零时收起，免得展开的面指向别处。
  useEffect(() => setUpdatesOpen(false), [selected?.id, updates?.available]);

  const updateRows = useMemo<UpdateRow[]>(() => {
    if (!updates) return [];
    return [
      ...updates.skills
        .filter((u) => !u.custom && u.outdated)
        .map((u): UpdateRow => ({ kind: 'app.updateKindSkill', name: u.name, scope: u.scope, note: null })),
      ...updates.mcp
        .filter((u) => !u.custom && u.outdated)
        .map((u): UpdateRow => ({ kind: 'app.updateKindMcp', name: u.name, scope: u.scope, note: null })),
      ...updates.files
        .filter((u) => !u.custom && u.outdated)
        .map((u): UpdateRow => ({ kind: 'app.updateKindFile', name: u.name, scope: u.scope, note: null })),
      ...(updates.pluginTemplates ?? [])
        .filter((u) => u.outdated)
        .map((u): UpdateRow => ({ kind: 'app.updateKindTemplate', name: u.name, scope: null, note: u.pluginId })),
      ...(updates.initFiles ?? [])
        .filter((u) => u.outdated && u.syncClass === 'auto')
        .map((u): UpdateRow => ({ kind: 'app.updateKindInit', name: u.relPath, scope: null, note: null })),
    ];
  }, [updates]);

  const refreshGlobalSkills = useCallback((projectId: number) => {
    api.listGlobalSkills(projectId).then(setGlobalSkillGroups).catch(() => {});
  }, []);
  const refreshPluginRows = useCallback((projectId: number) => {
    api.listPluginState(projectId).then(setPluginRows).catch(() => {});
  }, []);

  // 行内 updates 计数：行 hover 懒加载 + 按 id 缓存（listUpdates 要算指纹，
  // 不做全量预拉）；force 供行同步后重拉。
  const ensureUpdates = useCallback(
    (projectId: number, force = false) => {
      if (!force && updatesMap[projectId] !== undefined) return;
      fetchUpdates(projectId)
        .then((r) => {
          setUpdatesMap((prev) => ({
            ...prev,
            [projectId]: { available: r.available, needsInit: r.needsInit },
          }));
        })
        .catch(() => {});
    },
    [updatesMap, fetchUpdates],
  );

  /** Refresh the hooks rule set (card count). */
  const refreshHookRules = useCallback(() => {
    api.listHooksRules().then(setHookRules).catch(() => {});
  }, []);

  useEffect(() => {
    refreshHookRules();
  }, [refreshHookRules]);

  /** Refresh the orchestration definitions (编排 card count). */
  const refreshOrchestrations = useCallback(() => {
    api.listOrchestrations().then(setOrchestrations).catch(() => {});
  }, []);

  useEffect(() => {
    refreshOrchestrations();
  }, [refreshOrchestrations]);

  // 编排画布用这个事件回报定义的新增/改名/删除（同 weave:rules-changed）。
  useEffect(() => {
    window.addEventListener('weave:orchestrations-changed', refreshOrchestrations);
    return () =>
      window.removeEventListener('weave:orchestrations-changed', refreshOrchestrations);
  }, [refreshOrchestrations]);

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
      refreshMcp(p.id);
      refreshUpdates(p.id);
      refreshGlobalSkills(p.id);
      refreshPluginRows(p.id);
      api
        .getStatusline(p.id)
        .then((r) => setStatuslineSource(r.config.source))
        .catch(() => {});
    },
    [refreshMcp, refreshUpdates, refreshGlobalSkills, refreshPluginRows],
  );

  /** 进入全局伪项目。全局数据是机器级的，任何一个已注册项目都能当读锚点；
   *  一个项目都没有时也要进得去——机器级的那几面（任务 / 资源市场 / 全局技能）
   *  本就不认锚点，认锚点的那几面由各自面板落空态。 */
  const selectGlobal = useCallback(() => {
    const anchor = selected ?? projects[0];
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
    // 全局装面也走项目路由，但服务端对这几个 id 只当占位：技能面板不认它
    // （无项目时 0 号照取），插件/MCP/更新认（404 → 空态），无锚点时用 0。
    const projectId = anchor?.id ?? 0;
    refreshGlobalSkills(projectId);
    refreshPluginRows(projectId);
    refreshMcp(projectId);
    refreshUpdates(projectId);
  }, [selected, projects, refreshGlobalSkills, refreshPluginRows, refreshMcp, refreshUpdates]);

  // 开机落在全局伪项目——项目列表空着也照落（全局面不认锚点，一个项目都没有时
  // 它就是唯一站得住的地方）。「还没选中任何东西」（无项目且非全局）只可能是开机
  // 这一瞬——其余每条导航路径都会把两者之一置上——所以导航之后这里不会复发。
  useEffect(() => {
    // 等列表落了定再落点：有项目时锚点要用它（0 号占位取不到插件/MCP/更新）
    if (globalMode || selected || !shellReady) return;
    // 深链还在落（地址已经指明去哪）就别抢，否则刷新 /p/3/tasks 会被拽回全局
    if (parseRoute(path).kind !== 'none') return;
    selectGlobal();
    navigate({ kind: 'global', category: mainCategory }, { replace: true });
  }, [globalMode, selected, shellReady, selectGlobal, path, mainCategory]);

  // URL → 状态（唯一落点）：手势与后退/前进都只改地址，再由这里落成 state。
  // 反过来「状态 → URL」只有手势那几处 navigate，两向不互相触发。
  useEffect(() => {
    if (!shellReady) return;
    const route = parseRoute(path);
    if (route.kind === 'none') return;
    if (route.kind === 'global') {
      if (!globalMode) selectGlobal();
      setMainCategory(route.category);
      setInitialSessionId(null);
      return;
    }
    const target = projects.find((p) => p.id === route.projectId);
    if (!target) {
      // 项目没了（归档/删除）的旧链接：落到全局，别留一个指不到项目的地址
      navigate({ kind: 'global', category: 'tasks' }, { replace: true });
      return;
    }
    if (globalMode || selected?.id !== target.id) loadProject(target);
    setMainCategory(route.category);
    setInitialSessionId(route.sessionId);
  }, [path, shellReady, projects, globalMode, selected, loadProject, selectGlobal]);

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
        orchestrations: orchestrations.length,
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
      // 项目编排 = 起点在该项目的那些（与画布的服务端过滤同口径）。
      orchestrations: orchestrations.filter((o) => o.projectId === selected?.id).length,
    };
  }, [globalMode, globalSkillGroups, mcpRows, updates, assets, globalAssets, assetCounts, pluginRows, effectiveGlobalSkills, statuslineSource, hookRules, selected, allSessions, orchestrations]);

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
        if (target) refreshPluginRows(target.id);
      }),
    [selected, projects, refreshPluginRows],
  );

  // 项目注册表变更帧：整表重拉后 ProjectList 自然出现新项目。
  useEffect(() => subscribeFrame('project', refreshProjects), [refreshProjects]);

  // 空闲订阅落定（批 2）：dashboard 订阅 toast 提醒——会话订阅的通知已由服务端
  // 注入其线程（message.* 帧走面板弹窗），这里不重复打扰。新挂起待答（AskUserQuestion /
  // 计划 / 权限确认）同样只提醒——刻意不自动弹作答框，作答入口恒为手动点会话行的提问图标
  // （问题面另拉，帧只带计数）。
  useEffect(
    () =>
      subscribeHook(
        (frame) => {
          if (frame.kind === 'watch.fired') {
            if (frame.watcherSessionId != null || typeof frame.targetSessionId !== 'string') return;
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
            // （tag 与 Web Push 载荷同值——页面开/关两条通道先后到达只显示一条）
            void notifyBrowser(t('tasks.watchNotifyTitle'), body, `weave-watch-${frame.targetSessionId}`);
            return;
          }
          if (typeof frame.sessionId !== 'string') return;
          const row = allSessions?.find((s) => s.sessionId === frame.sessionId);
          const label = sessionLabel(row?.title ?? null, frame.sessionId);
          const body = t('tasks.questionPending', { label });
          show('info', body);
          void notifyBrowser(t('tasks.questionPendingTitle'), body, `weave-question-${frame.sessionId}`);
        },
        ['watch.fired', 'question.pending'],
      ),
    // 旧巨型 handler 的依赖数组漏了 allSessions/t（toast 找会话名用挂载时的旧表）——
    // 拆开后各自补齐，陈旧闭包随之消掉。
    [allSessions, show, t],
  );

  // 数据帧：后端已算好的载荷直接写状态（终端角标 / 项目行更新角标）。
  // 终端数（可见屏幕）：隐藏刷新器推的绝对值快照（会话所在屏幕的另一半在会话状态总线）。
  useEffect(
    () =>
      subscribePush<{ counts: Record<number, number> }>('terminalTopology', (p) =>
        setTerminalCounts(p.counts),
      ),
    [],
  );
  // 项目更新摘要（角标条数 + 待 init 提醒）：绝对值快照整体覆盖（含 0/false =
  // 归零）——与 hover 懒拉共用同一个 updatesMap，push 到达后即以它为准，不双源。
  useEffect(
    () =>
      subscribePush<{ counts: Record<number, ProjectUpdateSummary> }>('updates', (p) =>
        setUpdatesMap(p.counts ?? {}),
      ),
    [],
  );

  // asset 变更帧：只 patch 命中当前项目的行（selected 走 ref 读、不进依赖数组，
  // 否则每切一次项目就断线重连）。
  useEffect(
    () =>
      subscribeFrame<AssetChangeEvent>('asset', (change) => {
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
        if (change.category === 'mcp') refreshMcp(sel.id);
        if (change.category === 'skill') refreshGlobalSkills(sel.id);
        // any asset change may affect update availability
        refreshUpdates(sel.id);
      }),
    [refreshMcp, refreshUpdates, refreshGlobalSkills],
  );

  // 安装/卸载/更新 handler 失败必抛（同 handleSyncAll）：文案归调用方的 fb.run /
  // 兜底 catch——handler 内先报错又正常 resolve 的话，调用方会在失败时也弹成功。
  /** 单装与批量共用的裸调用：只发请求不刷新（批量装完统一刷一次，别 N×3 次）。 */
  const installSkillRaw = useCallback(
    async (skill: SkillAsset, scope: AssetScope, agent: AssetAgent) => {
      if (!selected && !globalMode) return null;
      const target = selected ?? projects[0];
      // user 档落在 home 下、与项目无关：全局面没有项目也照装（id 只是路由占位）。
      if (!target && !(globalMode && scope === 'user')) return null;
      const projectId = target?.id ?? 0;
      const res = await api.install(projectId, {
        category: 'skill',
        name: skill.name,
        sourceDir: skill.dirPath,
        scope,
        agent,
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return { target, projectId };
    },
    [selected, projects, globalMode],
  );

  const refreshAfterInstall = useCallback(
    (target: ProjectRow | undefined, projectId: number) => {
      if (target) refreshAssets(target);
      refreshGlobalSkills(projectId);
      refreshUpdates(projectId);
    },
    [refreshAssets, refreshGlobalSkills, refreshUpdates],
  );

  const handleInstallSkill = useCallback(
    async (
      skill: SkillAsset,
      scope: AssetScope = 'project',
      agent: AssetAgent = HARNESS_ORDER[0] ?? 'claude',
    ) => {
      const r = await installSkillRaw(skill, scope, agent);
      if (r) refreshAfterInstall(r.target, r.projectId);
    },
    [installSkillRaw, refreshAfterInstall],
  );

  /** 批量安装：逐条装、单条失败不中断，返回没装上的那些（面板留着勾让人再点）。 */
  const handleInstallSkillsBatch = useCallback(
    async (list: SkillAsset[], scope: AssetScope, agent: AssetAgent): Promise<SkillAsset[]> => {
      const failed: SkillAsset[] = [];
      let last: { target: ProjectRow | undefined; projectId: number } | null = null;
      for (const skill of list) {
        try {
          const r = await installSkillRaw(skill, scope, agent);
          if (!r) throw new Error('no install target');
          last = r;
        } catch {
          failed.push(skill);
        }
      }
      if (last) refreshAfterInstall(last.target, last.projectId);
      return failed;
    },
    [installSkillRaw, refreshAfterInstall],
  );

  /** Install a single-file asset (command / agent / workflow / rule / output-style). */
  const handleInstallFileAsset = useCallback(
    async (file: FileAssetTemplate, scope: AssetScope = 'project') => {
      if (!selected && !globalMode) return;
      const target = selected ?? projects[0];
      if (!target && !(globalMode && scope === 'user')) return;
      const projectId = target?.id ?? 0;
      const res = await api.install(projectId, {
        category: file.category,
        name: file.name,
        sourceFile: file.filePath,
        scope,
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      if (target) refreshAssets(target);
      refreshUpdates(projectId);
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
      // 卡面规则与视图同源（CategoryDetail rowsFor）：该 harness 的 MCP 面含
      // 当前 scope → 用之；否则回落首档（codex 无 project 档 → user）。
      // 判据出自安装属性矩阵，不再点名 harness（§4 收编）。
      const mcpScopes =
        capabilitiesOf('mcp', installCaps).surfaces.find((s) => s.harness === agent)?.scopes ?? [];
      const effectiveScope = mcpScopes.includes(scope) ? scope : mcpScopes[0] ?? 'user';
      if (!target && !(globalMode && effectiveScope === 'user')) return;
      const projectId = target?.id ?? 0;
      const res = await api.install(projectId, {
        category: 'mcp',
        name,
        mcpConfig: config,
        scope: effectiveScope,
        agent,
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      if (target) refreshAssets(target);
      refreshMcp(projectId);
      refreshUpdates(projectId);
    },
    [selected, projects, globalMode, installCaps, refreshAssets, refreshMcp, refreshUpdates],
  );

  const handleUninstallSkill = useCallback(
    async (name: string, scope: AssetScope = 'project', agent?: AssetAgent) => {
      const target = selected ?? projects[0];
      // user 档落在 home 下、与项目无关：全局面没有项目也照卸（id 只是路由占位）。
      if (!target && !(globalMode && scope === 'user')) return;
      const projectId = target?.id ?? 0;
      const res = await api.uninstall(projectId, {
        category: 'skill',
        name,
        scope,
        ...(agent ? { agent } : {}),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      if (target) refreshAssets(target);
      refreshGlobalSkills(projectId);
      refreshUpdates(projectId);
    },
    [selected, projects, globalMode, refreshAssets, refreshGlobalSkills, refreshUpdates],
  );

  // 说明：文件类资产的卸载入口随「文件视图降级为只读」一并撤下（资源管理以插件包为准）；
  // 服务端 POST /projects/:id/uninstall 仍在，日后要恢复入口只需再加回一个 handler。

  const handleUninstallMcp = useCallback(
    async (name: string, scope: AssetScope = 'project', agent?: AssetAgent) => {
      const target = selected ?? projects[0];
      // claude 以外 harness 的 MCP 住用户级文件——卸载恒指用户级（同安装侧判定）。
      const effectiveScope: AssetScope = (agent ?? HARNESS_ORDER[0]) === 'claude' ? scope : 'user';
      // 同上：用户级装卸与项目无关，没有项目时 0 号只是形状上的占位。
      if (!target && !(globalMode && effectiveScope === 'user')) return;
      const projectId = target?.id ?? 0;
      const res = await api.uninstall(projectId, {
        category: 'mcp',
        name,
        scope: effectiveScope,
        ...(agent ? { agent } : {}),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      if (target) refreshAssets(target);
      refreshMcp(projectId);
      refreshUpdates(projectId);
    },
    [selected, projects, globalMode, refreshAssets, refreshMcp, refreshUpdates],
  );

  // MCP 启停三态循环（on/off/inherit）：服务端解析 effective 并随行回传，
  // 落盘成功即整表刷新（不乐观覆盖——行数据是唯一事实源）。
  const handleCycleMcpEnable = useCallback(
    async (name: string, next: EnableOverride) => {
      const target = selected ?? projects[0];
      if (!target) return;
      await api.putMcpEnable(target.id, name, next);
      refreshMcp(target.id);
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
        refreshUpdates(p.id);
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
      refreshUpdates(target.id);
      refreshAssets(target);
      if (category === 'mcp') refreshMcp(target.id);
      if (category === 'skill') refreshGlobalSkills(target.id);
    },
    [selected, projects, refreshUpdates, refreshAssets, refreshMcp, refreshGlobalSkills],
  );

  // 行内与顶栏共用的反馈包装：state 按 key 记（行内按项目 id，顶栏用 current/all）。
  const syncActionStateOf = useCallback((id: number) => fb.stateOf(`sync:${id}`), [fb]);
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
      失败 toast；成功无 toast——窗口弹出本身就是反馈。
      **终端那把 loading 挂到角标上涨为止**（同「打开会话」「新建会话」口径：窗口
      真起来才收圈）；explorer 没有可观测的落点，仍以请求返回为准。 */
  const openProjectWithFeedback = useCallback(
    (p: ProjectRow, target: 'explorer' | 'terminal') =>
      void fb.run(
        `open-${target}:${p.id}`,
        async () => {
          // 开终端后的角标对账在服务端做（新窗 cwd 上报有一拍延迟，600ms 后探
          // 一次、差量走 push 帧）——前端不再拉 /terminals/counts。
          const before = countsRef.current[p.id] ?? 0;
          await api.openProject(p.id, target);
          if (target !== 'terminal') return;
          await terminalGate.current.wait(
            `count:${p.id}`,
            () => (countsRef.current[p.id] ?? 0) > before,
          );
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

  /** 关闭终端条按钮：关掉多选弹窗勾中的那些 pane（cwd 恰为本项目目录，窗口里别
      的目录的 pane 不动）。loading 挂到角标掉下来为止（同开终端口径——窗口真没了
      才收圈）；有 pane 关不掉（wt 只数不关）服务端如实报，toast 带修法，不静默。 */
  const closeProjectTerminal = useCallback(
    (p: ProjectRow, paneIds: string[]) =>
      void fb.run(
        `close-terminal:${p.id}`,
        async () => {
          const before = countsRef.current[p.id] ?? 0;
          const res = await api.closeProjectTerminal(p.id, paneIds);
          await terminalGate.current.wait(
            `close:${p.id}`,
            () => (countsRef.current[p.id] ?? 0) < before,
          );
          show('success', t('toast.terminalsClosed', { n: res.closed }));
        },
        { fail: (e) => t('errors.closeTerminalFailed', { error: errorText(e) }) },
      ),
    [fb, show, t],
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
            navigate(
              next
                ? { kind: 'project', projectId: next.id, category: 'tasks', sessionId: null }
                : { kind: 'global', category: 'tasks' },
              { replace: true },
            );
          }
          refreshProjects();
        },
        { fail: (e) => t('errors.archiveFailed', { error: errorText(e) }) },
      ),
    [fb, selected, projects, show, t, refreshProjects],
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
      refreshPluginRows(target.id);
      refreshGlobalSkills(target.id);
    },
    [selected, projects, refreshPluginRows, refreshGlobalSkills],
  );

  /** 卸载 CC 插件包（harness 注册表级；apiFetch 非 2xx 抛错，调用方 fb.run 报错）。 */
  const handleUninstallPlugin = useCallback(
    async (runtime: PluginRuntime, key: string) => {
      const target = selected ?? projects[0];
      if (!target) return;
      await api.uninstallPluginPack(target.id, { runtime, key });
      refreshGlobalSkills(target.id);
      refreshPluginRows(target.id);
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
  const installBuiltinMcpSafely = useCallback(
    (name: string, agent?: AssetAgent) => {
      const projectId = selected?.id;
      if (!projectId) return;
      void api
        .installBuiltinMcp(projectId, name, agent)
        .then(() => {
          show('success', t('mcp.installed', { name }));
          refreshMcp(selected.id);
        })
        .catch((e) => show('error', t('errors.mcpInstallFailed', { error: errorText(e) })));
    },
    [selected, show, t, refreshMcp],
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

  const selectCategory = useCallback(
    (c: MainCategory) => {
      // 换卡即离开会话级（URL 里不再带 sid），由 route effect 落 state
      navigate(
        globalMode || !selected
          ? { kind: 'global', category: c }
          : { kind: 'project', projectId: selected.id, category: c, sessionId: null },
      );
      if (c === 'personalization') setStatuslineNonce((n) => n + 1);
      // reopen → pick up rule changes made elsewhere before the card count shows
      if (c === 'weave') refreshHookRules();
    },
    [globalMode, selected, refreshHookRules],
  );

  /** 全局任务总览行点击：退出全局 → 载入对应项目 → 任务视图选中该会话。 */
  const openSessionInProject = useCallback(
    (projectId: number, sessionId: string) => {
      if (!projects.some((p) => p.id === projectId)) return;
      navigate({ kind: 'project', projectId, category: 'tasks', sessionId });
    },
    [projects],
  );

  /** 任务视图里选中/取消选中会话 → 写 URL（三级位置）。 */
  const selectTaskSession = useCallback(
    (sessionId: string | null) => {
      const projectId = selected?.id ?? projects[0]?.id;
      if (projectId === undefined) return;
      navigate({ kind: 'project', projectId, category: 'tasks', sessionId });
    },
    [selected, projects],
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
  // 全局模式没有锚定项目时内容照渲染：机器级的面认参数语义不认这个 id，认 id 的
  // 那几面（插件 / MCP / 更新）路由会 404、面板落空态。0 = 无项目的占位。
  const anchorId = activeProject?.id ?? 0;
  const showMain = !!activeProject || globalMode;

  // 左右两栏各只挂载一份：桌面 inline 栏与移动滑出抽屉复用同一 JSX（isDesktop
  // 互斥渲染，不会双挂载）。移动端选中项目顺手收抽屉（setMobilePanel(null)
  // 在桌面是空操作）。
  const projectListEl = shellReady ? (
    <ProjectList
      projects={projects}
      selectedId={selected?.id}
      globalActive={globalMode}
      onSelect={(p) => {
        navigate({ kind: 'project', projectId: p.id, category: 'tasks', sessionId: null });
        setMobilePanel(null);
      }}
      onSelectGlobal={() => {
        navigate({ kind: 'global', category: 'tasks' });
        setMobilePanel(null);
      }}
      onOpenExplorer={(p) => openProjectWithFeedback(p, 'explorer')}
      onOpenTerminal={(p) => openProjectWithFeedback(p, 'terminal')}
      openExplorerStateOf={openExplorerStateOf}
      openTerminalStateOf={openTerminalProjectStateOf}
      onCloseTerminal={closeProjectTerminal}
      onHoverProject={ensureUpdates}
      updatesOf={(id) => updatesMap[id]?.available}
      needsInitOf={(id) => updatesMap[id]?.needsInit}
      syncStateOf={syncActionStateOf}
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
  const libraryPanelEl = showMain ? (
    <LibraryPanel
      installedSkillNames={installedSkillNames}
      onInstallSkill={installSkillSafely}
      onInstallSkills={handleInstallSkillsBatch}
      onInstallFileAsset={installFileAssetSafely}
      onInstallMcp={installMcpSafely}
      updates={updates}
      onUpdateAsset={updateAssetSafely}
      category={mainCategory}
      scope={globalMode ? 'user' : 'project'}
      capabilities={installCaps}
      projectId={anchorId}
      // 没有锚定项目就没什么可同步的（一键更新此时只是刷市场缓存，那步自己做完了）
      onSyncAll={activeProject ? () => void syncNowWithFeedback(activeProject) : () => {}}
    />
  ) : !shellReady ? (
    // 首拉未回：还没「选中」，此时给空态文案会闪一下「请选择一个项目」
    <SkeletonRows rows={4} />
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
        <div className="h-full flex flex-col rounded-none lg:rounded-2xl border border-edge/[0.08] bg-neutral-900/40 shadow-mac overflow-hidden">
          <div className="h-11 shrink-0 flex items-center gap-2 lg:gap-3 px-4 border-b border-edge/[0.06] frosted">
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
            {/* 组合标（图形 + 手写 WEAVE 单词）：图形部分固定品牌色，单词吃 currentColor。 */}
            <WeaveLogo className="h-[18px] w-auto text-neutral-200" />
            <span className="text-xs text-neutral-500">
              {t('app.projectCount', { n: projects.length })}
            </span>
            <button
              onClick={() => setMobilePanel('library')}
              className={cn(
                'rounded-lg p-1.5 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60 transition-colors',
                (isDesktop || !showMain) && 'hidden',
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
            {/* 深色 / 浅色切换：图标画的是「按下去会变成哪个」 */}
            <button
              onClick={toggleTheme}
              className="p-1.5 rounded-lg text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60 transition-colors"
              title={themeMode === 'dark' ? t('app.themeToLight') : t('app.themeToDark')}
              aria-label={themeMode === 'dark' ? t('app.themeToLight') : t('app.themeToDark')}
            >
              {themeMode === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
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
                  className="shrink-0 border-r border-edge/[0.06] frosted overflow-y-auto"
                >
                  {projectListEl}
                </aside>
                <Resizer onResize={(d) => setLeftW((w) => clamp(w + d, LEFT_MIN, LEFT_MAX))} title={t('app.resizeLeft')} />
              </>
            )}

            {/* Level 2 + 3 — categories + detail */}
            <main className="flex-1 flex flex-col overflow-hidden relative">
              {showMain ? (
                <>
                  <div className="relative px-4 py-2 border-b border-edge/[0.06] flex flex-wrap items-center gap-x-3 gap-y-1">
                    <div className="min-w-0 flex-1">
                      <h2 className="text-sm font-semibold truncate">
                        {globalMode ? t('app.globalTitle') : (selected?.name ?? '')}
                      </h2>
                      <p className="text-[11px] text-neutral-500 truncate">
                        {globalMode ? t('app.globalSubtitle') : (selected?.path ?? '')}
                      </p>
                    </div>
                    {!globalMode && updates && updates.available > 0 && (
                      // 窄屏外层 display:contents（无盒子，面板退回按表头定位于整行宽），
                      // 桌面才成为定位盒让面板挂在这枚标签上。
                      <span className="contents lg:relative lg:inline-block lg:shrink-0">
                        <button
                          onClick={() => setUpdatesOpen((v) => !v)}
                          aria-expanded={updatesOpen}
                          title={t('app.updateListTip')}
                          className={cn(
                            'shrink-0 inline-flex items-center gap-1 rounded-full bg-orange-900/40 text-orange-300 px-2.5 py-1 text-xs font-medium hover:bg-orange-900/60',
                            updatesOpen && 'ring-1 ring-orange-500/50',
                          )}
                        >
                          {updates.available === 1
                            ? t('app.updateCountOne')
                            : t('app.updateCount', { n: updates.available })}
                          <ChevronDown
                            className={cn('h-3 w-3 transition-transform', updatesOpen && 'rotate-180')}
                          />
                        </button>
                        {updatesOpen && (
                          <>
                            <div className="fixed inset-0 z-20" onClick={() => setUpdatesOpen(false)} />
                            <div className="absolute left-4 right-4 top-full z-30 mt-1 overflow-hidden rounded-xl border border-edge/[0.08] bg-neutral-900 shadow-mac lg:left-auto lg:right-0 lg:w-[320px]">
                              <p className="border-b border-edge/[0.06] px-3 py-2 text-[11px] text-neutral-500">
                                {t('app.updateListTitle', { n: updateRows.length })}
                              </p>
                              <ul className="max-h-[min(45dvh,320px)] overflow-y-auto py-1">
                                {updateRows.map((row) => (
                                  <li key={`${row.kind}:${row.name}`} className="flex items-baseline gap-2 px-3 py-1">
                                    <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                                      {t(row.kind)}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-xs text-neutral-200" title={row.name}>
                                      {row.name}
                                    </span>
                                    {row.scope && (
                                      <span className="shrink-0 text-[10px] text-neutral-500">
                                        {t(UPDATE_SCOPE_KEY[row.scope])}
                                      </span>
                                    )}
                                    {row.note && (
                                      <span className="shrink-0 text-[10px] text-neutral-500">{row.note}</span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          </>
                        )}
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
                    {/* 会进 git 的 init 文件漂移了：同步域不代写，提醒去终端跑 init。 */}
                    {!globalMode && updates?.needsInit && (
                      <span
                        className="shrink-0 inline-flex items-center gap-1 rounded-full bg-amber-900/40 text-amber-300 px-2.5 py-1 text-xs font-medium"
                        title={t('project.needsInitTip')}
                      >
                        {t('project.needsInit')}
                      </span>
                    )}
                    {!globalMode && selected && (
                      <span
                        className="shrink-0 hidden lg:inline-flex rounded-full bg-neutral-800/60 text-neutral-500 px-2.5 py-1 text-[11px]"
                        title={t('app.scopeCoverageTooltip')}
                      >
                        {t('app.scopeCoverageChip')}
                      </span>
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
                    {!shellReady ? (
                      // 首次访问：主区（分类栏 + 技能/资产列表）用骨架顶住
                      <SkeletonMain />
                    ) : (
                      <>
                        {/* 首页仪表盘：只在全局总览的默认（任务）页摆，切到别的分类不跟 */}
                        {globalMode && mainCategory === 'tasks' && (
                          <DashboardOverview sessions={allSessions} statuses={sessionStatuses} />
                        )}
                        <CategoryDetail
                        projectId={anchorId}
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
                        onInstallBuiltinMcp={installBuiltinMcpSafely}
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
                        onSelectSession={selectTaskSession}
                        initialSessionId={initialSessionId ?? undefined}
                        dragPayload={dragPayload}
                      />
                      </>
                    )}
                  </div>
                </>
              ) : shellReady ? (
                // 真·没有项目（列表已回、确实为空）才落这句；首拉未回时用骨架顶着，
                // 免得启动页刚退就闪一下「请选择一个项目」。
                <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm">
                  {t('app.selectProject')}
                </div>
              ) : (
                <SkeletonMain />
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
                  className="shrink-0 border-l border-edge/[0.06] frosted overflow-hidden"
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
            className="absolute inset-0 bg-black/60 drawer-fade"
          />
          <aside
            className={cn(
              'absolute top-0 bottom-0 w-[min(88vw,360px)] bg-neutral-900 border-edge/[0.08] shadow-mac flex flex-col',
              mobilePanel === 'projects'
                ? 'left-0 border-r drawer-left'
                : 'right-0 border-l drawer-right',
            )}
          >
            <div className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-edge/[0.06] frosted">
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
