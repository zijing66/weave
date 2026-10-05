import { useEffect, useState, type ReactNode } from 'react';
import { useDraggable } from '@dnd-kit/core';
import {
  api,
  type MarketItem,
  type MarketUpdateStatus,
  type SkillAsset,
  type McpTemplate,
  type McpServerConfig,
  type AssetScope,
  type AssetAgent,
  type FileAssetTemplate,
  type FileAssetCategory,
  type UpdateReport,
  type InstallCapabilities,
  type MarketPluginAsset,
  type ToolkitPack,
  FILE_ASSET_CATEGORIES,
} from '@/lib/api';
import {
  capabilitiesOf,
  canInstall,
  buildDragPayload,
  type InstallVerdict,
  type DragPayload,
} from '@/lib/install-capabilities';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { KIND_KEY, KIND_STYLES } from '@/components/ToolkitSection';
import { DirectoryPickerModal } from '@/components/DirectoryPickerModal';
import { cn } from '@/lib/utils';
import { BUCKET_ORDER, ROW_TAG_BASE, kindColor } from '@/lib/file-tags';
import { useT, type TFunc } from '@/i18n/I18nProvider';
import { type MainCategory } from '@/components/CategoryBar';
import { type AssetTab } from '@/components/CategoryDetail';
import {
  GripVertical,
  Trash2,
  Server,
  Globe,
  Folder,
  FolderOpen,
  FileCode,
  RefreshCw,
  PackageX,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ChevronsDownUp,
  GitBranch,
  Puzzle,
  Download,
} from 'lucide-react';

/** 路径归一（反斜杠 → posix）：市场包 dirPath 与 toolkit pack.dir 的匹配键。 */
const normPath = (p: string) => p.replace(/\\/g, '/');

interface LibraryPanelProps {
  /** Skill names already installed in the selected project (for the ✓ mark). */
  installedSkillNames: Set<string>;
  /** Click-to-install fallback (drag is the primary interaction). */
  onInstallSkill: (skill: SkillAsset, scope: AssetScope, agent: AssetAgent) => void;
  onInstallFileAsset: (file: FileAssetTemplate, scope: AssetScope) => void;
  onInstallMcp: (name: string, config: McpServerConfig, scope: AssetScope, agent?: AssetAgent) => void;
  updates: UpdateReport | null;
  onUpdateAsset: (
    category: 'skill' | 'mcp' | FileAssetCategory,
    name: string,
    scope: AssetScope,
    agent?: AssetAgent,
  ) => void;
  /** Which main category is active — the panel shows matching installable lists. */
  category: MainCategory;
  /** Files-page asset tab: splits the skills/MCP template sections. */
  assetTab: AssetTab;
  /** Install-to scope, driven by the current project/global context. */
  scope: AssetScope;
  /** 安装属性矩阵（GET /capabilities）；未加载时谓词全放行。 */
  capabilities: InstallCapabilities | null;
  /** 当前锚定项目（插件包启用走 toolkit enable 端点）。 */
  projectId: number;
  /** 一键更新第二步：App 侧 syncAll（含 updates/assets 刷新编排）。 */
  onSyncAll: () => void | Promise<void>;
}

export function LibraryPanel({
  installedSkillNames,
  onInstallSkill,
  onInstallFileAsset,
  onInstallMcp,
  updates,
  onUpdateAsset,
  category,
  assetTab,
  scope,
  capabilities,
  projectId,
  onSyncAll,
}: LibraryPanelProps) {
  const [market, setMarket] = useState<MarketItem[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [skills, setSkills] = useState<SkillAsset[]>([]);
  const [fileTemplates, setFileTemplates] = useState<FileAssetTemplate[]>([]);
  const [mcp, setMcp] = useState<McpTemplate[]>([]);
  const [plugins, setPlugins] = useState<MarketPluginAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** git 导入输入与进行中标记。 */
  const [gitUrl, setGitUrl] = useState('');
  const [importingGit, setImportingGit] = useState(false);
  /** Install-to runtime for skills and MCP (Claude vs Codex surfaces). */
  const [installAgent, setInstallAgent] = useState<AssetAgent>('claude');
  /** 覆盖导入 / 缓存刷新后 +1 → 同 id 资产重扫（M8 scanNonce）。 */
  const [scanNonce, setScanNonce] = useState(0);
  /** 批量检查结果（POST /market/check-updates，不落库）。 */
  const [marketStatus, setMarketStatus] = useState<Map<number, MarketUpdateStatus>>(new Map());
  const [checking, setChecking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** 插件包区的 toolkit 启用态（按 dir 匹配）。 */
  const [toolkitPacks, setToolkitPacks] = useState<ToolkitPack[] | null>(null);
  const [pluginBusy, setPluginBusy] = useState<string | null>(null);
  const t = useT();

  // 安装前置判定（与拖拽 canDrop 共用 lib/install-capabilities 谓词）
  const skillVerdict = canInstall(capabilitiesOf('skill', capabilities), {
    scope,
    agent: installAgent,
  });
  const mcpVerdict = canInstall(capabilitiesOf('mcp', capabilities), {
    scope,
    agent: installAgent,
  });
  const reasonTitle = (v: InstallVerdict): string | undefined =>
    v.ok || !v.reasonKey ? undefined : t(v.reasonKey);

  const refreshMarket = () =>
    api.listMarket().then(setMarket).catch((e) => setError(String(e)));

  useEffect(() => {
    void refreshMarket();
  }, []);

  useEffect(() => {
    if (selectedId === null) {
      setSkills([]);
      setFileTemplates([]);
      setMcp([]);
      setPlugins([]);
      return;
    }
    setLoading(true);
    setError(null);
    api
      .listLibraryAssets(selectedId)
      .then((r) => {
        // 兜底：包内 skill 不进 skill 区（隶属 plugin，随包启停；server 已按
        // 包子树排除，此处对同一响应再滤一层防数据源边界泄漏）
        const roots = (r.plugins ?? []).map((p) => p.relPath);
        const inPack = (rel: string) =>
          roots.some((root) => root === '' || rel === root || rel.startsWith(`${root}/`));
        setSkills(r.skills.filter((s) => !inPack(s.relPath)));
        setFileTemplates(r.files ?? []);
        setMcp(r.mcp ?? []);
        setPlugins(r.plugins ?? []);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [selectedId, scanNonce]);

  // 插件包启用态：选中库/扫描/项目变化即拉（不再绑 plugins tab，避免首帧
  // 「—」；市场包 provenance='market'，按 pack.dir 与 MarketPluginAsset.dirPath 匹配）。
  useEffect(() => {
    api
      .listToolkit(projectId)
      .then((r) => setToolkitPacks(r.packs))
      .catch(() => setToolkitPacks([]));
  }, [projectId, scanNonce, selectedId]);

  /** 批量检查更新：比对市场缓存与 origin，只读不落库。 */
  async function handleCheckUpdates() {
    if (checking) return;
    setChecking(true);
    setError(null);
    try {
      const results = await api.checkMarketUpdates();
      setMarketStatus(new Map(results.map((r) => [r.id, r.status])));
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  }

  /** 一键更新：刷市场缓存（update-available 项）→ syncAll 追平复制型装面 → 重查。 */
  async function handleRefreshAll() {
    const ids = [...marketStatus.entries()]
      .filter(([, s]) => s === 'update-available')
      .map(([id]) => id);
    if (!ids.length || refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      await api.refreshMarketCache(ids);
      await onSyncAll();
      await refreshMarket();
      setScanNonce((n) => n + 1);
      const recheck = await api.checkMarketUpdates(ids);
      setMarketStatus((prev) => {
        const next = new Map(prev);
        for (const r of recheck) next.set(r.id, r.status);
        return next;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  }

  /** 插件包启用/停用（toolkit enable 管线；sourceRoot 消歧扫描根）。 */
  async function togglePluginPack(pack: ToolkitPack, enabled: boolean) {
    if (pluginBusy !== null) return; // Switch 无 disabled，busy 期间防重入
    setPluginBusy(pack.id);
    setError(null);
    try {
      await api.toggleToolkit(projectId, pack.id, enabled, pack.sourceRoot);
      const r = await api.listToolkit(projectId);
      setToolkitPacks(r.packs);
    } catch (e) {
      setError(String(e));
    } finally {
      setPluginBusy(null);
    }
  }

  /** 本地目录引入：每个选中目录复制进市场，随后刷新清单。 */
  async function handlePicked(paths: string[]) {
    let lastId: number | null = null;
    for (const p of paths) {
      try {
        const item = await api.importMarketDir(p);
        lastId = item.id;
      } catch (e) {
        setError(String(e));
      }
    }
    await refreshMarket();
    setScanNonce((n) => n + 1); // 同名覆盖导入后同 id 重扫
    if (lastId !== null) setSelectedId(lastId);
  }

  /** git URL 导入（服务端做协议白名单与 containment）。 */
  async function handleGitImport() {
    const url = gitUrl.trim();
    if (!url || importingGit) return;
    setImportingGit(true);
    setError(null);
    try {
      const item = await api.importMarketGit(url);
      setGitUrl('');
      await refreshMarket();
      setScanNonce((n) => n + 1);
      setSelectedId(item.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setImportingGit(false);
    }
  }

  /** legacy 外部源显式迁入市场（复制 + 改写相对路径）。 */
  function migrateLibrary(id: number) {
    api
      .migrateLibrary(id)
      .then((item) => refreshMarket().then(() => setSelectedId(item.id)))
      .catch((e) => setError(String(e)));
  }

  /** managed → 删市场副本；legacy → 只摘行（外部目录保留）。 */
  function removeItem(item: MarketItem) {
    const req = item.managed ? api.removeMarket(item.id) : api.removeLibrary(item.id);
    req
      .then(() => {
        if (selectedId === item.id) setSelectedId(null);
        return refreshMarket();
      })
      .catch((e) => setError(String(e)));
  }

  // Per-group (skills/ directory) collapse in the Skill templates list.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // 插件包折叠条：**展开集**（默认空 = 全部折叠，key = `plugin:${relPath||name}`；
  // 数据异步到达，展开集比折叠集能保住用户已展开项不因重扫丢失）。
  const [expandedPlugins, setExpandedPlugins] = useState<Set<string>>(new Set());
  const togglePlugin = (key: string) =>
    setExpandedPlugins((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Section-level collapse (Skill templates / MCP templates / Update hints).
  const [sectionsCollapsed, setSectionsCollapsed] = useState<Set<string>>(new Set());
  const toggleSection = (key: string) =>
    setSectionsCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const outdatedSkills = (updates?.skills ?? []).filter((u) => u.outdated);
  const outdatedMcp = (updates?.mcp ?? []).filter((u) => u.outdated);
  const outdatedFiles = (updates?.files ?? []).filter((u) => u.outdated);
  /** 批量检查出的可更新市场资源数（一键更新按钮的启用条件）。 */
  const marketUpdateCount = [...marketStatus.values()].filter(
    (s) => s === 'update-available',
  ).length;

  // The installable list shown depends on the active main category and, on the
  // 资源管理 page, the asset tab: each tab maps 1:1 to its section — skills /
  // MCP / file templates are tab-exclusive (files tab owns the generic
  // single-file templates; plugin section lands with the market plugin area).
  const isFiles = category === 'files';
  const showSkills = isFiles && assetTab === 'skills';
  const showFileTemplates = isFiles && assetTab === 'files';
  const showMcp = isFiles && assetTab === 'mcp';
  const showPlugins = isFiles && assetTab === 'plugins';
  const noTemplates = !showSkills && !showMcp && !showFileTemplates && !showPlugins;

  // Sections and groups that are currently rendered — collapse-all targets.
  const visibleSections = [
    ...(showSkills ? [SECTION_SKILLS] : []),
    ...(showFileTemplates ? [SECTION_FILES] : []),
    ...(showMcp ? [SECTION_MCP] : []),
    ...(showPlugins ? [SECTION_PLUGINS] : []),
    ...(outdatedSkills.length > 0 || outdatedMcp.length > 0 || outdatedFiles.length > 0
      ? [SECTION_UPDATES]
      : []),
  ];
  const groupKeys = groupSkills(skills).map(([g]) => g || '__root__');
  const pluginKeys = plugins.map((pl) => `plugin:${pl.relPath || pl.name}`);
  const anyCollapsed =
    visibleSections.some((k) => sectionsCollapsed.has(k)) ||
    groupKeys.some((k) => collapsedGroups.has(k)) ||
    pluginKeys.some((k) => !expandedPlugins.has(k));
  /** One button that flips between expand-all and collapse-all. */
  function toggleAll() {
    if (anyCollapsed) {
      setSectionsCollapsed(new Set());
      setCollapsedGroups(new Set());
      setExpandedPlugins(new Set(pluginKeys));
    } else {
      setSectionsCollapsed(new Set(visibleSections));
      setCollapsedGroups(new Set(groupKeys));
      setExpandedPlugins(new Set());
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-white/[0.06] space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold text-neutral-400 uppercase">{t('library.heading')}</h2>
          {!noTemplates && (
            <button
              onClick={toggleAll}
              className="ml-auto inline-flex items-center gap-1 rounded-full bg-neutral-800 text-neutral-400 px-1.5 py-0.5 text-[10px] hover:bg-neutral-700"
              title={
                anyCollapsed ? t('library.expandAllTip') : t('library.collapseAllTip')
              }
            >
              {anyCollapsed ? (
                <ChevronsUpDown className="h-2.5 w-2.5" />
              ) : (
                <ChevronsDownUp className="h-2.5 w-2.5" />
              )}
              {anyCollapsed ? t('library.expandAll') : t('library.collapseAll')}
            </button>
          )}
        </div>

        {/* Install-to context (follows the active project/global selection) */}
        <div className="rounded-md border border-white/[0.06] bg-neutral-900/60 p-2 flex items-center gap-2">
          {scope === 'global' ? (
            <Globe className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" />
          )}
          <span className="text-[11px] text-neutral-400">
            {t('library.installTo')}{' '}
            <span className={cn('font-semibold', scope === 'global' ? 'text-emerald-300' : 'text-blue-300')}>
              {scope === 'global' ? t('library.scopeGlobal') : t('library.scopeProject')}
            </span>
          </span>
          <span className="ml-auto text-[11px] text-neutral-600">{t('library.followsSelection')}</span>
        </div>

        {/* 本地目录引入：跨平台目录选择器（复制进市场） */}
        <button
          onClick={() => setPickerOpen(true)}
          className="w-full flex items-center justify-center gap-1.5 rounded bg-neutral-800 px-2 py-1.5 text-xs hover:bg-neutral-700"
          title={t('library.addFoldersTip')}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          {t('library.addFolders')}
        </button>
        {/* git 引入（服务端 URL 白名单 + clone 进市场） */}
        <div className="flex items-center gap-1">
          <input
            value={gitUrl}
            onChange={(e) => setGitUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleGitImport();
            }}
            placeholder={t('library.gitPlaceholder')}
            className="flex-1 min-w-0 bg-neutral-900 rounded px-2 py-1.5 text-xs font-mono"
          />
          <button
            onClick={() => void handleGitImport()}
            disabled={!gitUrl.trim() || importingGit}
            className="shrink-0 inline-flex items-center gap-1 rounded bg-neutral-800 px-2 py-1.5 text-xs hover:bg-neutral-700 disabled:opacity-40"
            title={t('library.importGitTip')}
          >
            <GitBranch className="h-3.5 w-3.5" />
            {importingGit ? t('library.scanning') : t('library.importGit')}
          </button>
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
        {market.length > 0 && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => void handleCheckUpdates()}
              disabled={checking}
              title={t('library.checkUpdatesTip')}
              className="flex-1 inline-flex items-center justify-center gap-1 rounded bg-neutral-800 px-2 py-1.5 text-xs hover:bg-neutral-700 disabled:opacity-40"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
              {checking ? t('library.checking') : t('library.checkUpdates')}
            </button>
            <button
              onClick={() => void handleRefreshAll()}
              disabled={marketUpdateCount === 0 || refreshing}
              title={t('library.refreshUpdatesTip')}
              className="flex-1 inline-flex items-center justify-center gap-1 rounded bg-blue-900/40 text-blue-300 px-2 py-1.5 text-xs hover:bg-blue-900/60 disabled:opacity-40"
            >
              <Download className="h-3.5 w-3.5" />
              {refreshing ? t('library.scanning') : t('library.refreshUpdates')}
              {marketUpdateCount > 0 && (
                <Badge variant="other" className="px-1">
                  {marketUpdateCount}
                </Badge>
              )}
            </button>
          </div>
        )}
        {market.length > 0 && (
          <ul className="space-y-0.5">
            {market.map((item) => (
              <li key={item.id} className="flex items-center gap-1">
                <button
                  onClick={() => setSelectedId(item.id)}
                  className={cn(
                    'flex-1 min-w-0 text-left rounded px-1.5 py-1',
                    selectedId === item.id ? 'bg-neutral-800' : 'hover:bg-neutral-900',
                  )}
                  title={item.path}
                >
                  <span className="flex items-center gap-1 min-w-0">
                    <span className="text-xs truncate">
                      {item.managed && item.resourceId ? item.resourceId : item.path}
                    </span>
                    <MarketSourceBadge source={item.source} />
                    {/* 资产类型 tag（与资源管理文件树同款样式/词表），多个计 ×N */}
                    {item.tags &&
                      BUCKET_ORDER.filter((tag) => item.tags![tag] !== undefined).map((tag) => (
                        <span key={tag} className={cn(ROW_TAG_BASE, kindColor(tag).on)}>
                          {tag}
                          {item.tags![tag]! > 1 && (
                            <span className="ml-1 tabular-nums text-[10px] opacity-70">
                              ×{item.tags![tag]}
                            </span>
                          )}
                        </span>
                      ))}
                  </span>
                  {item.source === 'git' && (item.origin || item.importedAt) && (
                    <span className="block text-[10px] text-neutral-600 truncate">
                      {item.origin}
                      {item.origin && item.importedAt ? ' · ' : ''}
                      {item.importedAt
                        ? t('library.importedAt', { date: item.importedAt.slice(0, 10) })
                        : ''}
                    </span>
                  )}
                </button>
                <MarketStatusBadge status={marketStatus.get(item.id)} />
                {item.legacy && (
                  <button
                    onClick={() => migrateLibrary(item.id)}
                    title={t('library.migrateTip')}
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-amber-300 bg-amber-900/30 hover:bg-amber-900/50"
                  >
                    {t('library.migrate')}
                  </button>
                )}
                <button
                  onClick={() => removeItem(item)}
                  title={
                    item.managed ? t('library.removeMarketTip') : t('library.removeLegacyTip')
                  }
                  className="text-neutral-500 hover:text-red-400 shrink-0"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p className="text-red-400 text-xs px-3 py-1">{error}</p>}

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {noTemplates && (
          <div className="rounded-md border border-dashed border-white/[0.08] bg-neutral-900/40 p-4 text-center">
            <PackageX className="h-5 w-5 mx-auto text-neutral-600 mb-1" />
            <p className="text-xs text-neutral-500">
              {t('library.noTemplates', { name: categoryLabel(category, t) })}
            </p>
            <p className="text-[11px] text-neutral-600 mt-0.5">
              {t('library.noTemplatesHint')}
            </p>
          </div>
        )}

        {/* Skill templates — grouped by their parent skills/ directory */}
        {showSkills && (
          <TemplateSection
            icon={<FileCode className="h-3.5 w-3.5 text-emerald-400" />}
            title={t('library.sectionSkills')}
            hint={t('library.hintDragInstall')}
            count={skills.length}
            open={!sectionsCollapsed.has(SECTION_SKILLS)}
            onToggle={() => toggleSection(SECTION_SKILLS)}
          >
            {loading && <p className="text-xs text-neutral-500">{t('library.scanning')}</p>}
            {!loading && selectedId === null && (
              <p className="text-xs text-neutral-600">{t('library.addLibrarySkills')}</p>
            )}
            {!loading && selectedId !== null && skills.length === 0 && (
              <p className="text-xs text-neutral-600">{t('library.noSkillsFound')}</p>
            )}
            {/* Install-to runtime: Claude (.claude/skills) or Codex (.codex/skills) */}
            <AgentToggle
              agent={installAgent}
              onChange={setInstallAgent}
              kind="skills"
              globalHint={scope === 'global'}
            />
            {groupSkills(skills).map(([group, items]) => {
              const key = group || '__root__';
              const collapsed = collapsedGroups.has(key);
              return (
                <div key={key} className="mb-1">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleGroup(key)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleGroup(key);
                      }
                    }}
                    className="flex items-center gap-1 text-[11px] text-neutral-600 font-mono mb-0.5 cursor-pointer select-none hover:text-neutral-400 rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20"
                    title={group || t('library.rootName')}
                  >
                    {collapsed ? (
                      <ChevronRight className="h-3 w-3 shrink-0" />
                    ) : (
                      <ChevronDown className="h-3 w-3 shrink-0" />
                    )}
                    <Folder className="h-3 w-3 shrink-0 text-emerald-500/60" />
                    <span className="truncate">{group || t('library.rootName')}</span>
                    <Badge variant="skill" className="shrink-0">
                      {t('library.localBadge')}
                    </Badge>
                    <Badge className="shrink-0">{items.length}</Badge>
                  </div>
                  {!collapsed && (
                    <div className="space-y-0.5">
                      {items.map((s) => (
                        <DraggableSkill
                          key={s.name}
                          skill={s}
                          payload={buildDragPayload(
                            {
                              installKind: 'skill',
                              category: 'skill',
                              name: s.name,
                              sourceDir: s.dirPath,
                              targetAgent: installAgent,
                            },
                            capabilities,
                          )}
                          installed={installedSkillNames.has(s.name)}
                          onInstall={() => onInstallSkill(s, scope, installAgent)}
                          installDisabled={!skillVerdict.ok}
                          installReason={reasonTitle(skillVerdict)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </TemplateSection>
        )}

        {/* File templates — commands / agents / workflows / rules / output-styles */}
        {showFileTemplates && (
          <TemplateSection
            icon={<FileCode className="h-3.5 w-3.5 text-blue-400" />}
            title={t('library.sectionFiles')}
            hint={t('library.hintClickInstall')}
            count={fileTemplates.length}
            open={!sectionsCollapsed.has(SECTION_FILES)}
            onToggle={() => toggleSection(SECTION_FILES)}
          >
            {loading && <p className="text-xs text-neutral-500">{t('library.scanning')}</p>}
            {!loading && selectedId === null && (
              <p className="text-xs text-neutral-600">{t('library.addLibraryTemplates')}</p>
            )}
            {!loading && selectedId !== null && fileTemplates.length === 0 && (
              <p className="text-xs text-neutral-600">{t('library.noFileTemplates')}</p>
            )}
            {FILE_ASSET_CATEGORIES.map((cat) => {
              const items = fileTemplates.filter((f) => f.category === cat);
              if (!items.length) return null;
              return (
                <div key={cat} className="mb-1">
                  <div className="flex items-center gap-1 text-[11px] text-neutral-600 font-mono mb-0.5">
                    <Folder className="h-3 w-3 shrink-0 text-emerald-500/60" />
                    <span className="truncate">{cat}</span>
                    <Badge className="shrink-0">{items.length}</Badge>
                  </div>
                  <div className="space-y-0.5">
                    {items.map((f) => {
                      const verdict = canInstall(capabilitiesOf(f.category, capabilities), {
                        scope,
                        agent: 'claude',
                      });
                      return (
                        <DraggableFileRow
                          key={f.filePath}
                          file={f}
                          payload={buildDragPayload(
                            {
                              installKind: 'file',
                              category: f.category,
                              name: f.name,
                              sourceFile: f.filePath,
                              targetAgent: 'claude',
                            },
                            capabilities,
                          )}
                          verdict={verdict}
                          reason={reasonTitle(verdict)}
                          onInstall={() => onInstallFileAsset(f, scope)}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </TemplateSection>
        )}

        {/* MCP templates */}
        {showMcp && (
          <TemplateSection
            icon={<Server className="h-3.5 w-3.5 text-blue-400" />}
            title={t('library.sectionMcp')}
            hint={t('library.hintClickAdd')}
            count={mcp.length}
            open={!sectionsCollapsed.has(SECTION_MCP)}
            onToggle={() => toggleSection(SECTION_MCP)}
          >
            {mcp.length === 0 && (
              <p className="text-xs text-neutral-600">{t('library.noMcpTemplates')}</p>
            )}
            {/* Install-to runtime: Claude (.mcp.json / ~/.claude.json) or Codex (~/.codex/config.toml) */}
            <AgentToggle agent={installAgent} onChange={setInstallAgent} kind="mcp" />
            {mcp.map((srv) => (
              <DraggableMcpRow
                key={srv.name}
                srv={srv}
                payload={buildDragPayload(
                  {
                    installKind: 'mcp',
                    category: 'mcp',
                    name: srv.name,
                    mcpConfig: {
                      command: srv.command,
                      ...(srv.args && { args: srv.args }),
                      ...(srv.env && { env: srv.env }),
                    },
                    targetAgent: installAgent,
                  },
                  capabilities,
                )}
                verdict={mcpVerdict}
                reason={reasonTitle(mcpVerdict)}
                onInstall={() =>
                  onInstallMcp(
                    srv.name,
                    {
                      command: srv.command,
                      ...(srv.args && { args: srv.args }),
                      ...(srv.env && { env: srv.env }),
                    },
                    scope,
                    installAgent,
                  )
                }
              />
            ))}
          </TemplateSection>
        )}

        {/* Plugin packs — CC 原生 / Weave 规则双徽标；启用走 toolkit enable 管线 */}
        {showPlugins && (
          <TemplateSection
            icon={<Puzzle className="h-3.5 w-3.5 text-violet-400" />}
            title={t('library.sectionPlugins')}
            hint={t('library.pluginsSectionHint')}
            count={plugins.length}
            open={!sectionsCollapsed.has(SECTION_PLUGINS)}
            onToggle={() => toggleSection(SECTION_PLUGINS)}
          >
            {loading && <p className="text-xs text-neutral-500">{t('library.scanning')}</p>}
            {!loading && selectedId === null && (
              <p className="text-xs text-neutral-600">{t('library.addLibraryPlugins')}</p>
            )}
            {!loading && selectedId !== null && plugins.length === 0 && (
              <p className="text-xs text-neutral-600">{t('library.noPlugins')}</p>
            )}
            {plugins.map((pl) => {
              const pack =
                toolkitPacks?.find((p) => normPath(p.dir) === normPath(pl.dirPath)) ?? null;
              const pk = `plugin:${pl.relPath || pl.name}`;
              const expanded = expandedPlugins.has(pk);
              return (
                <div
                  key={pk}
                  className="rounded-md border border-white/[0.06] bg-white/[0.015] px-2 py-1.5 space-y-1"
                >
                  {/* 折叠条头：点击切换展开；Switch/「—」stopPropagation 防误展开 */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => togglePlugin(pk)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        togglePlugin(pk);
                      }
                    }}
                    className="flex items-center gap-1.5 cursor-pointer select-none rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20"
                  >
                    {expanded ? (
                      <ChevronDown className="h-3 w-3 shrink-0 text-neutral-600" />
                    ) : (
                      <ChevronRight className="h-3 w-3 shrink-0 text-neutral-600" />
                    )}
                    <Puzzle
                      className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        pack?.enabled ? 'text-violet-400' : 'text-neutral-600',
                      )}
                    />
                    <span className="min-w-0 truncate text-xs font-medium text-neutral-200">
                      {pl.name}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-neutral-500">
                      v{pl.version}
                    </span>
                    {/* mods 按 CC 插件管线安装（toolkit isCcPluginPack），徽标同口径 */}
                    {(pl.ccPack || pl.kind === 'mod') && (
                      <span className="shrink-0" title={t('library.ccPluginTip')}>
                        <Badge className="bg-blue-900/40 text-blue-300">
                          {t('library.badgeCcPlugin')}
                        </Badge>
                      </span>
                    )}
                    {pl.weavePack && (
                      <span className="shrink-0" title={t('library.weavePluginTip')}>
                        <Badge className="bg-violet-900/40 text-violet-300">
                          {t('library.badgeWeavePlugin')}
                        </Badge>
                      </span>
                    )}
                    <Badge className={cn('shrink-0', KIND_STYLES[pl.kind])}>
                      {t(KIND_KEY[pl.kind])}
                    </Badge>
                    <span className="shrink-0 text-[10px] text-neutral-600">
                      {t('toolkit.targets', { targets: pl.targets.join('+') })}
                    </span>
                    <span
                      className="ml-auto shrink-0"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      {/* 市场 = 安装入口：weave 规则包无安装概念保留启用 Switch；
                          其余未装 → 「安装」，已装 → 徽标（启停/卸载去资源管理·工具箱） */}
                      {pack ? (
                        pl.weavePack && !(pl.ccPack || pl.kind === 'mod') ? (
                          <Switch
                            checked={pack.enabled}
                            onChange={(v) => void togglePluginPack(pack, v)}
                            title={t('library.weavePluginTip')}
                          />
                        ) : pack.installed ? (
                          <Badge
                            className="bg-emerald-900/40 text-emerald-300"
                            title={t('library.installedManageTip')}
                          >
                            {t('library.installed')} ✓
                          </Badge>
                        ) : (
                          <button
                            type="button"
                            disabled={pluginBusy !== null}
                            title={t('library.installPackTip')}
                            onClick={() => void togglePluginPack(pack, true)}
                            className="rounded bg-blue-900/50 px-2 py-0.5 text-[10px] text-blue-200 hover:bg-blue-800/60 disabled:opacity-40"
                          >
                            {t('library.install')}
                          </button>
                        )
                      ) : (
                        <span
                          className="text-[10px] text-neutral-600"
                          title={t('library.pluginNotInToolkit')}
                        >
                          —
                        </span>
                      )}
                    </span>
                  </div>
                  {/* 展开体：描述 → 成分 → 包内 skills（随包启停）→ 来源目录 */}
                  {expanded && (
                    <div className="pl-4 space-y-1">
                      {pl.description ? (
                        <p className="text-[11px] text-neutral-500" title={pl.description}>
                          {pl.description}
                        </p>
                      ) : null}
                      <div className="flex flex-wrap items-center gap-1">
                        {pl.components.map((c) => (
                          <Badge key={c} variant="other" className="px-1 text-[10px]">
                            {c}
                          </Badge>
                        ))}
                      </div>
                      {pl.skills.length > 0 && (
                        <div>
                          <p
                            className="mb-0.5 text-[10px] text-neutral-600"
                            title={t('library.pluginSkillsFollowTip')}
                          >
                            {t('library.pluginSkillsLabel')}
                          </p>
                          <div className="flex flex-wrap gap-1">
                            {pl.skills.map((sname) => (
                              <Badge
                                key={sname}
                                variant="skill"
                                className="px-1.5 text-[10px]"
                                title={t('library.pluginSkillsFollowTip')}
                              >
                                {sname}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                      <p className="text-[10px] text-neutral-600">
                        <span className="text-neutral-500">
                          {t('library.pluginSourceDir')}
                        </span>{' '}
                        <span className="font-mono" title={pl.dirPath}>
                          {pl.relPath || '.'}
                        </span>
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </TemplateSection>
        )}

        {/* Update hints */}
        {(outdatedSkills.length > 0 || outdatedMcp.length > 0 || outdatedFiles.length > 0) && (
          <TemplateSection
            icon={<RefreshCw className="h-3.5 w-3.5 text-orange-400" />}
            title={t('library.sectionUpdates')}
            hint={t('library.hintOverwrite')}
            count={outdatedSkills.length + outdatedMcp.length + outdatedFiles.length}
            open={!sectionsCollapsed.has(SECTION_UPDATES)}
            onToggle={() => toggleSection(SECTION_UPDATES)}
          >
            {outdatedSkills.map((u) => (
              <UpdateHintRow
                key={`skill-${u.agent ?? 'claude'}-${u.scope}-${u.name}`}
                label={u.name}
                scope={u.scope}
                agent={u.agent}
                onUpdate={() => onUpdateAsset('skill', u.name, u.scope, u.agent)}
              />
            ))}
            {outdatedFiles.map((u) => (
              <UpdateHintRow
                key={`file-${u.category}-${u.name}`}
                label={`${u.category}/${u.name}`}
                scope={u.scope}
                onUpdate={() => onUpdateAsset(u.category, u.name, u.scope)}
              />
            ))}
            {outdatedMcp.map((u) => (
              <UpdateHintRow
                key={`mcp-${u.agent ?? 'claude'}-${u.scope}-${u.name}`}
                label={u.name}
                scope={u.scope}
                agent={u.agent}
                onUpdate={() => onUpdateAsset('mcp', u.name, u.scope, u.agent)}
              />
            ))}
          </TemplateSection>
        )}
      </div>

      {showMcp && (
        <McpForm
          onInstall={(name, config) => onInstallMcp(name, config, scope, installAgent)}
          blockedTitle={reasonTitle(mcpVerdict)}
        />
      )}
    </div>
  );
}

function categoryLabel(category: MainCategory, t: TFunc): string {
  switch (category) {
    case 'files':
      return t('catbar.files');
    case 'personalization':
      return t('library.catPersonalization');
    case 'weave':
      return t('catbar.hooks');
    case 'tasks':
      return t('catbar.tasks');
  }
}

/** 市场行来源徽标：git 导入 / 本地目录导入 / legacy 外部源。 */
function MarketSourceBadge({ source }: { source: MarketItem['source'] }) {
  const t = useT();
  const cfg = {
    git: { label: t('library.badgeGit'), variant: 'command' },
    dir: { label: t('library.badgeDir'), variant: 'skill' },
    legacy: { label: t('library.badgeExternal'), variant: 'other' },
  }[source];
  return (
    <Badge variant={cfg.variant} className="shrink-0 px-1.5 text-[10px]">
      {cfg.label}
    </Badge>
  );
}

/** Collapse-state keys for the template sections. */
const SECTION_SKILLS = 'skill-templates';
const SECTION_FILES = 'file-templates';
const SECTION_MCP = 'mcp-templates';
const SECTION_PLUGINS = 'plugin-packs';
const SECTION_UPDATES = 'update-hints';

/** 市场行更新检查状态徽标（批量检查更新后显示）。 */
function MarketStatusBadge({ status }: { status?: MarketUpdateStatus }) {
  const t = useT();
  if (!status) return null;
  const cfg = {
    uptodate: { label: t('library.statusUptodate'), cls: 'text-emerald-300 bg-emerald-900/30' },
    'update-available': {
      label: t('library.statusUpdateAvailable'),
      cls: 'text-orange-300 bg-orange-900/30',
    },
    'origin-missing': {
      label: t('library.statusOriginMissing'),
      cls: 'text-amber-300 bg-amber-900/30',
    },
    unknown: { label: t('library.statusUnknown'), cls: 'text-neutral-400 bg-neutral-800' },
  }[status];
  return (
    <Badge className={cn('shrink-0 px-1.5 text-[10px]', cfg.cls)}>{cfg.label}</Badge>
  );
}

/**
 * Group skills by their parent `skills/` directory so a library with multiple
 * folders (e.g. `lib/coding/skills/review` + `lib/writing/skills/docs`) shows
 * each skills directory as a headed block with its peers as a row. Empty group
 * (skill directly under the library root) sorts last.
 */
function groupSkills(skills: SkillAsset[]): [string, SkillAsset[]][] {
  const m = new Map<string, SkillAsset[]>();
  for (const s of skills) {
    const list = m.get(s.group) ?? [];
    list.push(s);
    m.set(s.group, list);
  }
  return [...m.entries()].sort((a, b) => {
    if (!a[0]) return 1;
    if (!b[0]) return -1;
    return a[0].localeCompare(b[0]);
  });
}

/** Claude / Codex install-target toggle shared by the skill and MCP template
 * sections. Tooltips and the destination hint differ per kind. */
function AgentToggle({
  agent,
  onChange,
  kind,
  globalHint,
}: {
  agent: AssetAgent;
  onChange: (a: AssetAgent) => void;
  kind: 'skills' | 'mcp';
  /** skills only: show the ~/.codex path hint in global scope. */
  globalHint?: boolean;
}) {
  const t = useT();
  const tips =
    kind === 'skills'
      ? {
          claude: t('library.tipSkillsClaude'),
          codex: t('library.tipSkillsCodex'),
        }
      : {
          claude: t('library.tipMcpClaude'),
          codex: t('library.tipMcpCodex'),
        };
  return (
    <div className="flex items-center gap-1 mb-1">
      <span className="text-[11px] text-neutral-500 shrink-0">{t('library.installTarget')}</span>
      {(['claude', 'codex'] as const).map((a) => (
        <button
          key={a}
          onClick={() => onChange(a)}
          className={cn(
            'rounded px-1.5 py-0.5 text-[11px]',
            agent === a
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-500 hover:text-neutral-300',
          )}
          title={tips[a]}
        >
          {a === 'claude' ? 'Claude' : 'Codex'}
        </button>
      ))}
      {agent === 'codex' && (
        <span className="text-[10px] text-neutral-600">
          {kind === 'skills'
            ? globalHint
              ? '→ ~/.agents/skills/'
              : '→ .codex/skills/'
            : t('library.codexMcpPathHint')}
        </span>
      )}
    </div>
  );
}

function TemplateSection({
  icon,
  title,
  hint,
  count,
  open,
  onToggle,
  children,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  /** Item count shown as a tag (stays visible when collapsed). */
  count?: number;
  /** Controlled collapse state (lifted so expand/collapse-all can drive it). */
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <section>
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
        className="flex items-center gap-1.5 mb-1.5 cursor-pointer select-none rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20"
        title={open ? t('common.collapse') : t('common.expand')}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 text-neutral-500" />
        ) : (
          <ChevronRight className="h-3 w-3 text-neutral-500" />
        )}
        {icon}
        <span className="text-xs font-semibold text-neutral-300">{title}</span>
        {count !== undefined && <Badge variant="other">{count}</Badge>}
        <span className="text-[11px] text-neutral-500 ml-auto">{hint}</span>
      </div>
      {open && <div className="space-y-0.5">{children}</div>}
    </section>
  );
}

function UpdateHintRow({
  label,
  scope,
  agent,
  onUpdate,
}: {
  label: string;
  scope: AssetScope;
  agent?: AssetAgent;
  onUpdate: () => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-neutral-900">
      <RefreshCw className="h-3 w-3 shrink-0 text-orange-400" />
      <span className="truncate">{label}</span>
      {agent === 'codex' && (
        <Badge variant="other" className="shrink-0">
          Codex
        </Badge>
      )}
      <Badge variant="skill" className="shrink-0">
        {scope}
      </Badge>
      <button
        onClick={onUpdate}
        className="ml-auto text-xs text-blue-400 hover:text-blue-300 shrink-0"
      >
        {t('library.update')}
      </button>
    </div>
  );
}

function DraggableSkill({
  skill,
  payload,
  installed,
  onInstall,
  installDisabled,
  installReason,
}: {
  skill: SkillAsset;
  /** Unified drag payload (attrs via capabilitiesOf — built by the caller). */
  payload: DragPayload;
  installed: boolean;
  onInstall: () => void;
  /** 点击安装前置禁用（capabilities 谓词；拖拽判定见 App onDragEnd guard）。 */
  installDisabled?: boolean;
  installReason?: string;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `lib-skill-${skill.name}`,
    data: payload,
  });
  const t = useT();
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        'flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm cursor-grab transition-colors duration-200',
        isDragging && 'opacity-40',
        'hover:bg-neutral-800/50',
      )}
      title={skill.dirPath}
    >
      <GripVertical className="h-3 w-3 shrink-0 text-neutral-600" />
      <span className="truncate">{skill.name}</span>
      {installed ? (
        <Badge variant="skill" className="ml-auto">
          {t('library.installed')}
        </Badge>
      ) : (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onInstall();
          }}
          disabled={installDisabled}
          title={installReason}
          className="ml-auto text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-blue-400"
        >
          {t('library.install')}
        </button>
      )}
    </div>
  );
}

/** 文件模板行：可拖（payload 携 attrs）+ 点击安装同谓词禁用。 */
function DraggableFileRow({
  file,
  payload,
  verdict,
  reason,
  onInstall,
}: {
  file: FileAssetTemplate;
  payload: DragPayload;
  verdict: InstallVerdict;
  reason?: string;
  onInstall: () => void;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `lib-file-${file.filePath}`,
    data: payload,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        'flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-neutral-900 cursor-grab transition-colors duration-200',
        isDragging && 'opacity-40',
      )}
      title={file.filePath}
    >
      <FileCode className="h-3 w-3 shrink-0 text-blue-400" />
      <span className="truncate">{file.name}</span>
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onInstall();
        }}
        disabled={!verdict.ok}
        title={reason}
        className="ml-auto text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-blue-400"
      >
        {t('library.install')}
      </button>
    </div>
  );
}

/** MCP 模板行：可拖（payload 带 mcpConfig）+ 点击安装同谓词禁用。 */
function DraggableMcpRow({
  srv,
  payload,
  verdict,
  reason,
  onInstall,
}: {
  srv: McpTemplate;
  payload: DragPayload;
  verdict: InstallVerdict;
  reason?: string;
  onInstall: () => void;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `lib-mcp-${srv.name}`,
    data: payload,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        'flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-neutral-900 cursor-grab transition-colors duration-200',
        isDragging && 'opacity-40',
      )}
      title={srv.sourcePath}
    >
      <Server className="h-3 w-3 shrink-0 text-blue-400" />
      <span className="truncate">{srv.name}</span>
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onInstall();
        }}
        disabled={!verdict.ok}
        title={reason}
        className="ml-auto text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-blue-400"
      >
        {t('library.install')}
      </button>
    </div>
  );
}

function McpForm({
  onInstall,
  blockedTitle,
}: {
  onInstall: (name: string, config: McpServerConfig) => void;
  /** capabilities 谓词拒绝时的原因文案（非空 = 表单提交禁用）。 */
  blockedTitle?: string;
}) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const t = useT();

  function submit() {
    if (blockedTitle) return;
    if (!name.trim() || !command.trim()) return;
    const argList = args.trim() ? args.trim().split(/\s+/) : undefined;
    const envMap = parseEnv(env);
    onInstall(name.trim(), {
      command: command.trim(),
      ...(argList && { args: argList }),
      ...(envMap && { env: envMap }),
    });
    setName('');
    setCommand('');
    setArgs('');
    setEnv('');
  }

  return (
    <div className="border-t border-white/[0.06] p-3 space-y-1.5">
      <h3 className="text-xs font-semibold text-neutral-400 uppercase flex items-center gap-1">
        <Server className="h-3 w-3" /> {t('library.addMcpServer')}
      </h3>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('library.mcpNamePlaceholder')}
        className="w-full bg-neutral-900 rounded px-2 py-1 text-xs font-mono"
      />
      <input
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        placeholder={t('library.mcpCommandPlaceholder')}
        className="w-full bg-neutral-900 rounded px-2 py-1 text-xs font-mono"
      />
      <input
        value={args}
        onChange={(e) => setArgs(e.target.value)}
        placeholder={t('library.mcpArgsPlaceholder')}
        className="w-full bg-neutral-900 rounded px-2 py-1 text-xs font-mono"
      />
      <textarea
        value={env}
        onChange={(e) => setEnv(e.target.value)}
        placeholder={t('library.mcpEnvPlaceholder')}
        rows={2}
        className="w-full bg-neutral-900 rounded px-2 py-1 text-xs font-mono"
      />
      <button
        onClick={submit}
        disabled={!name.trim() || !command.trim() || !!blockedTitle}
        title={blockedTitle}
        className="w-full rounded bg-blue-900/40 text-blue-300 py-1 text-xs disabled:opacity-40"
      >
        {t('library.addMcpServer')}
      </button>
    </div>
  );
}

function parseEnv(text: string): Record<string, string> | undefined {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return undefined;
  const obj: Record<string, string> = {};
  for (const line of lines) {
    const i = line.indexOf('=');
    if (i > 0) obj[line.slice(0, i)] = line.slice(i + 1);
  }
  return Object.keys(obj).length ? obj : undefined;
}
