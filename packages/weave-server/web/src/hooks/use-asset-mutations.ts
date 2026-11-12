import { useCallback, useState } from 'react';
import {
  api,
  type AssetAgent,
  type AssetScope,
  type FileAssetTemplate,
  type MarketPluginAsset,
  type McpServerConfig,
  type ProjectRow,
  type SkillAsset,
  type PluginRow,
  type PluginRuntime,
  type InstallCapabilities,
} from '@/lib/api';
import { capabilitiesOf } from '@/lib/install-capabilities';
import { HARNESS_ORDER } from '@/lib/harness-meta';
import type { EnableOverride, ToolScope } from '@weavecode/core/tool';
import { useToast } from '@/components/Toast';
import { errorText } from '@/lib/action-feedback';
import { useT } from '@/i18n/I18nProvider';

/** 生效查表（链解析在服务端，前端只读行上的 effective）。 */
export const pluginEffective = (rows: readonly PluginRow[], runtime: PluginRuntime, key: string): boolean =>
  rows.some((r) => r.harness === runtime && r.key === key && r.effective);

interface AssetMutationsDeps {
  t: ReturnType<typeof useT>;
  show: ReturnType<typeof useToast>['show'];
  selected: ProjectRow | null;
  projects: ProjectRow[];
  globalMode: boolean;
  installCaps: InstallCapabilities | null;
  refreshAssets: (p: ProjectRow) => void;
  refreshMcp: (projectId: number) => void;
  refreshGlobalSkills: (projectId: number) => void;
  refreshPluginRows: (projectId: number) => void;
  refreshUpdates: (projectId: number) => void;
  ensureUpdates: (projectId: number, force?: boolean) => void;
}

/**
 * 资产装卸 handler 域：skill/文件资产/MCP/插件的安装、卸载、启停、全量同步。
 * 安装/卸载 handler 失败必抛（同 handleSyncAll）：文案归调用方的 fb.run——
 * handler 内先报错又正常 resolve 的话，调用方会在失败时也弹成功。
 */
export function useAssetMutations(deps: AssetMutationsDeps) {
  const {
    t, show, selected, projects, globalMode, installCaps,
    refreshAssets, refreshMcp, refreshGlobalSkills, refreshPluginRows, refreshUpdates, ensureUpdates,
  } = deps;

  // 安装属性矩阵（静态）：启动拉一次，下发市场弹层（目标选择器 canInstall 也用）。
  const [installCapsState, setInstallCapsState] = useState<InstallCapabilities | null>(null);

  /** 单装裸调用：只发请求不刷新。`target` 显式传入（市场弹层选定的落点，
   *  null = 全局 user 档）；缺省 = 现行为（锚定项目）。 */
  const installSkillRaw = useCallback(
    async (skill: SkillAsset, scope: AssetScope, agent: AssetAgent, target?: ProjectRow | null) => {
      const dest = target !== undefined ? target : selected ?? projects[0];
      if (target === undefined && !selected && !globalMode) return null;
      // user 档落在 home 下、与项目无关：无项目落点也照装（id 只是路由占位）。
      if (!dest && scope !== 'user') return null;
      const projectId = dest?.id ?? 0;
      const res = await api.install(projectId, {
        category: 'skill',
        name: skill.name,
        sourceDir: skill.dirPath,
        scope,
        agent,
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return { target: dest, projectId };
    },
    [selected, projects, globalMode],
  );

  const refreshAfterInstall = useCallback(
    (target: ProjectRow | null | undefined, projectId: number) => {
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
      target?: ProjectRow | null,
    ) => {
      const r = await installSkillRaw(skill, scope, agent, target);
      if (r) refreshAfterInstall(r.target, r.projectId);
    },
    [installSkillRaw, refreshAfterInstall],
  );

  /** Install a single-file asset (command / agent / workflow / rule / output-style). */
  const handleInstallFileAsset = useCallback(
    async (file: FileAssetTemplate, scope: AssetScope = 'project', target?: ProjectRow | null) => {
      const dest = target !== undefined ? target : selected ?? projects[0];
      if (target === undefined && !selected && !globalMode) return;
      if (!dest && scope !== 'user') return;
      const projectId = dest?.id ?? 0;
      const res = await api.install(projectId, {
        category: file.category,
        name: file.name,
        sourceFile: file.filePath,
        scope,
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      if (dest) refreshAssets(dest);
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
      target?: ProjectRow | null,
    ) => {
      const dest = target !== undefined ? target : selected ?? projects[0];
      if (target === undefined && !selected && !globalMode) return;
      // 卡面规则与视图同源（CategoryDetail rowsFor）：该 harness 的 MCP 面含
      // 当前 scope → 用之；否则回落首档（codex 无 project 档 → user）。
      // 判据出自安装属性矩阵，不再点名 harness（§4 收编）。
      const caps = installCaps ?? installCapsState;
      const mcpScopes =
        capabilitiesOf('mcp', caps).surfaces.find((s) => s.harness === agent)?.scopes ?? [];
      const effectiveScope = mcpScopes.includes(scope) ? scope : mcpScopes[0] ?? 'user';
      if (!dest && effectiveScope !== 'user') return;
      const projectId = dest?.id ?? 0;
      const res = await api.install(projectId, {
        category: 'mcp',
        name,
        mcpConfig: config,
        scope: effectiveScope,
        agent,
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      if (dest) refreshAssets(dest);
      refreshMcp(projectId);
      refreshUpdates(projectId);
    },
    [selected, projects, globalMode, installCaps, installCapsState, refreshAssets, refreshMcp, refreshUpdates],
  );

  /** 市场插件包安装 = toolkit enable（恒项目落点；CC 包全局安装随 enable 发生）：
   *  按 dir 匹配 toolkit 行，找不到 = 扫描没发现该包（刷新源后重试）。 */
  const handleInstallPlugin = useCallback(
    async (plugin: MarketPluginAsset, target: ProjectRow) => {
      const norm = (p: string) => p.replace(/\\/g, '/');
      const { packs } = await api.listToolkit(target.id);
      const pack = packs.find((p) => norm(p.dir) === norm(plugin.dirPath));
      if (!pack) throw new Error(t('market.packNotFound', { name: plugin.name }));
      const result = await api.toggleToolkit(target.id, pack.id, true, pack.sourceRoot);
      if (result.warnings.length > 0) show('info', result.warnings.join('；'));
      refreshPluginRows(target.id);
      refreshGlobalSkills(target.id);
    },
    [t, show, refreshPluginRows, refreshGlobalSkills],
  );

  /** 市场插件包卸载（胶囊「灭」向）= toolkit uninstall：与 handleInstallPlugin
   *  同一 dir 匹配；找不到 = 扫描没发现该包（刷新源后重试）。 */
  const handleUninstallPluginMarket = useCallback(
    async (plugin: MarketPluginAsset, target: ProjectRow) => {
      const norm = (p: string) => p.replace(/\\/g, '/');
      const { packs } = await api.listToolkit(target.id);
      const pack = packs.find((p) => norm(p.dir) === norm(plugin.dirPath));
      if (!pack) throw new Error(t('market.packNotFound', { name: plugin.name }));
      const result = await api.uninstallToolkit(target.id, pack.id, pack.sourceRoot);
      if (result.warnings.length > 0) show('info', result.warnings.join('；'));
      refreshPluginRows(target.id);
      refreshGlobalSkills(target.id);
    },
    [t, show, refreshPluginRows, refreshGlobalSkills],
  );

  const handleUninstallSkill = useCallback(
    async (name: string, scope: AssetScope = 'project', agent?: AssetAgent, target?: ProjectRow | null) => {
      const dest = target !== undefined ? target : selected ?? projects[0];
      // user 档落在 home 下、与项目无关：全局面没有项目也照卸（id 只是路由占位）。
      if (!dest && !(globalMode && scope === 'user')) return;
      const projectId = dest?.id ?? 0;
      const res = await api.uninstall(projectId, {
        category: 'skill',
        name,
        scope,
        ...(agent ? { agent } : {}),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      if (dest) refreshAssets(dest);
      refreshGlobalSkills(projectId);
      refreshUpdates(projectId);
    },
    [selected, projects, globalMode, refreshAssets, refreshGlobalSkills, refreshUpdates],
  );

  /** 文件类资产卸载（市场胶囊的「灭」向；资源管理树以插件包为准不再给入口，
   *  但服务端 POST /projects/:id/uninstall 仍在——这里只恢复调用面）。 */
  const handleUninstallFileAsset = useCallback(
    async (file: FileAssetTemplate, scope: AssetScope = 'project', target?: ProjectRow | null) => {
      const dest = target !== undefined ? target : selected ?? projects[0];
      if (!dest && !(globalMode && scope === 'user')) return;
      const projectId = dest?.id ?? 0;
      const res = await api.uninstall(projectId, {
        category: file.category,
        name: file.name,
        scope,
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      if (dest) refreshAssets(dest);
      refreshUpdates(projectId);
    },
    [selected, projects, globalMode, refreshAssets, refreshUpdates],
  );

  const handleUninstallMcp = useCallback(
    async (name: string, scope: AssetScope = 'project', agent?: AssetAgent, target?: ProjectRow | null) => {
      const dest = target !== undefined ? target : selected ?? projects[0];
      // claude 以外 harness 的 MCP 住用户级文件——卸载恒指用户级（同安装侧判定）。
      const effectiveScope: AssetScope = (agent ?? HARNESS_ORDER[0]) === 'claude' ? scope : 'user';
      // 同上：用户级装卸与项目无关，没有项目时 0 号只是形状上的占位。
      if (!dest && !(globalMode && effectiveScope === 'user')) return;
      const projectId = dest?.id ?? 0;
      const res = await api.uninstall(projectId, {
        category: 'mcp',
        name,
        scope: effectiveScope,
        ...(agent ? { agent } : {}),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      if (dest) refreshAssets(dest);
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

  // 说明：单项资产更新（市场模板 → 已装副本）的入口随 LibraryPanel 删除一并撤下
  // （主区顶栏「立即同步」仍整批更新）；服务端 POST /projects/:id/update-asset 仍在，
  // 日后要恢复入口只需再加回一个 handler。

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

  // 直连 fire-and-forget 调用点（抽屉卸载）没有按钮本体可挂三态反馈，就地兜
  // 一条错误 toast：失败必有一条提示、也不产生 unhandled rejection；成功维持
  // 无 toast（由 SSE 刷新与 ✓ 标呈现）。
  const uninstallSkillSafely = useCallback(
    (name: string, scope: AssetScope, agent?: AssetAgent) => {
      void handleUninstallSkill(name, scope, agent).catch((e) =>
        show('error', t('errors.uninstallFailed', { error: errorText(e) })),
      );
    },
    [handleUninstallSkill, show, t],
  );

  return {
    installCapsState, setInstallCapsState,
    handleInstallSkill, handleInstallFileAsset, handleInstallMcp, handleInstallPlugin,
    handleUninstallSkill, handleUninstallFileAsset, handleUninstallMcp, handleUninstallPluginMarket,
    handleCycleMcpEnable,
    handleSyncAll, handleCyclePluginState, handleUninstallPlugin,
    uninstallSkillSafely,
    pluginEffective,
  };
}
