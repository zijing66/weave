import type { IncomingMessage, ServerResponse } from 'node:http';
import { HARNESS_KEYS } from '@weavecode/core';
import type { WeaveServerDeps } from '../server.js';
import { sendJson } from '../http.js';
import { readMcpRows } from '../../install/mcp-rows.js';
import { readGlobalSkillGroups } from '../../install/global-config.js';
import { listGlobalFileAssets } from '../../install/global-file-assets.js';
import type { AssetAgent, AssetCategory } from '../../watch/types.js';

/**
 * 跨项目安装位置聚合（市场弹层的「已装 N 处」唯一数据面）：
 *   GET /installations — 一次全量快照，扁平行，前端自行建索引与分组。
 *
 * 按需实时聚合（拍板）：遍历注册项目读 watch 缓存 + MCP 行 + toolkit，加全局
 * skill 组与机器级文件资产——全部是既有读取面，本路由只做编排。watch 缓存是
 * 最终一致语义（daemon 启动数秒内热起来），缺席（测试）时项目文件行为空、
 * 其余轴照常，不 503。
 */

/** 市场可装的类别（与 InstallCategory 同族 + plugin 包）。 */
export type InstallationKind =
  | 'skill'
  | 'mcp'
  | 'plugin'
  | 'command'
  | 'agent'
  | 'workflow'
  | 'rule'
  | 'output-style';

export interface InstallationRow {
  kind: InstallationKind;
  name: string;
  /** plugin 行的注册键 `name@market`（有则优先于 name 匹配）。 */
  key?: string;
  /** null = 全局（user 档，无项目可挂）。 */
  projectId: number | null;
  projectName: string | null;
  scope: 'project' | 'user';
  harness: AssetAgent;
}

/** watch 资产里可单装的文件类别（skill 走目录名提取、mcp/plugin 另有数据面）；
 *  值即 InstallationKind（Record 判据同时完成收窄）。 */
const FILE_KINDS: Partial<Record<AssetCategory, InstallationKind>> = {
  command: 'command',
  agent: 'agent',
  workflow: 'workflow',
  rule: 'rule',
  'output-style': 'output-style',
};

/** `<harness-root>/skills/<name>/` 形状 harness 无关（同 web 的 groupSkillRows）。 */
const SKILL_IN_REL = /^[^/]+\/skills\/([^/]+)\//;

/** GlobalSkillSource 的 harness 前缀（claude-personal → claude）——按名表前缀
 *  匹配，不写死两 harness；无匹配跳过该组（未知来源不猜）。 */
function harnessOfSource(source: string): AssetAgent | null {
  return HARNESS_KEYS.find((h) => source.startsWith(h)) ?? null;
}

/** 文件名去扩展（FileAssetTemplate.name 的口径 = file stem）。 */
function stemOf(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * 安装位置聚合路由。返回 true = 本路由认领；false = 未命中，主链继续。
 */
export async function handleInstallationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/installations') return false;
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  const projects = deps.projects.list();
  const [globalSkills, globalFiles, ...perProject] = await Promise.all([
    readGlobalSkillGroups().catch(() => []),
    listGlobalFileAssets().catch(() => []),
    ...projects.map(async (project) => ({
      project,
      assets: deps.watch?.getAssets(project.path) ?? [],
      mcp: await readMcpRows(project.path).catch(() => []),
      toolkit: await deps.toolkit?.list(project.id).catch(() => null),
    })),
  ]);

  const rows: InstallationRow[] = [];
  // 行去重键 = kind/harness/名 + 落点。两处来源会重复：user 档行 N 个项目各读
  // 一遍结果相同；项目档 skill 行 watch 按文件展开（多文件 skill 目录产出 N 条
  // 同名 AssetEntry）——同一 (kind, 名, 落点) 只出一条。
  const seen = new Set<string>();
  const pushRow = (row: InstallationRow): void => {
    const dedup = `${row.kind}\0${row.harness}\0${row.key ?? row.name}\0${row.projectId}\0${row.scope}`;
    if (seen.has(dedup)) return;
    seen.add(dedup);
    rows.push(row);
  };
  const userRow = (row: Omit<InstallationRow, 'projectId' | 'projectName'>): void => {
    pushRow({ ...row, projectId: null, projectName: null });
  };

  // ---- 全局轴：个人/插件 skill 组 + 机器级文件资产（skills 已被组覆盖，无重复）----
  for (const group of globalSkills) {
    const harness = harnessOfSource(group.source);
    if (!harness) continue;
    for (const skill of group.skills) {
      userRow({ kind: 'skill', name: skill.name, scope: 'user', harness });
    }
  }
  for (const entry of globalFiles) {
    const kind = FILE_KINDS[entry.category];
    if (!kind) continue;
    userRow({ kind, name: stemOf(entry.relPath), scope: 'user', harness: entry.agent });
  }

  // ---- 项目轴：watch 文件资产 + MCP 行 + toolkit 包 ----
  for (const { project, assets, mcp, toolkit } of perProject) {
    const base = { projectId: project.id, projectName: project.name };
    for (const entry of assets) {
      const skill = entry.relPath.match(SKILL_IN_REL);
      if (skill) {
        pushRow({ ...base, kind: 'skill', name: skill[1]!, scope: 'project', harness: entry.agent });
      } else {
        const kind = FILE_KINDS[entry.category];
        if (!kind) continue;
        pushRow({
          ...base,
          kind,
          name: stemOf(entry.relPath),
          scope: 'project',
          harness: entry.agent,
        });
      }
    }
    for (const row of mcp) {
      if (row.builtin) continue; // 未装内置 MCP 的占位行不是安装事实
      if (row.scope === 'user') {
        userRow({ kind: 'mcp', name: row.key, scope: 'user', harness: row.harness });
      } else {
        pushRow({ ...base, kind: 'mcp', name: row.key, scope: 'project', harness: row.harness });
      }
    }
    for (const pack of toolkit?.packs ?? []) {
      if (!pack.installed) continue;
      const harness = pack.targets[0];
      if (!harness) continue;
      const key = pack.key ?? pack.name;
      if (pack.scopes?.includes('user')) {
        userRow({ kind: 'plugin', name: pack.name, key, scope: 'user', harness });
      } else {
        pushRow({ ...base, kind: 'plugin', name: pack.name, key, scope: 'project', harness });
      }
    }
  }

  sendJson(res, 200, { installations: rows });
  return true;
}
