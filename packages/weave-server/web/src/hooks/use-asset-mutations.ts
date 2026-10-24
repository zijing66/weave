import { useCallback, useState } from 'react';
import {
  api,
  type AssetAgent,
  type AssetScope,
  type FileAssetCategory,
  type FileAssetTemplate,
  type McpServerConfig,
  type ProjectRow,
  type SkillAsset,
  type PluginRow,
  type PluginRuntime,
  type InstallCapabilities,
} from '@/lib/api';
import { canInstall, capabilitiesOf, type DragPayload } from '@/lib/install-capabilities';
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
 * 资产装卸 handler 域：skill/文件资产/MCP/插件的安装、卸载、启停、单项更新、
 * 全量同步。安装/卸载/更新 handler 失败必抛（同 handleSyncAll）：文案归调用方的
 * fb.run / 兜底 catch——handler 内先报错又正常 resolve 的话，调用方会在失败时也弹成功。
 * 直连 fire-and-forget 调用点（拖拽落定 / 库面板安装·更新 / 抽屉卸载）没有按钮本体
 * 可挂三态反馈，就地兜一条错误 toast：失败必有一条提示、也不产生 unhandled rejection。
 */
export function useAssetMutations(deps: AssetMutationsDeps) {
  const {
    t, show, selected, projects, globalMode, installCaps,
    refreshAssets, refreshMcp, refreshGlobalSkills, refreshPluginRows, refreshUpdates, ensureUpdates,
  } = deps;

  // 安装属性矩阵（静态）：启动拉一次，下发 LibraryPanel（M6 拖拽 canDrop 也用）。
  const [installCapsState, setInstallCapsState] = useState<InstallCapabilities | null>(null);
  // 拖拽中的统一 payload（onDragStart 提升）：落点 canInstall 判定与落定分派共用。
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);

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
      const caps = installCaps ?? installCapsState;
      const mcpScopes =
        capabilitiesOf('mcp', caps).surfaces.find((s) => s.harness === agent)?.scopes ?? [];
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
    [selected, projects, globalMode, installCaps, installCapsState, refreshAssets, refreshMcp, refreshUpdates],
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

  /** 拖拽落定分派：属性判定单点（canInstall），不合法 → 顶栏报因、不安装。 */
  const dispatchDrop = useCallback(
    (data: DragPayload, scope: AssetScope, onInvalid: (reasonKey: string) => void): void => {
      const verdict = canInstall(data.attrs, { scope, agent: data.targetAgent });
      if (!verdict.ok) {
        if (verdict.reasonKey) onInvalid(verdict.reasonKey);
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
    },
    [installSkillSafely, installFileAssetSafely, installMcpSafely],
  );

  return {
    installCapsState, setInstallCapsState,
    dragPayload, setDragPayload,
    handleInstallSkill, handleInstallSkillsBatch, handleInstallFileAsset, handleInstallMcp,
    handleUninstallSkill, handleUninstallMcp, handleCycleMcpEnable,
    handleSyncAll, handleUpdateAsset, handleCyclePluginState, handleUninstallPlugin,
    installSkillSafely, installFileAssetSafely, installMcpSafely, installBuiltinMcpSafely,
    updateAssetSafely, uninstallSkillSafely,
    dispatchDrop,
    pluginEffective,
  };
}
