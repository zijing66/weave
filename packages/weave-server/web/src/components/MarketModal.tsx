import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  api,
  type AssetAgent,
  type AssetScope,
  type FileAssetTemplate,
  type InstallationRow,
  type InstallCapabilities,
  type MarketItem,
  type MarketPluginAsset,
  type MarketUpdateStatus,
  type McpServerConfig,
  type McpSharedRow,
  type ProjectRow,
  type SkillAsset,
} from '@/lib/api';
import {
  capabilitiesOf,
} from '@/lib/install-capabilities';
import {
  buildInstallationIndex,
  filterAndRankRows,
  installationKeyOfRow,
  rowsOfLibrary,
  rowsOfSharedMcp,
  type LibraryAssets,
  type MarketRow,
} from '@/lib/market-rows';
import { harnessUiOf } from '@/lib/harness-meta';
import { registerInvalidator } from '@/lib/sse';
import { useBackPop } from '@/lib/back-pop';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DirectoryPickerModal } from '@/components/DirectoryPickerModal';
import { useToast } from '@/components/Toast';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import type { ActionState } from '@/lib/feedback-core';
import { Tooltip } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { KIND_KEY, KIND_STYLES } from '@/components/ToolkitSection';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileCode,
  FolderOpen,
  GitBranch,
  Globe,
  Package,
  Puzzle,
  RefreshCw,
  Server,
  Trash2,
  X,
} from 'lucide-react';

/**
 * 资源市场弹层页（VS Code Extensions 式）：左源右列、搜索优先、单行 + 已装
 * N 处徽标、安装时选落点（不跟随锚定项目）。骨架复用 FileBrowserModal 范式
 * （portal + 遮罩 + ESC 分层 + useBackPop）；开闭态不进 URL（先例裁决）。
 *
 * 安装 handler 由 App 注入（use-asset-mutations 预包装，带显式 target）；
 * 弹层装完自己 refetch /installations 刷徽标。
 */

export interface MarketModalProps {
  onClose: () => void;
  /** 安装落点候选（App 已有项目清单）。 */
  projects: ProjectRow[];
  /** 当前锚定项目（目标选择器的默认落点；null/缺省 = 全局面）。 */
  defaultProjectId?: number | null;
  /** 安装属性矩阵（GET /capabilities；目标选择器的合法性判定）。 */
  capabilities: InstallCapabilities | null;
  onInstallSkill: (
    skill: SkillAsset,
    scope: AssetScope,
    agent: AssetAgent,
    target: ProjectRow | null,
  ) => void | Promise<void>;
  onInstallMcp: (
    name: string,
    config: McpServerConfig,
    scope: AssetScope,
    agent: AssetAgent,
    target: ProjectRow | null,
  ) => void | Promise<void>;
  onInstallFileAsset: (
    file: FileAssetTemplate,
    scope: AssetScope,
    target: ProjectRow | null,
  ) => void | Promise<void>;
  /** 插件包安装 = toolkit enable（恒项目落点；CC 包全局安装随 enable 发生）。 */
  onInstallPlugin: (plugin: MarketPluginAsset, target: ProjectRow) => void | Promise<void>;
  /** 卸载 handler（胶囊「灭」向）；签名与安装侧同构。 */
  onUninstallSkill: (
    name: string,
    scope: AssetScope,
    agent: AssetAgent,
    target: ProjectRow | null,
  ) => void | Promise<void>;
  onUninstallMcp: (
    name: string,
    scope: AssetScope,
    agent: AssetAgent,
    target: ProjectRow | null,
  ) => void | Promise<void>;
  onUninstallFileAsset: (
    file: FileAssetTemplate,
    scope: AssetScope,
    target: ProjectRow | null,
  ) => void | Promise<void>;
  /** 插件包卸载 = toolkit uninstall（恒项目落点）。 */
  onUninstallPlugin: (plugin: MarketPluginAsset, target: ProjectRow) => void | Promise<void>;
  /** 跳转：关弹层 + 进该项目（null = 全局）的资源管理。 */
  onJumpToProject: (projectId: number | null) => void;
}

const EMPTY_ASSETS: LibraryAssets = { skills: [], mcp: [], files: [], plugins: [] };

/** MCP 配置虚拟源 id（不存在于 libraries 表；-1 安全）。 */
const MCP_VIEW_ID = -1;

export function MarketModal({
  onClose,
  projects,
  capabilities,
  onInstallSkill,
  onInstallMcp,
  onInstallFileAsset,
  onInstallPlugin,
  onUninstallSkill,
  onUninstallMcp,
  onUninstallFileAsset,
  onUninstallPlugin,
  onJumpToProject,
}: MarketModalProps) {
  const t = useT();
  const { show } = useToast();
  const fb = useActionFeedback();

  const [market, setMarket] = useState<MarketItem[]>([]);
  /** MCP 共享行（聚合托管项目实配；随 /mcp-shared 拉取）。 */
  const [sharedMcp, setSharedMcp] = useState<McpSharedRow[]>([]);
  /** 当前选中源；null = 空面板（来源列表态）。MCP 配置走头部按钮，不是默认页。 */
  const [selectedId, setSelectedId] = useState<number | null>(null);
  /** 库资产缓存（id → 四类扫描结果）；搜索时全量补齐。 */
  const [libCache, setLibCache] = useState<Map<number, LibraryAssets>>(new Map());
  const [query, setQuery] = useState('');
  const [expandedUid, setExpandedUid] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  /** 位置弹层锚定的行键（installationKeyOfRow 形）。 */
  const [locationsKey, setLocationsKey] = useState<string | null>(null);
  const [installIndex, setInstallIndex] = useState<Map<string, InstallationRow[]>>(new Map());
  const [removeTarget, setRemoveTarget] = useState<MarketItem | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [gitUrl, setGitUrl] = useState('');
  const [marketStatus, setMarketStatus] = useState<Map<number, MarketUpdateStatus>>(new Map());
  /** 多选批操作：选中行 uid 集 + 开关态（有选中即开）。 */
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<string[]>([]);

  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const reloadInstallations = useCallback(() => {
    api
      .listInstallations()
      .then((rows) => setInstallIndex(buildInstallationIndex(rows)))
      .catch(() => setInstallIndex(new Map()));
  }, []);

  const refreshMarket = useCallback(
    () => api.listMarket().then(setMarket).catch((e) => show('error', String(e))),
    [show],
  );

  // 打开即拉：市场源 + 安装位置快照 + MCP 共享聚合
  useEffect(() => {
    void refreshMarket();
    reloadInstallations();
    api
      .listMcpShared()
      .then((r) => setSharedMcp(r.shared))
      .catch(() => setSharedMcp([]));
  }, [refreshMarket, reloadInstallations]);

  useEffect(
    () => registerInvalidator('market', () => void refreshMarket()),
    [refreshMarket],
  );

  /** 拉一个库的资产进缓存（已缓存则跳过）。 */
  const loadLibrary = useCallback(
    async (id: number): Promise<LibraryAssets> => {
      const cached = libCache.get(id);
      if (cached) return cached;
      const r = await api.listLibraryAssets(id);
      // 包内 skill 不进清单（隶属插件，随包启停）——与市场侧栏同口径
      const roots = (r.plugins ?? []).map((p) => p.relPath);
      const inPack = (rel: string) =>
        roots.some((root) => root === '' || rel === root || rel.startsWith(`${root}/`));
      const assets: LibraryAssets = {
        skills: (r.skills ?? []).filter((s) => !inPack(s.relPath)),
        mcp: r.mcp ?? [],
        files: r.files ?? [],
        plugins: r.plugins ?? [],
      };
      setLibCache((prev) => new Map(prev).set(id, assets));
      return assets;
    },
    [libCache],
  );

  // 选中源 → 拉资产（MCP 配置虚拟源不拉库资产）
  useEffect(() => {
    if (selectedId !== null && selectedId !== MCP_VIEW_ID) void loadLibrary(selectedId).catch(() => setLibCache((prev) => new Map(prev).set(selectedId, EMPTY_ASSETS)));
  }, [selectedId, loadLibrary]);

  // 搜索态：跨全部源——没缓存的库并行补齐（一次性，之后纯内存过滤）
  const searching = query.trim().length > 0;
  useEffect(() => {
    if (!searching) return;
    const missing = market.filter((m) => !libCache.has(m.id));
    if (missing.length === 0) return;
    let alive = true;
    void Promise.all(
      missing.map((m) =>
        api
          .listLibraryAssets(m.id)
          .then((r) => ({ id: m.id, r }))
          .catch(() => ({ id: m.id, r: null })),
      ),
    ).then((results) => {
      if (!alive) return;
      setLibCache((prev) => {
        const next = new Map(prev);
        for (const { id, r } of results) {
          if (r) next.set(id, { skills: r.skills ?? [], mcp: r.mcp ?? [], files: r.files ?? [], plugins: r.plugins ?? [] });
          else if (!next.has(id)) next.set(id, EMPTY_ASSETS);
        }
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [searching, market, libCache]);

  /** 当前展示的行集：搜索 = 全部源并集过滤排序；否则 = 选中源的摊平行。
   *  MCP 共享行只属于 MCP 配置视图（专属渲染），不混进这里的兜底。 */
  const rows: MarketRow[] = useMemo(() => {
    const shared = rowsOfSharedMcp(sharedMcp);
    if (searching) {
      const all = [
        ...shared,
        ...[...libCache.values()].flatMap((a) => rowsOfLibrary(0, a)),
      ];
      return filterAndRankRows(all, query);
    }
    if (selectedId === null) return [];
    const assets = libCache.get(selectedId);
    return assets ? rowsOfLibrary(selectedId, assets) : [];
  }, [searching, query, libCache, selectedId, sharedMcp]);

  /** ESC 逐层退：位置弹层 → 源管理 → MCP 表单 → 行展开 → 关 modal。 */
  const layerRefs = {
    locationsKey,
    sourcesOpen,
    expandedUid,
  };
  const layerRef = useRef(layerRefs);
  layerRef.current = layerRefs;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      const l = layerRef.current;
      if (l.locationsKey) setLocationsKey(null);
      else if (l.sourcesOpen) setSourcesOpen(false);
      else if (l.expandedUid) setExpandedUid(null);
      else closeRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  useBackPop(true, () => {
    const l = layerRef.current;
    if (l.locationsKey) {
      setLocationsKey(null);
      return true;
    }
    if (l.sourcesOpen) {
      setSourcesOpen(false);
      return true;
    }
    if (l.expandedUid) {
      setExpandedUid(null);
      return true;
    }
    if (query !== '') {
      setQuery('');
      return true;
    }
    closeRef.current();
    return true;
  });

  // 打开自动聚焦搜索框
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const installedCountOf = (row: MarketRow): number =>
    installIndex.get(installationKeyOfRow(row))?.length ?? 0;

  /** 行安装动作：按 kind 分派到注入的 handler，装完刷位置快照。 */
  const runInstall = async (
    row: MarketRow,
    target: { scope: AssetScope; projectId: number | null; agent: AssetAgent },
  ): Promise<void> => {
    const project = target.projectId !== null ? projects.find((p) => p.id === target.projectId) ?? null : null;
    if (row.skill) {
      await onInstallSkill(row.skill, target.scope, target.agent, project);
    } else if (row.shared) {
      await onInstallMcp(row.name, row.shared.config, target.scope, row.shared.harness, project);
    } else if (row.mcp) {
      await onInstallMcp(
        row.name,
        { command: row.mcp.command, ...(row.mcp.args && { args: row.mcp.args }), ...(row.mcp.env && { env: row.mcp.env }) },
        target.scope,
        target.agent,
        project,
      );
    } else if (row.file) {
      await onInstallFileAsset(row.file, target.scope, project);
    } else if (row.plugin && project) {
      await onInstallPlugin(row.plugin, project);
    }
    reloadInstallations();
  };

  /** 行卸载动作（胶囊切换的「灭」向）：plugin 走 toolkit 卸载，其余按 kind 走 uninstall API。 */
  const runUninstall = async (
    row: MarketRow,
    target: { scope: AssetScope; projectId: number | null; agent: AssetAgent },
  ): Promise<void> => {
    const project = target.projectId !== null ? projects.find((p) => p.id === target.projectId) ?? null : null;
    if (row.plugin && project) {
      await onUninstallPlugin(row.plugin, project);
    } else if (row.shared) {
      await onUninstallMcp(row.name, target.scope, row.shared.harness, project);
    } else if (row.skill) {
      await onUninstallSkill(row.name, target.scope, target.agent, project);
    } else if (row.mcp) {
      await onUninstallMcp(row.name, target.scope, target.agent, project);
    } else if (row.file) {
      await onUninstallFileAsset(row.file, target.scope, project);
    }
    reloadInstallations();
  };

  // ---- 源管理动作（自 LibraryPanel 迁入，口径不变）----
  const checking = fb.stateOf('mkt-check-updates') === 'loading';
  const refreshing = fb.stateOf('mkt-refresh-all') === 'loading';
  const gitImporting = fb.stateOf('mkt-git-import') === 'loading';

  async function handleCheckUpdates() {
    if (checking) return;
    await fb.run(
      'mkt-check-updates',
      async () => {
        const results = await api.checkMarketUpdates();
        setMarketStatus(new Map(results.map((r) => [r.id, r.status])));
        show('success', t('library.checkDone', { n: results.filter((r) => r.status === 'update-available').length }));
      },
      { fail: (e) => t('library.checkFailed', { error: errorText(e) }) },
    );
  }

  /** 单源检查更新（来源行的检查图标）：只查这一个，结果并入 status 表。 */
  async function handleCheckOne(item: MarketItem) {
    await fb.run(
      `mkt-check-one:${item.id}`,
      async () => {
        const results = await api.checkMarketUpdates([item.id]);
        setMarketStatus((prev) => {
          const next = new Map(prev);
          for (const r of results) next.set(r.id, r.status);
          return next;
        });
        const hit = results.filter((r) => r.status === 'update-available').length;
        show('success', t('library.checkDone', { n: hit }));
      },
      { fail: (e) => t('library.checkFailed', { error: errorText(e) }) },
    );
  }

  async function handleRefreshAll() {
    const ids = [...marketStatus.entries()]
      .filter(([, s]) => s === 'update-available')
      .map(([id]) => id);
    if (!ids.length || refreshing) return;
    await fb.run(
      'mkt-refresh-all',
      async () => {
        await api.refreshMarketCache(ids);
        await refreshMarket();
        setLibCache(new Map()); // 副本已刷新，缓存作废重扫
        if (selectedId !== null) void loadLibrary(selectedId);
        const recheck = await api.checkMarketUpdates(ids);
        setMarketStatus((prev) => {
          const next = new Map(prev);
          for (const r of recheck) next.set(r.id, r.status);
          return next;
        });
        show('success', t('library.refreshDone', { n: ids.length }));
      },
      { fail: (e) => t('library.refreshFailed', { error: errorText(e) }) },
    );
  }

  async function handlePicked(paths: string[]) {
    await fb.run(
      'mkt-import-dirs',
      async () => {
        let lastId: number | null = null;
        let ok = 0;
        for (const p of paths) {
          try {
            const item = await api.importMarketDir(p);
            lastId = item.id;
            ok++;
          } catch (e) {
            show('error', t('library.importDirFail', { path: p, error: errorText(e) }));
          }
        }
        if (ok > 0) show('success', t('library.importDirOk', { n: ok }));
        await refreshMarket();
        setLibCache(new Map());
        if (lastId !== null) setSelectedId(lastId);
      },
      { fail: (e) => t('library.importFailed', { error: errorText(e) }) },
    );
  }

  async function handleGitImport() {
    const url = gitUrl.trim();
    if (!url || gitImporting) return;
    await fb.run(
      'mkt-git-import',
      async () => {
        const item = await api.importMarketGit(url);
        setGitUrl('');
        await refreshMarket();
        setLibCache(new Map());
        setSelectedId(item.id);
        show('success', t('library.importGitOk', { name: item.resourceId ?? item.path }));
      },
      { fail: (e) => t('library.importFailed', { error: errorText(e) }) },
    );
  }

  async function removeItem(item: MarketItem) {
    const key = `mkt-remove:${item.id}`;
    if (fb.stateOf(key) === 'loading') return;
    await fb.run(
      key,
      async () => {
        let warning: string | undefined;
        if (item.managed) warning = (await api.removeMarket(item.id)).warning;
        else await api.removeLibrary(item.id);
        if (selectedId === item.id) setSelectedId(null);
        await refreshMarket();
        show('success', t('library.removedOk', { name: item.resourceId ?? item.path }));
        if (warning) show('info', t('library.removeDeregWarn', { error: warning }));
      },
      { fail: (e) => t('library.removeFailed', { error: errorText(e) }) },
    );
  }

  /** legacy 外部源显式迁入市场（复制 + 改写相对路径）。 */
  async function migrateLibrary(item: MarketItem) {
    const key = `mkt-migrate:${item.id}`;
    if (fb.stateOf(key) === 'loading') return;
    await fb.run(
      key,
      async () => {
        const migrated = await api.migrateLibrary(item.id);
        await refreshMarket();
        setLibCache(new Map());
        setSelectedId(migrated.id);
        show('success', t('library.migratedOk', { name: migrated.resourceId ?? migrated.path }));
      },
      { fail: (e) => t('library.migrateFailed', { error: errorText(e) }) },
    );
  }

  const builtinMarkets = market.filter((m) => m.source === 'builtin');
  const localMarkets = market.filter((m) => m.source === 'dir' || m.source === 'legacy');
  const gitMarkets = market.filter((m) => m.source === 'git');

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 max-lg:p-0"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={cn(
          'relative flex min-h-0 w-full flex-col overflow-hidden bg-neutral-900 focus:outline-none',
          'flex h-[80%] max-w-5xl rounded-xl border border-edge/[0.08] shadow-mac max-lg:h-full max-lg:max-w-none max-lg:rounded-none',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头：标题 + 搜索 + 源管理 + MCP 表单 + 关闭 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-edge/[0.06] px-3 py-2 max-lg:flex-wrap">
          <h2 className="shrink-0 text-xs font-semibold uppercase text-neutral-400">
            {t('market.title')}
          </h2>
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('market.searchPlaceholder')}
            className="min-w-0 flex-1"
          />
          <Tooltip label={t('market.manageSources')} side="top">
            <button
              type="button"
              onClick={() => setSourcesOpen((v) => !v)}
              className={cn(
                'shrink-0 rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700',
                sourcesOpen && 'bg-neutral-700 text-neutral-100',
              )}
            >
              <Package className="mr-1 inline h-3 w-3" />
              {t('market.manageSources')}
            </button>
          </Tooltip>
          <Tooltip label={t('market.mcpConfig')} side="top">
            <button
              type="button"
              onClick={() => setSelectedId(MCP_VIEW_ID)}
              className={cn(
                'shrink-0 rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700',
                selectedId === MCP_VIEW_ID && 'bg-neutral-700 text-neutral-100',
              )}
            >
              <Server className="mr-1 inline h-3 w-3" />
              {t('market.mcpConfig')}
            </button>
          </Tooltip>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="shrink-0 rounded p-1 text-neutral-400 transition-colors hover:text-neutral-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* 源管理条（导入 / 检查更新 / 一键更新） */}
        {sourcesOpen && (
          <div className="shrink-0 space-y-2 border-b border-edge/[0.06] bg-neutral-900/60 px-3 py-2">
            <div className="flex items-center gap-1 max-lg:flex-wrap">
              <Tooltip label={t('library.addFoldersTip')} side="top">
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="flex items-center gap-1.5 rounded bg-neutral-800 px-2 py-1.5 text-xs hover:bg-neutral-700"
                >
                  <FeedbackIcon
                    state={fb.stateOf('mkt-import-dirs')}
                    className="h-3.5 w-3.5"
                    icon={<FolderOpen className="h-3.5 w-3.5" />}
                  />
                  {t('library.addFolders')}
                </button>
              </Tooltip>
              <Input
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleGitImport();
                }}
                placeholder={t('library.gitPlaceholder')}
                className="min-w-0 flex-1 font-mono"
              />
              <Tooltip label={t('library.importGitTip')} side="top">
                <button
                  type="button"
                  onClick={() => void handleGitImport()}
                  disabled={!gitUrl.trim() || gitImporting}
                  className="shrink-0 rounded bg-neutral-800 px-2 py-1.5 text-xs hover:bg-neutral-700 disabled:opacity-40"
                >
                  <FeedbackIcon
                    state={fb.stateOf('mkt-git-import')}
                    className="h-3.5 w-3.5"
                    icon={<GitBranch className="h-3.5 w-3.5" />}
                  />
                  {gitImporting ? t('library.scanning') : t('library.importGit')}
                </button>
              </Tooltip>
            </div>
            {market.length > 0 && (
              <div className="flex items-center gap-1">
                <Tooltip label={t('library.checkUpdatesTip')} side="top" className="flex-1">
                  <button
                    type="button"
                    onClick={() => void handleCheckUpdates()}
                    disabled={checking}
                    className="flex w-full items-center justify-center gap-1.5 rounded bg-neutral-800 px-2 py-1.5 text-xs hover:bg-neutral-700 disabled:opacity-40"
                  >
                    <FeedbackIcon
                      state={fb.stateOf('mkt-check-updates')}
                      className="h-3.5 w-3.5"
                      icon={<RefreshCw className="h-3.5 w-3.5" />}
                    />
                    {checking ? t('library.checking') : t('library.checkUpdates')}
                  </button>
                </Tooltip>
                <Tooltip label={t('library.refreshUpdatesTip')} side="top" className="flex-1">
                  <button
                    type="button"
                    onClick={() => void handleRefreshAll()}
                    disabled={refreshing || [...marketStatus.values()].filter((s) => s === 'update-available').length === 0}
                    className="flex w-full items-center justify-center gap-1.5 rounded bg-blue-900/40 px-2 py-1.5 text-xs text-blue-300 hover:bg-blue-900/60 disabled:opacity-40"
                  >
                    <FeedbackIcon
                      state={fb.stateOf('mkt-refresh-all')}
                      className="h-3.5 w-3.5"
                      icon={<Download className="h-3.5 w-3.5" />}
                    />
                    {refreshing ? t('library.scanning') : t('library.refreshUpdates')}
                  </button>
                </Tooltip>
              </div>
            )}
          </div>
        )}

        {/* 体：左源右列 */}
        <div className="flex min-h-0 flex-1">
          {/* 左栏：市场源（搜索态置灰） */}
          <div
            className={cn(
              'w-56 shrink-0 space-y-1 overflow-y-auto border-r border-edge/[0.06] p-2 max-lg:hidden',
              searching && 'pointer-events-none opacity-40',
            )}
          >
            <p className="px-1 text-10 font-semibold uppercase text-neutral-500">
              {t('market.sources')}
            </p>
            {[...builtinMarkets, ...localMarkets, ...gitMarkets].map((item) => (
              <SourceRow
                key={item.id}
                item={item}
                selected={selectedId === item.id}
                status={marketStatus.get(item.id)}
                onSelect={() => {
                  setQuery('');
                  setSelectedId(item.id);
                }}
                onRemove={(it) => (it.managed ? setRemoveTarget(it) : void removeItem(it))}
                onMigrate={(it) => void migrateLibrary(it)}
                onCheck={(it) => void handleCheckOne(it)}
                removeState={fb.stateOf(`mkt-remove:${item.id}`)}
                migrateState={fb.stateOf(`mkt-migrate:${item.id}`)}
                checkState={fb.stateOf(`mkt-check-one:${item.id}`)}
              />
            ))}
            {market.length === 0 && (
              <p className="px-1 text-11 text-neutral-600">{t('library.noTemplatesHint')}</p>
            )}
          </div>

          {/* 右栏：资产行清单 */}
          <div className="min-w-0 flex-1 overflow-y-auto p-2">
            {/* 多选批操作条：勾选若干资源 → 统一滑条一次装到同一落点（MCP 配置视图行内已有分段控制器，不进多选） */}
            {rows.length > 0 && (searching || (selectedId !== null && selectedId !== MCP_VIEW_ID)) && (
              <div className="mb-2 flex flex-wrap items-center gap-2 rounded bg-neutral-950/60 p-2">
                <button
                  type="button"
                  onClick={() => {
                    setBulkMode((v) => !v);
                    setBulkSelected([]);
                  }}
                  className={cn(
                    'shrink-0 rounded px-2 py-0.5 text-11',
                    bulkMode ? 'bg-blue-900/40 text-blue-200' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700',
                  )}
                >
                  {t('market.multiSelect')}
                  {bulkSelected.length > 0 && ` · ${t('market.batchSelected', { n: bulkSelected.length })}`}
                </button>
                {bulkMode && bulkSelected.length > 0 && (
                  <BulkInstallSlider
                    names={rows.filter((r) => bulkSelected.includes(r.uid)).map((r) => r.name)}
                    projects={projects}
                    onApply={(scope, projectId, agent) => {
                      void fb.run(
                        'mkt-bulk-install',
                        async () => {
                          for (const r of rows.filter((x) => bulkSelected.includes(x.uid))) {
                            await runInstall(r, { scope, projectId, agent });
                          }
                          show('success', t('market.batchSelected', { n: bulkSelected.length }));
                        },
                        { fail: (e) => t('errors.installFailed', { error: errorText(e) }) },
                      );
                    }}
                    loading={fb.stateOf('mkt-bulk-install') === 'loading'}
                  />
                )}
              </div>
            )}
            {/* <lg：来源列表（未选源时显示；左栏在 <lg 整列隐藏，这里是移动端的
                「先列表后明细」导航——与桌面左栏同构，含检查更新/移除） */}
            {!searching && selectedId === null && (
              <div className="space-y-1 lg:hidden">
                <p className="px-1 text-10 font-semibold uppercase text-neutral-500">
                  {t('market.sources')}
                </p>
                {[...builtinMarkets, ...localMarkets, ...gitMarkets].map((item) => (
                  <SourceRow
                    key={item.id}
                    item={item}
                    selected={false}
                    status={marketStatus.get(item.id)}
                    onSelect={() => {
                      setQuery('');
                      setSelectedId(item.id);
                    }}
                    onRemove={(it) => (it.managed ? setRemoveTarget(it) : void removeItem(it))}
                    onMigrate={(it) => void migrateLibrary(it)}
                    onCheck={(it) => void handleCheckOne(it)}
                    removeState={fb.stateOf(`mkt-remove:${item.id}`)}
                    migrateState={fb.stateOf(`mkt-migrate:${item.id}`)}
                    checkState={fb.stateOf(`mkt-check-one:${item.id}`)}
                  />
                ))}
              </div>
            )}

            {/* <lg：明细态的返回列表按钮 */}
            {!searching && selectedId !== null && (
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="mb-2 flex items-center gap-1 rounded bg-neutral-800 px-2 py-1 text-11 text-neutral-300 hover:bg-neutral-700 lg:hidden"
              >
                <ChevronLeft className="h-3 w-3" />
                {t('market.sources')}
              </button>
            )}
            {/* MCP 配置视图：聚合清单（折叠行，展开可编辑 JSON/表单）+ 手动添加 */}
            {!searching && selectedId === MCP_VIEW_ID && (
              <McpConfigView
                shared={sharedMcp}
                projects={projects}
                installIndex={installIndex}
                onInstall={(name, config, scope, agent, project) =>
                  void fb.run(
                    'mkt-mcp-shared-install',
                    async () => {
                      await onInstallMcp(name, config, scope, agent, project);
                      reloadInstallations();
                      api
                        .listMcpShared()
                        .then((r) => setSharedMcp(r.shared))
                        .catch(() => {});
                      show('success', t('library.installedOk', { name }));
                    },
                    { fail: (e) => t('errors.installFailed', { error: errorText(e) }) },
                  )
                }
                onUninstall={(name, scope, agent, project) =>
                  void fb.run(
                    'mkt-mcp-shared-install',
                    async () => {
                      await onUninstallMcp(name, scope, agent, project);
                      reloadInstallations();
                      api
                        .listMcpShared()
                        .then((r) => setSharedMcp(r.shared))
                        .catch(() => {});
                      show('success', t('skillGrid.uninstalled', { name }));
                    },
                    { fail: (e) => t('errors.uninstallFailed', { error: errorText(e) }) },
                  )
                }
                onManualAdd={(name, config, scope, agent, project) =>
                  void fb.run(
                    'mkt-mcp-manual',
                    async () => {
                      await onInstallMcp(name, config, scope, agent, project);
                      reloadInstallations();
                      api
                        .listMcpShared()
                        .then((r) => setSharedMcp(r.shared))
                        .catch(() => {});
                      show('success', t('library.installedOk', { name }));
                    },
                    { fail: (e) => t('errors.mcpInstallFailed', { error: errorText(e) }) },
                  )
                }
              />
            )}
            {(searching || (selectedId !== null && selectedId !== MCP_VIEW_ID)) && rows.length === 0 && (
              <p className="p-6 text-center text-xs text-neutral-500">
                {searching ? t('market.noResults') : t('library.scanning')}
              </p>
            )}
            {selectedId !== MCP_VIEW_ID && rows.map((row) => (
              <MarketRowView
                key={row.uid}
                row={row}
                bulkMode={bulkMode}
                bulkChecked={bulkSelected.includes(row.uid)}
                onBulkToggle={() =>
                  setBulkSelected((prev) =>
                    prev.includes(row.uid) ? prev.filter((u) => u !== row.uid) : [...prev, row.uid],
                  )
                }
                expanded={expandedUid === row.uid}
                installedCount={installedCountOf(row)}
                locations={locationsKey === installationKeyOfRow(row) ? installIndex.get(locationsKey) ?? [] : null}
                installedRows={installIndex.get(installationKeyOfRow(row)) ?? []}
                capabilities={capabilities}
                projects={projects}
                onToggle={() => setExpandedUid((prev) => (prev === row.uid ? null : row.uid))}
                onOpenLocations={() =>
                  setLocationsKey((prev) => (prev === installationKeyOfRow(row) ? null : installationKeyOfRow(row)))
                }
                onJumpToProject={onJumpToProject}
                onInstall={(target) =>
                  void fb.run(
                    `mkt-install:${row.uid}`,
                    async () => {
                      await runInstall(row, target);
                      show('success', t('library.installedOk', { name: row.name }));
                    },
                    { fail: (e) => t('errors.installFailed', { error: errorText(e) }) },
                  )
                }
                installState={fb.stateOf(`mkt-install:${row.uid}`)}
                onUninstall={(target) =>
                  void fb.run(
                    `mkt-install:${row.uid}`,
                    async () => {
                      await runUninstall(row, target);
                      show('success', t('skillGrid.uninstalled', { name: row.name }));
                    },
                    { fail: (e) => t('errors.uninstallFailed', { error: errorText(e) }) },
                  )
                }
              />
            ))}
          </div>
        </div>
      </div>

      <DirectoryPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onConfirm={(paths) => {
          setPickerOpen(false);
          void handlePicked(paths);
        }}
        existingPaths={market.map((l) => l.path)}
      />
      <ConfirmDialog
        open={removeTarget !== null}
        title={t('library.removeMarketTitle')}
        message={t('library.removeMarketConfirm', {
          name: removeTarget?.resourceId ?? removeTarget?.path ?? '',
        })}
        confirmLabel={t('common.confirm')}
        onConfirm={() => {
          if (removeTarget) void removeItem(removeTarget);
        }}
        onClose={() => setRemoveTarget(null)}
      />
    </div>,
    document.body,
  );
}

/** 市场源行：名称 + 来源徽标 + 更新状态 + 迁入（legacy）/ 移除；点击选中。 */
function SourceRow({
  item,
  selected,
  status,
  onSelect,
  onRemove,
  onMigrate,
  onCheck,
  removeState,
  migrateState,
  checkState,
}: {
  item: MarketItem;
  selected: boolean;
  status?: MarketUpdateStatus;
  onSelect: () => void;
  onRemove: (item: MarketItem) => void;
  onMigrate: (item: MarketItem) => void;
  onCheck: (item: MarketItem) => void;
  removeState: string;
  migrateState: string;
  checkState: string;
}) {
  const t = useT();
  const sourceCfg = {
    git: { label: t('library.badgeGit'), cls: 'text-violet-300 bg-violet-900/30' },
    dir: { label: t('library.badgeDir'), cls: 'text-blue-300 bg-blue-900/30' },
    legacy: { label: t('library.badgeExternal'), cls: 'text-neutral-300 bg-neutral-800' },
    builtin: { label: t('toolkit.prov.builtin'), cls: 'text-emerald-300 bg-emerald-900/30' },
  }[item.source];
  const statusCfg =
    status === 'update-available'
      ? { label: t('library.statusUpdateAvailable'), cls: 'text-orange-300 bg-orange-900/30' }
      : status === 'origin-missing'
        ? { label: t('library.statusOriginMissing'), cls: 'text-amber-300 bg-amber-900/30' }
        : null;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'flex cursor-pointer select-none items-center gap-1 rounded-md border px-2 py-1.5',
        selected
          ? 'border-neutral-700 bg-neutral-800/80'
          : 'border-edge/[0.06] bg-edge/[0.015] hover:bg-edge/[0.04]',
      )}
    >
      <Tooltip label={item.path} side="top" className="min-w-0 flex-1">
        <span className="min-w-0 truncate text-xs text-neutral-200">
          {item.managed && item.resourceId ? item.resourceId : item.path}
        </span>
      </Tooltip>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {statusCfg && (
          <span className={cn('rounded px-1.5 py-0.5 text-10', statusCfg.cls)}>{statusCfg.label}</span>
        )}
        <span className={cn('rounded px-1.5 py-0.5 text-10', sourceCfg.cls)}>{sourceCfg.label}</span>
        {/* 动作钮组（右侧成排、带边框；builtin 源无 origin 不摆检查更新） */}
        <span className="flex shrink-0 items-center gap-0.5 rounded border border-edge/[0.1] p-0.5">
          {!item.builtin && (
            <Tooltip label={t('library.checkUpdatesTip')} side="top">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCheck(item);
                }}
                disabled={checkState === 'loading'}
                className="rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-blue-400 disabled:cursor-not-allowed [&_svg]:pointer-events-none"
              >
                <FeedbackIcon
                  state={checkState}
                  className="h-3 w-3"
                  icon={<RefreshCw className="h-3 w-3" />}
                />
              </button>
            </Tooltip>
          )}
          {item.source === 'legacy' && (
            <Tooltip label={t('library.migrateTip')} side="top">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onMigrate(item);
                }}
                disabled={migrateState === 'loading'}
                className="rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-blue-400 disabled:cursor-not-allowed [&_svg]:pointer-events-none"
              >
                <FolderOpen className="h-3 w-3" />
              </button>
            </Tooltip>
          )}
          {!item.builtin && (
            <Tooltip label={item.managed ? t('library.removeMarketTip') : t('library.removeLegacyTip')} side="top">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(item);
                }}
                disabled={removeState === 'loading'}
                className="rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-red-400 disabled:cursor-not-allowed [&_svg]:pointer-events-none"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </Tooltip>
          )}
        </span>
      </span>
    </div>
  );
}

/** 非插件行的 kind 徽标色（与 ToolkitSection 的 KIND_STYLES 同语言；
 *  plugin 行的徽标是包内 kind（skill/rule/mod…），另一轴，走 KIND_STYLES）。 */
const MARKET_KIND_STYLES: Record<MarketRow['kind'], string> = {
  skill: 'bg-emerald-900/40 text-emerald-300',
  mcp: 'bg-blue-900/40 text-blue-300',
  plugin: 'bg-violet-900/40 text-violet-300',
  command: 'bg-neutral-800 text-neutral-300',
  agent: 'bg-neutral-800 text-neutral-300',
  workflow: 'bg-neutral-800 text-neutral-300',
  rule: 'bg-amber-900/40 text-amber-300',
  'output-style': 'bg-neutral-800 text-neutral-300',
};

/** 非插件行的 kind → 词条（skill/rule 复用既有键，其余为市场行补的键）。 */
const MARKET_KIND_KEY: Record<MarketRow['kind'], MessageKey> = {
  skill: 'toolkit.kind.skill',
  mcp: 'toolkit.kind.mcp',
  plugin: 'toolkit.kind.plugin',
  command: 'toolkit.kind.command',
  agent: 'toolkit.kind.agent',
  workflow: 'toolkit.kind.workflow',
  rule: 'toolkit.kind.rule',
  'output-style': 'toolkit.kind.output-style',
};

/** 行图标：kind → lucide 图标。 */
function iconOfKind(kind: MarketRow['kind']): ReactNode {
  const cls = 'h-3.5 w-3.5 shrink-0';
  switch (kind) {
    case 'skill':
      return <FileCode className={cn(cls, 'text-emerald-400')} />;
    case 'mcp':
      return <Server className={cn(cls, 'text-blue-400')} />;
    case 'plugin':
      return <Puzzle className={cn(cls, 'text-violet-400')} />;
    default:
      return <FileCode className={cn(cls, 'text-blue-400')} />;
  }
}

/** 单行资产 + 展开详情（目标选择器 + 安装）+ 位置弹层。 */
function MarketRowView({
  row,
  bulkMode,
  bulkChecked,
  onBulkToggle,
  expanded,
  installedCount,
  locations,
  installedRows,
  capabilities,
  projects,
  onToggle,
  onOpenLocations,
  onJumpToProject,
  onInstall,
  onUninstall,
  installState,
}: {
  row: MarketRow;
  bulkMode: boolean;
  bulkChecked: boolean;
  onBulkToggle: () => void;
  expanded: boolean;
  installedCount: number;
  /** 非空 = 位置弹层打开，内容 = 该键的位置行。 */
  locations: InstallationRow[] | null;
  /** 该资源当前全部已装位置行（胶囊点亮与卸载的数据面）。 */
  installedRows: InstallationRow[];
  capabilities: InstallCapabilities | null;
  projects: ProjectRow[];
  onToggle: () => void;
  onOpenLocations: () => void;
  onJumpToProject: (projectId: number | null) => void;
  onInstall: (target: { scope: AssetScope; projectId: number | null; agent: AssetAgent }) => void;
  onUninstall: (target: { scope: AssetScope; projectId: number | null; agent: AssetAgent }) => void;
  installState: ActionState;
}) {
  const t = useT();
  const plugin = row.plugin;
  return (
    <div className="mb-1 rounded-md border border-edge/[0.06] bg-edge/[0.015]">
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
        className="flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 focus:outline-none focus-visible:ring-1 focus-visible:ring-edge/20 max-lg:flex-wrap"
      >
        {bulkMode && (
          <input
            type="checkbox"
            checked={bulkChecked}
            onClick={(e) => e.stopPropagation()}
            onChange={onBulkToggle}
            className="h-3 w-3 shrink-0 accent-emerald-500"
          />
        )}
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-neutral-600" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-neutral-600" />
        )}
        {iconOfKind(row.kind)}
        <Tooltip label={row.name} side="top" className="min-w-0">
          <span className="min-w-0 truncate text-xs font-medium text-neutral-200">
            {row.name}
          </span>
        </Tooltip>
        {plugin && <span className="shrink-0 font-mono text-10 text-neutral-500">v{plugin.version}</span>}
        {plugin ? (
          <Badge className={cn('shrink-0', KIND_STYLES[plugin.kind])}>
            {t(KIND_KEY[plugin.kind])}
          </Badge>
        ) : (
          <Badge className={cn('shrink-0', MARKET_KIND_STYLES[row.kind])}>
            {t(MARKET_KIND_KEY[row.kind])}
          </Badge>
        )}
        {row.shared && (
          <Tooltip
            label={`${t('market.sharedFrom')}: ${row.shared.sourceProjectName}`}
            side="top"
            className="shrink-0"
          >
            <span className="rounded bg-blue-900/30 px-1.5 py-0.5 text-10 text-blue-300">
              {t('market.sharedBadge')} · {row.shared.sourceProjectName}
            </span>
          </Tooltip>
        )}
        {plugin?.targets && plugin.targets.length > 0 && (
          <span className="shrink-0 text-10 text-neutral-600">
            {plugin.targets.map((h) => harnessUiOf(h).label).join('+')}
          </span>
        )}
        {installedCount > 0 && (
          <Tooltip label={t('market.installedLocations')} side="top" className="ml-auto shrink-0">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenLocations();
              }}
              className="rounded bg-emerald-900/40 px-1.5 py-0.5 text-10 text-emerald-300 hover:bg-emerald-900/60"
            >
              {t('market.installedCount', { n: installedCount })}
            </button>
          </Tooltip>
        )}
      </div>

      {/* 位置弹层：每行可点 → 跳该项目/全局的资源管理 */}
      {locations !== null && (
        <div className="space-y-0.5 border-t border-edge/[0.06] px-3 py-1.5">
          <p className="text-10 font-semibold uppercase text-neutral-500">
            {t('market.installedLocations')}
          </p>
          {locations.map((loc, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onJumpToProject(loc.projectId)}
              className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-11 text-neutral-300 hover:bg-neutral-800"
            >
              {loc.projectId === null ? (
                <Globe className="h-3 w-3 shrink-0 text-emerald-400" />
              ) : (
                <Package className="h-3 w-3 shrink-0 text-blue-400" />
              )}
              <span className="min-w-0 truncate">
                {loc.projectId === null ? t('market.locationGlobal') : loc.projectName}
              </span>
              <Badge variant="skill" className="shrink-0">
                {loc.scope === 'user' ? t('library.scopeGlobal') : t('library.scopeProject')}
              </Badge>
              <span className="ml-auto shrink-0 text-10 text-neutral-500">
                {harnessUiOf(loc.harness).label}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* 展开体：描述 → 成分 → 包内 skills → 目标选择器 + 安装 */}
      {expanded && (
        <div className="space-y-2 border-t border-edge/[0.06] px-3 py-2">
          {plugin?.description && (
            <Tooltip label={plugin.description} side="top" className="w-fit max-w-full">
              <p className="truncate text-11 text-neutral-500">{plugin.description}</p>
            </Tooltip>
          )}
          {plugin && plugin.components.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {plugin.components.map((c) => (
                <Badge key={c} variant="other" className="px-1 text-10">
                  {c}
                </Badge>
              ))}
            </div>
          )}
          {plugin && plugin.skills.length > 0 && (
            <div>
              <Tooltip label={t('library.pluginSkillsFollowTip')} side="top" className="w-fit">
                <p className="mb-0.5 text-10 text-neutral-600">
                  {t('library.pluginSkillsLabel')}
                </p>
              </Tooltip>
              <div className="flex flex-wrap gap-1">
                {plugin.skills.map((sname) => (
                  <Badge key={sname} variant="skill" className="px-1.5 text-10">
                    {sname}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          <InstallTargetPicker
            row={row}
            capabilities={capabilities}
            projects={projects}
            installedRows={installedRows}
            onInstall={onInstall}
            onUninstall={onUninstall}
            installState={installState}
          />
        </div>
      )}
    </div>
  );
}

/** 四档 slider 的档位词表（展示名；位置固定：未装 < local < project < user）。 */
const LEVELS = ['uninstalled', 'local', 'project', 'user'] as const;
type InstallLevel = (typeof LEVELS)[number];
const LEVEL_KEY: Record<InstallLevel, MessageKey> = {
  uninstalled: 'market.levelUninstalled',
  local: 'market.levelLocal',
  project: 'market.levelProject',
  user: 'market.levelUser',
};
/** 每落点一条四档滑条（未装→local→project→user；local 仅插件启停链，非插件禁用）。
 *  滑到新档弹 ConfirmDialog 确认后才发装卸动作；已在档位 = 滑动无效。 */
function InstallLevelSlider({
  name,
  nameTip,
  agent,
  agentScopes,
  currentLevel,
  onChange,
  loading,
}: {
  name: string;
  /** 名称悬停提示（项目行带路径——重名项目靠它区分）。 */
  nameTip?: string;
  agent: AssetAgent;
  /** 该 harness 该类别可装范围（矩阵派生；无该面的档自动禁用）。 */
  agentScopes: AssetScope[];
  currentLevel: InstallLevel;
  onChange: (level: InstallLevel, scope: AssetScope | null) => void;
  loading: boolean;
}) {
  const t = useT();
  const [confirm, setConfirm] = useState<{
    level: InstallLevel;
    scope: AssetScope | null;
    uninstall: boolean;
  } | null>(null);

  // 档位可用性：local 只对插件启停链开放（落装仍两档，2026-11-16 定案）；
  // project/user 面缺失自动禁用。
  const enabledOf = (level: InstallLevel): boolean => {
    if (level === 'uninstalled') return true;
    if (level === 'local') return false; // 非插件行落装无 local 档
    return agentScopes.includes(level);
  };

  const tryLevel = (level: InstallLevel): void => {
    if (level === currentLevel) return;
    if (!enabledOf(level)) return;
    if (level === 'uninstalled') {
      // 卸载 = 回到未装：确认后按当前档对应落点卸
      const scope = currentLevel === 'user' ? 'user' : 'project';
      setConfirm({ level, scope, uninstall: true });
    } else {
      setConfirm({ level, scope: level, uninstall: false });
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Tooltip label={nameTip ?? name} side="top" className="w-32 max-w-32 shrink-0">
        <span className="min-w-0 truncate text-11 text-neutral-400">{name}</span>
      </Tooltip>
      <span className="text-10 shrink-0 text-neutral-600">{harnessUiOf(agent).label}</span>
      {/* 分段控制器（segmented control）：选中段浮起白底，禁用段灰字不可点 */}
      <span
        role="radiogroup"
        aria-label={t('market.sliderTip')}
        className="ml-auto inline-flex shrink-0 items-center rounded-md bg-neutral-900 p-0.5"
      >
        {LEVELS.map((lv) => {
          const active = lv === currentLevel;
          const usable = enabledOf(lv);
          const btn = (
            <button
              key={lv}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={loading || (!active && !usable)}
              onClick={() => tryLevel(lv)}
              className={cn(
                'rounded px-1.5 py-0.5 text-10 transition-colors',
                active
                  ? 'bg-neutral-700 text-neutral-100 shadow-sm'
                  : usable
                    ? 'text-neutral-500 hover:text-neutral-300'
                    : 'cursor-not-allowed text-neutral-700',
              )}
            >
              {t(LEVEL_KEY[lv])}
            </button>
          );
          return !usable && lv !== 'uninstalled' ? (
            <Tooltip
              key={lv}
              label={t('market.sliderDisabledScope', { level: t(LEVEL_KEY[lv]) })}
              side="top"
            >
              {btn}
            </Tooltip>
          ) : (
            btn
          );
        })}
      </span>
      <ConfirmDialog
        open={confirm !== null}
        title={t(confirm?.uninstall ? 'market.confirmUninstallTitle' : 'market.confirmInstallTitle')}
        message={
          confirm === null
            ? ''
            : confirm.uninstall
              ? t('market.confirmUninstallMsg', {
                  name,
                  dest:
                    confirm.scope === 'user'
                      ? t('market.destGlobal')
                      : t('market.scopeProject'),
                })
              : t('market.confirmInstallMsg', {
                  name,
                  dest: confirm.scope === 'user' ? t('market.destGlobal') : t('market.scopeProject'),
                })
        }
        confirmLabel={t(confirm?.uninstall ? 'market.confirmUninstallTitle' : 'market.confirmInstallTitle')}
        onConfirm={() => {
          if (confirm) onChange(confirm.level, confirm.scope);
        }}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}

/** 多选批操作滑条：选中若干资源后统一选落点（全局/每项目）装过去，二次确认。 */
function BulkInstallSlider({
  names,
  projects,
  onApply,
  loading,
}: {
  names: string[];
  projects: ProjectRow[];
  onApply: (scope: AssetScope, projectId: number | null, agent: AssetAgent) => void;
  loading: boolean;
}) {
  const t = useT();
  const [target, setTarget] = useState<string>('__global__');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const p = projects.find((x) => String(x.id) === target) ?? null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="rounded border border-edge/[0.1] bg-neutral-900 px-2 py-0.5 text-11 text-neutral-200"
      >
        <option value="__global__">{t('market.destGlobal')}</option>
        {projects.map((x) => (
          <option key={x.id} value={String(x.id)}>
            {x.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={loading}
        onClick={() => setConfirmOpen(true)}
        className="shrink-0 rounded bg-blue-900/40 px-2 py-0.5 text-11 text-blue-200 hover:bg-blue-900/60 disabled:opacity-40"
      >
        {loading ? t('library.installing') : t('market.batchApply')}
      </button>
      <ConfirmDialog
        open={confirmOpen}
        title={t('market.confirmInstallTitle')}
        message={t('market.batchConfirmMsg', {
          n: names.length,
          dest: p ? t('market.destProject', { name: p.name }) : t('market.destGlobal'),
        })}
        confirmLabel={t('market.batchApply')}
        onConfirm={() =>
          p ? onApply('project', p.id, 'claude') : onApply('user', null, 'claude')
        }
        onClose={() => setConfirmOpen(false)}
      />
    </div>
  );
}

/** 安装目标选择器：落点行 × 四档滑条（未装→local→project→user），切换二次确认。 */
function InstallTargetPicker({
  row,
  capabilities,
  projects,
  installedRows,
  onInstall,
  onUninstall,
  installState,
}: {
  row: MarketRow;
  capabilities: InstallCapabilities | null;
  projects: ProjectRow[];
  /** 该资源当前全部已装位置行（含全局），滑条当前档与卸载载荷的数据面。 */
  installedRows: InstallationRow[];
  onInstall: (target: { scope: AssetScope; projectId: number | null; agent: AssetAgent }) => void;
  onUninstall: (target: { scope: AssetScope; projectId: number | null; agent: AssetAgent }) => void;
  installState: ActionState;
}) {
  const t = useT();
  const isPlugin = row.kind === 'plugin';
  const category = row.kind === 'plugin' ? 'skill' : row.kind;
  const attrs = capabilitiesOf(category, capabilities);
  const surfaces = attrs.surfaces;
  /** 共享行 harness 固定（来源实配的 harness）；其余行可切 harness。 */
  const sharedHarness = row.shared?.harness;
  const [agent, setAgent] = useState<AssetAgent>(sharedHarness ?? surfaces[0]?.harness ?? 'claude');
  const activeAgent = sharedHarness ?? agent;
  const agentScopes = surfaces.find((s) => s.harness === activeAgent)?.scopes ?? [];

  const handleChange = (
    projectId: number | null,
    level: InstallLevel,
    scope: AssetScope | null,
  ): void => {
    if (level === 'uninstalled' && scope) {
      onUninstall({ scope, projectId, agent: activeAgent });
    } else if (scope) {
      onInstall({ scope, projectId, agent: activeAgent });
    }
  };

  const loading = installState === 'loading';
  const anySlider = projects.length > 0;

  return (
    <div className="space-y-1.5 rounded bg-neutral-950/60 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="shrink-0 text-11 text-neutral-500">{t('market.installTo')}</span>
        {/* harness 切换（skill/mcp；共享行 harness 固定） */}
        {!isPlugin && !sharedHarness && surfaces.length > 1 && (
          <div className="flex shrink-0 items-center rounded bg-neutral-900 p-0.5">
            {surfaces.map((s) => (
              <button
                key={s.harness}
                type="button"
                onClick={() => setAgent(s.harness)}
                className={cn(
                  'rounded px-2 py-0.5 text-11',
                  agent === s.harness ? 'bg-neutral-700 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300',
                )}
              >
                {harnessUiOf(s.harness).label}
              </button>
            ))}
          </div>
        )}
        <span className="text-10 text-neutral-600">{t('market.sliderTip')}</span>
      </div>
      {!anySlider && <p className="text-11 text-neutral-600">{t('market.chooseProjectCapsule')}</p>}
      {anySlider && (
        <div className="space-y-1">
          {projects.map((p) => {
            const installed = installedRows.some((r) => r.projectId === p.id);
            return (
              <InstallLevelSlider
                key={p.id}
                name={p.name}
                nameTip={p.path}
                agent={activeAgent}
                agentScopes={agentScopes}
                currentLevel={installed ? 'project' : 'uninstalled'}
                onChange={(level, scope) => handleChange(p.id, level, scope)}
                loading={loading}
              />
            );
          })}
        </div>
      )}
      {loading && (
        <div className="flex items-center">
          <FeedbackIcon
            state={installState}
            className="h-3 w-3"
            icon={<Download className="h-3 w-3" />}
          />
          <span className="ml-1 text-11 text-neutral-400">{t('library.installing')}</span>
        </div>
      )}
    </div>
  );
}

/** MCP 配置视图：聚合托管项目实配清单（折叠行：分段控制器 + 展开编辑）+ 手动添加。 */
function McpConfigView({
  shared,
  projects,
  installIndex,
  onInstall,
  onUninstall,
  onManualAdd,
}: {
  shared: McpSharedRow[];
  projects: ProjectRow[];
  installIndex: Map<string, InstallationRow[]>;
  onInstall: (
    name: string,
    config: McpServerConfig,
    scope: AssetScope,
    agent: AssetAgent,
    project: ProjectRow | null,
  ) => void;
  onUninstall: (
    name: string,
    scope: AssetScope,
    agent: AssetAgent,
    project: ProjectRow | null,
  ) => void;
  onManualAdd: (
    name: string,
    config: McpServerConfig,
    scope: AssetScope,
    agent: AssetAgent,
    project: ProjectRow | null,
  ) => void;
}) {
  const t = useT();
  const [formOpen, setFormOpen] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      {/* 手动添加（折叠条）：添加时选项目或全局 */}
      <div className="rounded-md border border-edge/[0.06] bg-edge/[0.015]">
        <button
          type="button"
          onClick={() => setFormOpen((v) => !v)}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left"
        >
          {formOpen ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-neutral-600" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-neutral-600" />
          )}
          <Server className="h-3.5 w-3.5 shrink-0 text-blue-400" />
          <span className="text-xs font-medium text-neutral-200">{t('market.addMcp')}</span>
        </button>
        {formOpen && (
          <div className="border-t border-edge/[0.06] px-3 py-2">
            <McpForm
              projects={projects}
              onInstall={(name, config, scope, agent, project) => {
                onManualAdd(name, config, scope, agent, project);
              }}
            />
          </div>
        )}
      </div>

      {/* 聚合清单：一行一个 server（harness×名去重），折叠行 */}
      {shared.length === 0 ? (
        <p className="rounded-md border border-dashed border-edge/[0.06] p-3 text-xs text-neutral-600">
          {t('market.mcpConfigEmpty')}
        </p>
      ) : (
        shared.map((s) => {
          const key = `${s.harness}:${s.name}`;
          const installedRows = (installIndex.get(`mcp\0${s.name}`) ?? []).filter(
            (r) => r.harness === s.harness,
          );
          return (
            <McpConfigRow
              key={key}
              shared={s}
              projects={projects}
              installedRows={installedRows}
              expanded={expandedKey === key}
              onToggle={() => setExpandedKey((prev) => (prev === key ? null : key))}
              onInstall={onInstall}
              onUninstall={onUninstall}
            />
          );
        })
      )}
    </div>
  );
}

/** MCP 配置单行：头行（名 + harness + 来源项目徽标 + 已装 N 处）+ 展开
 *  体（每项目分段控制器安装 + 配置编辑 JSON/表单双视图）。 */
function McpConfigRow({
  shared,
  projects,
  installedRows,
  expanded,
  onToggle,
  onInstall,
  onUninstall,
}: {
  shared: McpSharedRow;
  projects: ProjectRow[];
  installedRows: InstallationRow[];
  expanded: boolean;
  onToggle: () => void;
  onInstall: (
    name: string,
    config: McpServerConfig,
    scope: AssetScope,
    agent: AssetAgent,
    project: ProjectRow | null,
  ) => void;
  onUninstall: (
    name: string,
    scope: AssetScope,
    agent: AssetAgent,
    project: ProjectRow | null,
  ) => void;
}) {
  const t = useT();
  /** 安装目标 harness（默认 = 来源实配的 harness；可切到其他 harness 装同款配置）。 */
  const [agent, setAgent] = useState<AssetAgent>(shared.harness);
  const agentInstalledRows = installedRows.filter((r) => r.harness === agent);
  return (
    <div className="rounded-md border border-edge/[0.06] bg-edge/[0.015]">
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
        className="flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 max-lg:flex-wrap"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-neutral-600" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-neutral-600" />
        )}
        <Server className="h-3.5 w-3.5 shrink-0 text-blue-400" />
        <Tooltip label={shared.name} side="top" className="min-w-0">
          <span className="min-w-0 truncate text-xs font-medium text-neutral-200">
            {shared.name}
          </span>
        </Tooltip>
        <Badge className="shrink-0 bg-blue-900/40 text-blue-300">{t('toolkit.kind.mcp')}</Badge>
        {/* harness 切换 tab：安装目标 harness（来源实配的 harness 高亮起点） */}
        <span
          role="radiogroup"
          aria-label="harness"
          className="shrink-0 inline-flex items-center rounded bg-neutral-900 p-0.5"
          onClick={(e) => e.stopPropagation()}
        >
          {(['claude', 'codex'] as AssetAgent[]).map((h) => (
            <button
              key={h}
              type="button"
              role="radio"
              aria-checked={agent === h}
              onClick={() => setAgent(h)}
              className={cn(
                'rounded px-1.5 py-0.5 text-10',
                agent === h ? 'bg-neutral-700 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300',
              )}
            >
              {harnessUiOf(h).label}
            </button>
          ))}
        </span>
        <Tooltip
          label={`${t('market.sharedFrom')}: ${shared.sourceProjectName}${shared.alsoIn.length > 0 ? ` · ${shared.alsoIn.map((a) => a.projectName).join(', ')}` : ''}`}
          side="top"
          className="shrink-0"
        >
          <span className="rounded bg-blue-900/30 px-1.5 py-0.5 text-10 text-blue-300">
            {t('market.sharedBadge')} · {shared.sourceProjectName}
            {shared.alsoIn.length > 0 && ` +${shared.alsoIn.length}`}
          </span>
        </Tooltip>
        {agentInstalledRows.length > 0 && (
          <span className="ml-auto shrink-0 rounded bg-emerald-900/40 px-1.5 py-0.5 text-10 text-emerald-300">
            {t('market.installedCount', { n: agentInstalledRows.length })}
          </span>
        )}
      </div>
      {expanded && (
        <div className="space-y-2 border-t border-edge/[0.06] px-3 py-2">
          <McpConfigEditor config={shared.config} />
          <div className="rounded bg-neutral-950/60 p-2">
            <p className="mb-1.5 text-11 text-neutral-500">
              {t('market.installTo')}
              <span className="ml-1 text-10 text-neutral-600">
                ({t('market.installToHarness', { harness: harnessUiOf(agent).label })})
              </span>
            </p>
            <div className="space-y-1">
              {projects.map((p) => {
                const installed = agentInstalledRows.some((r) => r.projectId === p.id);
                return (
                  <InstallLevelSlider
                    key={p.id}
                    name={p.name}
                    nameTip={p.path}
                    agent={agent}
                    agentScopes={['project', 'user']}
                    currentLevel={installed ? 'project' : 'uninstalled'}
                    onChange={(level, scope) => {
                      if (level === 'uninstalled' && scope) {
                        onUninstall(shared.name, scope, agent, p);
                      } else if (scope) {
                        onInstall(shared.name, shared.config, scope, agent, p);
                      }
                    }}
                    loading={false}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** MCP 配置编辑：JSON 原文 / 表单双视图切换（只展示；提交走行内分段控制器）。 */
function McpConfigEditor({ config }: { config: McpServerConfig }) {
  const t = useT();
  const [mode, setMode] = useState<'json' | 'form'>('json');
  const json = JSON.stringify(config, null, 2);
  return (
    <div className="rounded bg-neutral-950/60 p-2">
      <div className="mb-1.5 flex items-center gap-1">
        <span className="text-11 text-neutral-500">{t('market.mcpConfigEdit')}</span>
        <div className="ml-auto flex items-center rounded bg-neutral-900 p-0.5">
          {(['json', 'form'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'rounded px-2 py-0.5 text-11',
                mode === m ? 'bg-neutral-700 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300',
              )}
            >
              {t(m === 'json' ? 'market.mcpConfigJson' : 'market.mcpConfigForm')}
            </button>
          ))}
        </div>
      </div>
      {mode === 'json' ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-neutral-900 p-2 font-mono text-11 text-neutral-300">
          {json}
        </pre>
      ) : (
        <div className="space-y-1 text-11 text-neutral-300">
          {'command' in config ? (
            <>
              <div className="flex flex-wrap gap-2">
                <span className="text-neutral-500">{t('library.mcpCommandPlaceholder')}:</span>
                <span className="font-mono">{config.command}</span>
              </div>
              {config.args && config.args.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  <span className="text-neutral-500">{t('library.mcpArgsPlaceholder')}:</span>
                  <span className="font-mono break-all">{config.args.join(' ')}</span>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              <span className="text-neutral-500">url:</span>
              <span className="font-mono break-all">{config.url}</span>
            </div>
          )}
          {'env' in config && config.env && Object.keys(config.env).length > 0 && (
            <div className="flex flex-wrap gap-2">
              <span className="text-neutral-500">{t('library.mcpEnvPlaceholder')}:</span>
              <span className="font-mono break-all">
                {Object.entries(config.env).map(([k, v]) => `${k}=${v}`).join(', ')}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** MCP 手填表单（自 LibraryPanel 迁入；添加时选项目或全局）。 */
function McpForm({
  projects,
  onInstall,
}: {
  projects: ProjectRow[];
  onInstall: (
    name: string,
    config: McpServerConfig,
    scope: AssetScope,
    agent: AssetAgent,
    project: ProjectRow | null,
  ) => void;
}) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const [target, setTarget] = useState<string>('__global__');
  const t = useT();
  const submitState = useActionFeedback().stateOf('mkt-mcp-manual');

  function submit() {
    const n = name.trim();
    const cmd = command.trim();
    if (!n || !cmd || submitState === 'loading') return;
    const argList = args.trim() ? args.trim().split(/\s+/) : undefined;
    const lines = env
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const envMap: Record<string, string> = {};
    for (const line of lines) {
      const i = line.indexOf('=');
      if (i > 0) envMap[line.slice(0, i)] = line.slice(i + 1);
    }
    const p = projects.find((x) => String(x.id) === target) ?? null;
    onInstall(
      n,
      {
        command: cmd,
        ...(argList && { args: argList }),
        ...(Object.keys(envMap).length > 0 && { env: envMap }),
      },
      p ? 'project' : 'user',
      'claude',
      p,
    );
    setName('');
    setCommand('');
    setArgs('');
    setEnv('');
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('library.mcpNamePlaceholder')}
        className="w-32 font-mono"
      />
      <Input
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        placeholder={t('library.mcpCommandPlaceholder')}
        className="w-44 min-w-0 flex-1 font-mono"
      />
      <Input
        value={args}
        onChange={(e) => setArgs(e.target.value)}
        placeholder={t('library.mcpArgsPlaceholder')}
        className="w-36 font-mono"
      />
      <Input
        value={env}
        onChange={(e) => setEnv(e.target.value)}
        placeholder={t('library.mcpEnvPlaceholder')}
        className="w-44 font-mono"
      />
      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="shrink-0 rounded border border-edge/[0.1] bg-neutral-900 px-2 py-1 text-11 text-neutral-200"
      >
        <option value="__global__">{t('market.destGlobal')}</option>
        {projects.map((x) => (
          <option key={x.id} value={String(x.id)}>
            {x.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={submit}
        disabled={!name.trim() || !command.trim() || submitState === 'loading'}
        className="shrink-0 rounded bg-blue-900/40 px-2 py-1 text-xs text-blue-300 disabled:opacity-40"
      >
        {t('library.addMcpServer')}
      </button>
    </div>
  );
}
