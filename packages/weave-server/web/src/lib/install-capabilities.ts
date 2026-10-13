/**
 * 安装属性谓词单点（批 M5）：全 web 只有本模块读 capabilities 原始表。
 * 组件一律经 `capabilitiesOf()` 取 InstallAttrs（品牌位阻止字面构造），
 * 点击安装 disabled 与拖拽 canDrop 共用 `canInstall`——零第二份属性硬编码。
 */
import type { MessageKey } from '@/i18n/dict';
import { HARNESS_ORDER } from './harness-meta';
import {
  FILE_ASSET_CATEGORIES,
  type AssetScope,
  type AssetAgent,
  type FileAssetCategory,
  type InstallCapabilities,
  type InstallCategory,
  type McpServerConfig,
} from './api';

export type { InstallCategory };

declare const attrsBrand: unique symbol;

/** 某类别在各 harness 面的安装范围（唯一构造点 = capabilitiesOf）。 */
export interface InstallAttrs {
  readonly [attrsBrand]: true;
  surfaces: Array<{
    harness: AssetAgent;
    scopes: AssetScope[];
    dest?: Partial<Record<AssetScope, string>>;
  }>;
}

export interface InstallVerdict {
  ok: boolean;
  /** 拒绝原因词条（ok 时 null）；拖拽提示与按钮 title 共用。 */
  reasonKey: MessageKey | null;
}

/**
 * 取类别的安装属性。`table` = App 启动拉取的 GET /capabilities 响应；
 * 未加载时回落全放行（= capabilities 出网前的存量行为，服务端硬校验兜底）。
 */
export function capabilitiesOf(
  category: InstallCategory,
  table?: InstallCapabilities | null,
): InstallAttrs {
  const entry = table?.categories[category];
  const surfaces: InstallAttrs['surfaces'] =
    entry?.surfaces ??
    (HARNESS_ORDER.map(
      (harness) => ({ harness, scopes: ['project', 'user'] as AssetScope[] }),
    ) as InstallAttrs['surfaces']);
  return { surfaces } as InstallAttrs;
}

/** harness → 资源不支持它时的拒绝词条（claude/codex 保留专属文案；其余走通用键）。 */
const UNSUPPORTED_REASON: Record<string, MessageKey> = {
  claude: 'capability.reason.codexOnly',
  codex: 'capability.reason.claudeOnly',
};

/** 唯一判定：harness 面缺失 → 资源不支持目标 harness；面在但 scope 缺 → 范围拒。 */
export function canInstall(
  attrs: InstallAttrs,
  ctx: { scope: AssetScope; agent: AssetAgent },
): InstallVerdict {
  const surface = attrs.surfaces.find((s) => s.harness === ctx.agent);
  if (!surface) {
    return {
      ok: false,
      reasonKey:
        UNSUPPORTED_REASON[ctx.agent] ?? 'capability.reason.harnessUnsupported',
    };
  }
  if (!surface.scopes.includes(ctx.scope)) {
    return {
      ok: false,
      reasonKey:
        ctx.scope === 'user' ? 'capability.reason.projectOnly' : 'capability.reason.globalOnly',
    };
  }
  return { ok: true, reasonKey: null };
}

/** 卸载门控（§6-4 收编）：与安装共用同一矩阵——harness 在该 scope 有面才可卸
 *  （服务端 uninstall 本就按面抛错，这里只是让 UI 提前说真话）。非单文件资产
 *  类别（树里的 settings/hooks 等只读行）→ 恒 false。 */
export function canUninstall(
  category: string,
  agent: AssetAgent,
  scope: AssetScope,
  table?: InstallCapabilities | null,
): boolean {
  if (!FILE_ASSET_CATEGORIES.includes(category as FileAssetCategory)) return false;
  return canInstall(capabilitiesOf(category as FileAssetCategory, table), { scope, agent }).ok;
}

/** 统一拖拽 payload：拖源封装、落点 canInstall 判定、onDragEnd 分派共用一形。 */
export interface DragPayload {
  installKind: 'skill' | 'mcp' | 'file';
  category: InstallCategory;
  name: string;
  sourceDir?: string;
  sourceFile?: string;
  mcpConfig?: McpServerConfig;
  /** 由 buildDragPayload 经 capabilitiesOf 取得（组件禁止字面构造）。 */
  attrs: InstallAttrs;
  /** 拖源区选定的安装目标 harness（skill/mcp = AgentToggle；file 恒 claude）。 */
  targetAgent: AssetAgent;
}

/** 拖拽 payload 的唯一构造点：attrs 一律经 capabilitiesOf（组件不直接拼 payload）。 */
export function buildDragPayload(
  p: Omit<DragPayload, 'attrs'>,
  table?: InstallCapabilities | null,
): DragPayload {
  return { ...p, attrs: capabilitiesOf(p.category, table) };
}
