/**
 * 市场弹层的行模型与纯函数：四类库资产（skill / MCP / 文件模板 / 插件包）摊平成
 * 单行清单（VS Code Extensions 式），安装位置索引与跨源搜索都在前端内存里做。
 */

import type {
  FileAssetTemplate,
  InstallationKind,
  InstallationRow,
  MarketPluginAsset,
  McpTemplate,
  SkillAsset,
} from '@/lib/api';

/** 摊平后的市场行：`kind` 决定安装载荷取哪个字段。 */
export interface MarketRow {
  /** `${marketId}:${kind}:${name}`——库内同名不同类不撞键。 */
  uid: string;
  marketId: number;
  kind: InstallationKind;
  name: string;
  skill?: SkillAsset;
  mcp?: McpTemplate;
  file?: FileAssetTemplate;
  plugin?: MarketPluginAsset;
}

/** 一个库的四类扫描结果（GET /libraries/:id/assets 的响应形状）。 */
export interface LibraryAssets {
  skills: SkillAsset[];
  mcp: McpTemplate[];
  files: FileAssetTemplate[];
  plugins: MarketPluginAsset[];
}

/** 四类摊平（包内 skill 不进——隶属插件，随包启停，与市场侧栏同口径）。 */
export function rowsOfLibrary(marketId: number, assets: LibraryAssets): MarketRow[] {
  const rows: MarketRow[] = [];
  for (const s of assets.skills) {
    rows.push({ uid: `${marketId}:skill:${s.name}`, marketId, kind: 'skill', name: s.name, skill: s });
  }
  for (const m of assets.mcp) {
    rows.push({ uid: `${marketId}:mcp:${m.name}`, marketId, kind: 'mcp', name: m.name, mcp: m });
  }
  for (const f of assets.files) {
    rows.push({ uid: `${marketId}:${f.category}:${f.name}`, marketId, kind: f.category, name: f.name, file: f });
  }
  for (const p of assets.plugins) {
    rows.push({ uid: `${marketId}:plugin:${p.name}`, marketId, kind: 'plugin', name: p.name, plugin: p });
  }
  return rows;
}

/** 安装位置索引键：plugin 行有注册键用键（`name@market`），其余用名。 */
export function installationKeyOf(kind: InstallationKind, name: string, key?: string): string {
  return `${kind}\0${key ?? name}`;
}

/**
 * 安装位置索引：`installationKeyOf` → 位置行。同一实体装在多处 = 多行；
 * 前端徽标与位置弹层都查这一份，零额外请求。
 */
export function buildInstallationIndex(
  rows: readonly InstallationRow[],
): Map<string, InstallationRow[]> {
  const index = new Map<string, InstallationRow[]>();
  for (const row of rows) {
    const key = installationKeyOf(row.kind, row.name, row.key);
    const list = index.get(key);
    if (list) list.push(row);
    else index.set(key, [row]);
  }
  return index;
}

/** 市场行的索引键（与 InstallationRow 同键空间）。 */
export function installationKeyOfRow(row: MarketRow): string {
  return installationKeyOf(row.kind, row.name, row.plugin?.key);
}

// --- 跨源搜索：三档 rank（与服务端 project-files 的 rankOf 同口径） ---

function isSubsequence(hay: string, needle: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/** 三档：名字前缀 > 名字包含 > 名字子序列；不命中返回 -1。 */
export function rankOfName(base: string, q: string): number {
  if (base.startsWith(q)) return 3;
  if (base.includes(q)) return 2;
  return isSubsequence(base, q) ? 1 : -1;
}

/** 跨源搜索：按名字三档过滤排序（档高在前、同档名字短在前、再字典序）。 */
export function filterAndRankRows(rows: readonly MarketRow[], query: string): MarketRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  const hits: { row: MarketRow; rank: number }[] = [];
  for (const row of rows) {
    const rank = rankOfName(row.name.toLowerCase(), q);
    if (rank > 0) hits.push({ row, rank });
  }
  return hits
    .sort(
      (a, b) =>
        b.rank - a.rank ||
        a.row.name.length - b.row.name.length ||
        a.row.name.localeCompare(b.row.name),
    )
    .map((h) => h.row);
}
