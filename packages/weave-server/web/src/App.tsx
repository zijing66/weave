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
  type McpRow,
  type ProjectRow,
  type StatuslineSource,
  type GlobalSkillGroup,
  type PluginRow,
  type PluginRuntime,
  type GlobalSkillSource,
  type InstallCapabilities,
} from '@/lib/api';
import type { DragPayload } from '@/lib/install-capabilities';
import { registerInvalidator, subscribeFrame, subscribeHook } from '@/lib/sse';
import { sessionLabel } from '@/lib/hook-payload';
import { notifyBrowser } from '@/lib/browser-notify';
import { useProjects } from '@/hooks/use-projects';
import { useProjectUpdates } from '@/hooks/use-project-updates';
import { useTerminalCounts } from '@/hooks/use-terminal-counts';
import { useCardCounts } from '@/hooks/use-card-counts';
import { useAssetMutations, pluginEffective } from '@/hooks/use-asset-mutations';
import { ProjectList } from '@/components/ProjectList';
import { useSessionStatus } from '@/components/tasks/session-status-store';
import { CategoryBar, type MainCategory, type CategoryBarData } from '@/components/CategoryBar';
import { CategoryDetail, type Mode, type ResourceView } from '@/components/CategoryDetail';
import { DashboardOverview } from '@/components/DashboardOverview';
import { SkillDetailDrawer } from '@/components/SkillDetailDrawer';
import { LibraryPanel } from '@/components/LibraryPanel';
import { FileViewer } from '@/components/FileViewer';
import { FileBrowserModal } from '@/components/FileBrowserModal';
import { Resizer } from '@/components/Resizer';
import { SettingsModal } from '@/components/SettingsModal';
import { CommandPalette } from '@/components/CommandPalette';
import { cn } from '@/lib/utils';
import { countEffectiveSkills } from '@/lib/skill-stats';
import { navigate, parseRoute, useRoutePath } from '@/lib/route';
import { setThemePreference, useThemePreference } from '@/lib/theme';
import { useT } from '@/i18n/I18nProvider';
import { useMediaQuery } from '@/lib/use-media-query';
import { ChevronDown, Github, Library, LogOut, Moon, PanelLeft, Search, Settings, Sun, SunMoon, X } from 'lucide-react';
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

const LEFT_MIN = 176;
const LEFT_MAX = 320;
const RIGHT_MIN = 260;
const RIGHT_MAX = 440;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** 「n 个更新」展开面的一行。 */
interface UpdateRow {
  kind: MessageKey;
  name: string;
  scope: AssetScope | null;
  note: string | null;
}
const UPDATE_SCOPE_KEY = { project: 'skillGrid.scopeProject', user: 'skillGrid.scopeUser' } as const;

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
  // 项目列表 + 归档面（TanStack Query 缓存域）：fetch/缓存/失效归 useProjects，
  // 重拉统一走 refreshProjects()（= invalidateQueries——SSE 帧与变更后的落定都指它）。
  const { projects, archivedProjects, refreshProjects, shellReady, reorderProjects } =
    useProjects(onBootReady);
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
  const {
    sessions: allSessions,
    projectStats,
    statuses: sessionStatuses,
    questions: sessionQuestions,
  } = useSessionStatus();
  /** projectId → 待答问题数（项目行边框预警用；与会话行问答图标同一份数据、
   *  同一个「不含收尾屏」口径）。 */
  const pendingQuestionsByProject = useMemo(() => {
    const counts = new Map<number, number>();
    for (const s of allSessions ?? []) {
      const question = sessionQuestions.get(s.sessionId);
      if (!question || s.projectId == null) continue;
      const n = question.questions.filter((q) => !q.submit).length;
      if (n > 0) counts.set(s.projectId, (counts.get(s.projectId) ?? 0) + n);
    }
    return counts;
  }, [allSessions, sessionQuestions]);
  // 全局总览跳进项目任务视图的初始选中会话（离开任务视图即失效）。
  const [initialSessionId, setInitialSessionId] = useState<string | null>(null);
  // 分类卡计数（hook 规则 / 编排定义）：变更经 window 事件回报，见 useCardCounts。
  const { hookRules, refreshHookRules, orchestrations } = useCardCounts();
  // MCP 工具行（每行一个 (harness, scope) 面；enable/effective 服务端算好）。
  const [mcpRows, setMcpRows] = useState<McpRow[]>([]);
  // 项目更新域（选中报告 + 行内计数缓存 + push 帧），见 useProjectUpdates。
  const { updates, setUpdates, updatesMap, setUpdatesMap, refreshUpdates, ensureUpdates } =
    useProjectUpdates();
  /** 「n 个更新」标签的展开态：点开看这批更新到底是谁。 */
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [globalSkillGroups, setGlobalSkillGroups] = useState<GlobalSkillGroup[]>([]);
  const [pluginRows, setPluginRows] = useState<PluginRow[]>([]);
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
  /** 全局搜索弹层（Ctrl/Cmd+K；顶栏按钮是移动端入口）。 */
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** 项目文件浏览器（只读 modal）：项目卡快捷按钮与全局搜索的文件结果共用。 */
  const [fileBrowser, setFileBrowser] = useState<{ projectId: number; path?: string } | null>(null);
  const themePref = useThemePreference();
  // 移动端外壳（<1024px 单栏）：左右栏改滑出抽屉；拖拽 sensor 按指针类型分流。
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const finePointer = useMediaQuery('(pointer: fine)');
  const [mobilePanel, setMobilePanel] = useState<'projects' | 'library' | null>(null);

  // 全局 Ctrl/Cmd+K 开搜索：capture 阶段拦（输入框里的 Ctrl+K 也要归我们——
  // 浏览器默认没有占用它，preventDefault 只是防未来冲突）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

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

  // 安装属性矩阵（静态）：启动拉一次，下发 LibraryPanel（M6 拖拽 canDrop 也用）。
  const [installCaps, setInstallCaps] = useState<InstallCapabilities | null>(null);
  useEffect(() => {
    api.capabilities().then(setInstallCaps).catch(() => {});
  }, []);

  // 归档面与 SSE/变更刷新的说明见顶部查询块（['projects'] 前缀两面齐刷）。

  // 项目卡终端角标 + 开终端放行闸（push 帧驱动），见 useTerminalCounts。
  const { terminalCounts, countsRef, terminalGate } = useTerminalCounts();

  const refreshAssets = useCallback((p: ProjectRow) => {
    api.listAssets(p.path).then(setAssets).catch(() => {});
  }, []);

  const refreshMcp = useCallback((projectId: number) => {
    api.listMcp(projectId).then(setMcpRows).catch(() => {});
  }, []);

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
    const target = projects.find((p: ProjectRow) => p.id === route.projectId);
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
            const next = projects.find((x: ProjectRow) => x.id !== p.id);
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

  // 资产装卸 handler 域（安装/卸载/启停/同步/更新 + 拖拽分派），见 useAssetMutations。
  const {
    dragPayload, setDragPayload,
    handleInstallSkillsBatch, handleUninstallSkill, handleUninstallMcp,
    handleCycleMcpEnable, handleSyncAll, handleCyclePluginState, handleUninstallPlugin,
    installSkillSafely, installFileAssetSafely, installMcpSafely, installBuiltinMcpSafely,
    updateAssetSafely, uninstallSkillSafely, dispatchDrop,
  } = useAssetMutations({
    t, show, selected, projects, globalMode, installCaps,
    refreshAssets, refreshMcp, refreshGlobalSkills, refreshPluginRows, refreshUpdates, ensureUpdates,
  });

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
      if (!projects.some((p: ProjectRow) => p.id === projectId)) return;
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
    dispatchDrop(data, scope, (reasonKey) => setError(t(reasonKey as Parameters<typeof t>[0])));
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
      onOpenFiles={(p) => setFileBrowser({ projectId: p.id })}
      openExplorerStateOf={openExplorerStateOf}
      openTerminalStateOf={openTerminalProjectStateOf}
      onCloseTerminal={closeProjectTerminal}
      onHoverProject={ensureUpdates}
      updatesOf={(id) => updatesMap[id]?.available}
      needsInitOf={(id) => updatesMap[id]?.needsInit}
      syncStateOf={syncActionStateOf}
      onSyncNow={(p) => void syncNowWithFeedback(p)}
      sessionStatsOf={(id) => projectStats.get(id)}
      pendingQuestionsOf={(id) => pendingQuestionsByProject.get(id) ?? 0}
      terminalsOf={(id) => terminalCounts[id] ?? 0}
      onReorder={reorderProjects}
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
      {/* h-full 不用 h-dvh：根 zoom 下视口单位被二次放大（125% 时整页溢出
          25%），html/body/#root 已钉 100%（index.css），百分比链不溢出。 */}
      <div className="h-full p-0 lg:p-4 bg-neutral-950">
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
            {/* 项目计数只桌面摆：<lg 顶栏要给搜索/主题/设置/退出留位，这行字会被挤成竖条。 */}
            <span className={cn('text-xs text-neutral-500', !isDesktop && 'hidden')}>
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
            {/* 全局搜索（Ctrl/Cmd+K；顶栏按钮兼作移动端入口）。 */}
            <button
              onClick={() => setPaletteOpen(true)}
              className="ml-auto p-1.5 rounded-lg text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60 transition-colors"
              title={t('search.open')}
              aria-label={t('search.open')}
            >
              <Search className="h-4 w-4" />
            </button>
            {/* GitHub 访问链接（含 star 数；取不到就只显示图标）——设置按钮左边。
                不挂 title：图标语义自明，悬停提示属噪音（保留 aria-label 供读屏）。 */}
            <a
              href={WEAVE_REPO_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="GitHub"
              className="inline-flex items-center gap-1 rounded-lg px-1.5 py-1 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60 transition-colors"
            >
              <Github className="h-4 w-4" />
              {stars !== null && (
                <span className="text-11 tabular-nums">{formatStars(stars)}</span>
              )}
            </a>
            {/* 主题三态循环：dark → light → auto(跟系统) → dark。图标画**当前态**
                （auto 恒 SunMoon 半日半月）——三态图标互不相同，每点一次必变；
                「按下去变成哪个」的画法在 auto+系统深色时会与钉死深色长得一样，
                点一下界面还不变，分不清自己处在哪个态。 */}
            <button
              onClick={() =>
                setThemePreference(
                  themePref === 'dark' ? 'light' : themePref === 'light' ? 'auto' : 'dark',
                )
              }
              className="p-1.5 rounded-lg text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60 transition-colors"
              title={
                themePref === 'dark'
                  ? t('app.themeDark')
                  : themePref === 'light'
                    ? t('app.themeLight')
                    : t('app.themeAuto')
              }
              aria-label={
                themePref === 'dark'
                  ? t('app.themeDark')
                  : themePref === 'light'
                    ? t('app.themeLight')
                    : t('app.themeAuto')
              }
            >
              {themePref === 'dark' ? (
                <Moon className="h-4 w-4" />
              ) : themePref === 'light' ? (
                <Sun className="h-4 w-4" />
              ) : (
                <SunMoon className="h-4 w-4" />
              )}
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
                      <p className="text-11 text-neutral-500 truncate">
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
                              <p className="border-b border-edge/[0.06] px-3 py-2 text-11 text-neutral-500">
                                {t('app.updateListTitle', { n: updateRows.length })}
                              </p>
                              <ul className="max-h-[320px] overflow-y-auto py-1">
                                {updateRows.map((row) => (
                                  <li key={`${row.kind}:${row.name}`} className="flex items-baseline gap-2 px-3 py-1">
                                    <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-10 text-neutral-400">
                                      {t(row.kind)}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-xs text-neutral-200" title={row.name}>
                                      {row.name}
                                    </span>
                                    {row.scope && (
                                      <span className="shrink-0 text-10 text-neutral-500">
                                        {t(UPDATE_SCOPE_KEY[row.scope])}
                                      </span>
                                    )}
                                    {row.note && (
                                      <span className="shrink-0 text-10 text-neutral-500">{row.note}</span>
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
                        className="shrink-0 hidden lg:inline-flex rounded-full bg-neutral-800/60 text-neutral-500 px-2.5 py-1 text-11"
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
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenFile={({ projectId, path }) => setFileBrowser({ projectId, path })}
      />
      {/* 项目文件浏览器（只读）：定位信息随打开时的项目名现查（projects 已在手） */}
      {fileBrowser && (
        <FileBrowserModal
          projectId={fileBrowser.projectId}
          projectName={projects.find((p) => p.id === fileBrowser.projectId)?.name ?? ''}
          path={fileBrowser.path}
          onClose={() => setFileBrowser(null)}
        />
      )}
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
