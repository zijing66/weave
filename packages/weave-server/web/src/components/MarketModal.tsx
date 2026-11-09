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
  type ProjectRow,
  type SkillAsset,
} from '@/lib/api';
import {
  capabilitiesOf,
  canInstall,
  type InstallVerdict,
} from '@/lib/install-capabilities';
import {
  buildInstallationIndex,
  filterAndRankRows,
  installationKeyOfRow,
  rowsOfLibrary,
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
  /** 跳转：关弹层 + 进该项目（null = 全局）的资源管理。 */
  onJumpToProject: (projectId: number | null) => void;
}

const EMPTY_ASSETS: LibraryAssets = { skills: [], mcp: [], files: [], plugins: [] };

export function MarketModal({
  onClose,
  projects,
  defaultProjectId,
  capabilities,
  onInstallSkill,
  onInstallMcp,
  onInstallFileAsset,
  onInstallPlugin,
  onJumpToProject,
}: MarketModalProps) {
  const t = useT();
  const { show } = useToast();
  const fb = useActionFeedback();

  const [market, setMarket] = useState<MarketItem[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  /** 库资产缓存（id → 四类扫描结果）；搜索时全量补齐。 */
  const [libCache, setLibCache] = useState<Map<number, LibraryAssets>>(new Map());
  const [query, setQuery] = useState('');
  const [expandedUid, setExpandedUid] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [mcpFormOpen, setMcpFormOpen] = useState(false);
  /** 位置弹层锚定的行键（installationKeyOfRow 形）。 */
  const [locationsKey, setLocationsKey] = useState<string | null>(null);
  const [installIndex, setInstallIndex] = useState<Map<string, InstallationRow[]>>(new Map());
  const [removeTarget, setRemoveTarget] = useState<MarketItem | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [gitUrl, setGitUrl] = useState('');
  const [marketStatus, setMarketStatus] = useState<Map<number, MarketUpdateStatus>>(new Map());

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

  // 打开即拉：市场源 + 安装位置快照
  useEffect(() => {
    void refreshMarket();
    reloadInstallations();
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

  // 选中源 → 拉资产
  useEffect(() => {
    if (selectedId !== null) void loadLibrary(selectedId).catch(() => setLibCache((prev) => new Map(prev).set(selectedId, EMPTY_ASSETS)));
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

  /** 当前展示的行集：搜索 = 全部源并集过滤排序；否则 = 选中源的摊平行。 */
  const rows: MarketRow[] = useMemo(() => {
    if (searching) {
      const all = [...libCache.values()].flatMap((a) => rowsOfLibrary(0, a));
      return filterAndRankRows(all, query);
    }
    if (selectedId === null) return [];
    const assets = libCache.get(selectedId);
    return assets ? rowsOfLibrary(selectedId, assets) : [];
  }, [searching, query, libCache, selectedId]);

  /** ESC 逐层退：位置弹层 → 源管理 → MCP 表单 → 行展开 → 关 modal。 */
  const layerRefs = {
    locationsKey,
    sourcesOpen,
    mcpFormOpen,
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
      else if (l.mcpFormOpen) setMcpFormOpen(false);
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
    if (l.mcpFormOpen) {
      setMcpFormOpen(false);
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
          <Tooltip label={t('market.addMcp')} side="top">
            <button
              type="button"
              onClick={() => setMcpFormOpen((v) => !v)}
              className={cn(
                'shrink-0 rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700',
                mcpFormOpen && 'bg-neutral-700 text-neutral-100',
              )}
            >
              <Server className="mr-1 inline h-3 w-3" />
              {t('market.addMcp')}
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

        {/* MCP 手填表单 */}
        {mcpFormOpen && (
          <div className="shrink-0 border-b border-edge/[0.06] px-3 py-2">
            <McpForm
              onInstall={(name, config) => {
                void (async () => {
                  await onInstallMcp(name, config, 'user', 'claude', null);
                  reloadInstallations();
                })();
              }}
            />
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
                removeState={fb.stateOf(`mkt-remove:${item.id}`)}
                migrateState={fb.stateOf(`mkt-migrate:${item.id}`)}
              />
            ))}
            {market.length === 0 && (
              <p className="px-1 text-11 text-neutral-600">{t('library.noTemplatesHint')}</p>
            )}
          </div>

          {/* 右栏：资产行清单 */}
          <div className="min-w-0 flex-1 overflow-y-auto p-2">
            {/* <lg：源 chips 行（搜索态隐藏） */}
            {!searching && (
              <div className="mb-2 flex flex-wrap gap-1 lg:hidden">
                {[...builtinMarkets, ...localMarkets, ...gitMarkets].map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    className={cn(
                      'rounded-full px-2 py-0.5 text-11',
                      selectedId === item.id
                        ? 'bg-neutral-700 text-neutral-100'
                        : 'bg-neutral-800 text-neutral-400',
                    )}
                  >
                    {item.resourceId ?? item.path}
                  </button>
                ))}
              </div>
            )}

            {!searching && selectedId === null && (
              <p className="p-6 text-center text-xs text-neutral-500">
                {t('market.noLibrarySelected')}
              </p>
            )}
            {(searching || selectedId !== null) && rows.length === 0 && (
              <p className="p-6 text-center text-xs text-neutral-500">
                {searching ? t('market.noResults') : t('library.scanning')}
              </p>
            )}
            {rows.map((row) => (
              <MarketRowView
                key={row.uid}
                row={row}
                expanded={expandedUid === row.uid}
                installedCount={installedCountOf(row)}
                locations={locationsKey === installationKeyOfRow(row) ? installIndex.get(locationsKey) ?? [] : null}
                capabilities={capabilities}
                projects={projects}
                defaultProjectId={defaultProjectId}
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
  removeState,
  migrateState,
}: {
  item: MarketItem;
  selected: boolean;
  status?: MarketUpdateStatus;
  onSelect: () => void;
  onRemove: (item: MarketItem) => void;
  onMigrate: (item: MarketItem) => void;
  removeState: string;
  migrateState: string;
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
      title={item.path}
    >
      <span className="min-w-0 truncate text-xs text-neutral-200">
        {item.managed && item.resourceId ? item.resourceId : item.path}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {statusCfg && (
          <span className={cn('rounded px-1.5 py-0.5 text-10', statusCfg.cls)}>{statusCfg.label}</span>
        )}
        <span className={cn('rounded px-1.5 py-0.5 text-10', sourceCfg.cls)}>{sourceCfg.label}</span>
        {item.source === 'legacy' && (
          <Tooltip label={t('library.migrateTip')} side="top">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onMigrate(item);
              }}
              disabled={migrateState === 'loading'}
              className="text-neutral-500 hover:text-blue-400 disabled:cursor-not-allowed"
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
              className="text-neutral-500 hover:text-red-400 disabled:cursor-not-allowed"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </Tooltip>
        )}
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
  expanded,
  installedCount,
  locations,
  capabilities,
  projects,
  defaultProjectId,
  onToggle,
  onOpenLocations,
  onJumpToProject,
  onInstall,
  installState,
}: {
  row: MarketRow;
  expanded: boolean;
  installedCount: number;
  /** 非空 = 位置弹层打开，内容 = 该键的位置行。 */
  locations: InstallationRow[] | null;
  capabilities: InstallCapabilities | null;
  projects: ProjectRow[];
  /** 当前锚定项目（目标选择器默认落点）。 */
  defaultProjectId?: number | null;
  onToggle: () => void;
  onOpenLocations: () => void;
  onJumpToProject: (projectId: number | null) => void;
  onInstall: (target: { scope: AssetScope; projectId: number | null; agent: AssetAgent }) => void;
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
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-neutral-600" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-neutral-600" />
        )}
        {iconOfKind(row.kind)}
        <span className="min-w-0 truncate text-xs font-medium text-neutral-200" title={row.name}>
          {row.name}
        </span>
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
            <p className="text-11 text-neutral-500" title={plugin.description}>
              {plugin.description}
            </p>
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
              <p className="mb-0.5 text-10 text-neutral-600" title={t('library.pluginSkillsFollowTip')}>
                {t('library.pluginSkillsLabel')}
              </p>
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
            defaultProjectId={defaultProjectId}
            onInstall={onInstall}
            installState={installState}
          />
        </div>
      )}
    </div>
  );
}

/** 安装落点选择器：scope 分段 + 项目下拉 + harness 切换 + 安装按钮。 */
function InstallTargetPicker({
  row,
  capabilities,
  projects,
  defaultProjectId,
  onInstall,
  installState,
}: {
  row: MarketRow;
  capabilities: InstallCapabilities | null;
  projects: ProjectRow[];
  /** 当前锚定项目：项目落点的默认选中（缺省回落首项）。 */
  defaultProjectId?: number | null;
  onInstall: (target: { scope: AssetScope; projectId: number | null; agent: AssetAgent }) => void;
  installState: ActionState;
}) {
  const t = useT();
  const isPlugin = row.kind === 'plugin';
  const category = row.kind === 'plugin' ? 'skill' : row.kind;
  const attrs = capabilitiesOf(category, capabilities);
  const surfaces = attrs.surfaces;

  const [scope, setScope] = useState<AssetScope>(isPlugin ? 'project' : 'user');
  const [projectId, setProjectId] = useState<number | null>(
    defaultProjectId ?? projects[0]?.id ?? null,
  );
  const [agent, setAgent] = useState<AssetAgent>(surfaces[0]?.harness ?? 'claude');

  const verdict: InstallVerdict | null = isPlugin
    ? null
    : canInstall(attrs, { scope, agent });
  const pluginReady = !isPlugin || (scope === 'project' && projectId !== null);

  return (
    <div className="space-y-1.5 rounded bg-neutral-950/60 p-2 max-lg:flex-wrap">
      <div className="flex flex-wrap items-center gap-2">
        <span className="shrink-0 text-11 text-neutral-500">{t('market.installTo')}</span>
        {/* scope 分段：插件包恒项目（toolkit enable 是项目动作） */}
        <div className="flex shrink-0 items-center rounded bg-neutral-900 p-0.5">
          {(['user', 'project'] as const).map((s) => (
            <button
              key={s}
              type="button"
              disabled={isPlugin && s === 'user'}
              onClick={() => setScope(s)}
              className={cn(
                'rounded px-2 py-0.5 text-11',
                scope === s ? 'bg-neutral-700 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300',
                isPlugin && s === 'user' && 'cursor-not-allowed opacity-40',
              )}
              title={isPlugin && s === 'user' ? t('market.pluginProjectOnly') : undefined}
            >
              {s === 'user' ? t('library.scopeGlobal') : t('library.scopeProject')}
            </button>
          ))}
        </div>
        {/* 项目下拉（scope=project 时） */}
        {scope === 'project' && (
          <Tooltip label={t('market.chooseProject')} side="top">
            <select
              value={projectId ?? ''}
              onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}
              className="min-w-0 max-w-48 shrink-0 rounded bg-neutral-900 px-1.5 py-0.5 text-11"
            >
              {projects.length === 0 && <option value="">{t('market.chooseProject')}</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Tooltip>
        )}
        {/* harness 切换（skill/mcp；文件类资产今天只有 claude 面） */}
        {!isPlugin && surfaces.length > 1 && (
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
        <button
          type="button"
          disabled={installState === 'loading' || (verdict ? !verdict.ok : !pluginReady)}
          title={verdict && !verdict.ok && verdict.reasonKey ? t(verdict.reasonKey) : undefined}
          onClick={() => onInstall({ scope, projectId, agent })}
          className="ml-auto shrink-0 rounded bg-blue-900/50 px-2 py-0.5 text-11 text-blue-200 hover:bg-blue-800/60 disabled:opacity-40"
        >
          <FeedbackIcon
            state={installState}
            className="h-3 w-3"
            icon={<Download className="h-3 w-3" />}
          />
          {installState === 'loading' ? t('library.installing') : t('library.install')}
        </button>
      </div>
    </div>
  );
}

/** MCP 手填表单（自 LibraryPanel 迁入，提交走注入的 onInstallMcp）。 */
function McpForm({
  onInstall,
}: {
  onInstall: (name: string, config: McpServerConfig) => void;
}) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const t = useT();
  const { show } = useToast();
  const fb = useActionFeedback();
  const submitState = fb.stateOf('mkt-mcp-submit');

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
    void fb.run(
      'mkt-mcp-submit',
      async () => {
        await onInstall(n, {
          command: cmd,
          ...(argList && { args: argList }),
          ...(Object.keys(envMap).length > 0 && { env: envMap }),
        });
        show('success', t('library.installedOk', { name: n }));
        setName('');
        setCommand('');
        setArgs('');
        setEnv('');
      },
      { fail: (e) => t('errors.mcpInstallFailed', { error: errorText(e) }) },
    );
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
