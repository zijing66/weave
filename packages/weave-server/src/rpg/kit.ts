import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 出征 kit（G2 段2，方案 C + G线设计 §三）：人格/技能层 = skill 形态安装进
 * worktree 专用子目录 `.claude/skills/<role>-<skill>/`（角色名前缀防撞名）；
 * `.git/info/exclude` 追加带 marker 的块静默（幂等、块状增删）。能力层（MCP）
 * 不随行走（设计裁决：晋升安装，绝不跨项目借用 MCP 连接）。
 *
 * exclude 编辑串行化 + 登记文件即引用计数：同一 worktree 同角色双出征、并发写
 * 都靠登记文件里的引用数闭合（引用计数归零才摘块删目录）。
 */

/** kit 安装根（worktree 内的专用子目录）。 */
export function kitSkillsRoot(worktreePath: string): string {
  return path.join(worktreePath, '.claude', 'skills');
}

/** kit skill 的角色前缀命名（防撞名：同 worktree 多角色并行出征）。 */
export function kitSkillName(role: string, skill: string): string {
  return `${role}-${skill}`;
}

/** exclude marker 块的边界行（出征实例 id 闭包）。 */
export function kitExcludeMarker(role: string, instanceId: string): string {
  return `# weave:role-kit:${role}:${instanceId}`;
}

/** 读取登记文件（`<worktree>/.weave/kit-registry.json`）；坏文件 = 空表。 */
export interface KitRegistryEntry {
  /** exclude 块 marker（引用计数的闭包键）。 */
  marker: string;
  /** 引用本块的出征实例（同一实例重复安装 = 计数不动）。 */
  refs: string[];
  /** 本块覆盖的 kit skill 目录名（清理按它删）。 */
  skills: string[];
}

export type KitRegistry = Record<string, KitRegistryEntry>;

export function readKitRegistry(worktreePath: string): KitRegistry {
  try {
    const parsed: unknown = JSON.parse(readFileSync(kitRegistryPath(worktreePath), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: KitRegistry = {};
    for (const [marker, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const e = value as Partial<KitRegistryEntry>;
      if (typeof e.marker !== 'string' || !Array.isArray(e.refs) || !Array.isArray(e.skills)) continue;
      out[marker] = { marker: e.marker, refs: e.refs.filter((r): r is string => typeof r === 'string'), skills: e.skills.filter((s): s is string => typeof s === 'string') };
    }
    return out;
  } catch {
    return {};
  }
}

export function writeKitRegistry(worktreePath: string, registry: KitRegistry): void {
  const file = kitRegistryPath(worktreePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

function kitRegistryPath(worktreePath: string): string {
  return path.join(worktreePath, '.weave', 'kit-registry.json');
}

/**
 * 安装 kit（出征起手）：skill 源目录复制进 worktree 的 `.claude/skills/<role>-<skill>/`
 * + exclude marker 块登记（引用计数 +1）。幂等：同一 (role, skill) 已装 = 原样返回
 * （marker 按角色聚块——同角色双出征共用同一块 exclude，实例进 refs 引用计数）。
 * tracked 冲突 = 安装拒绝（409 语义，不静默覆盖用户的 tracked 文件）。
 */
export interface InstallKitInput {
  worktreePath: string;
  role: string;
  instanceId: string;
  /** skill 源目录：键 = skill 名，值 = 源目录绝对路径。 */
  skills: Record<string, string>;
  /** tracked 查重缝（缺省无查重 = 信任调用方已查；显式给即可断言）。 */
  trackedCheck?: (worktreePath: string, relPaths: string[]) => string[] | Promise<string[]>;
}

export type InstallKitResult =
  | { ok: true; installed: string[]; marker: string }
  | { ok: false; error: string; conflicts?: string[] };

export async function installKit(input: InstallKitInput): Promise<InstallKitResult> {
  const { worktreePath, role, instanceId } = input;
  const names = Object.keys(input.skills);
  if (names.length === 0) return { ok: false, error: 'no skills to install' };
  const marker = kitExcludeMarker(role, role);
  const root = kitSkillsRoot(worktreePath);
  const relPaths = names.map((n) => path.join('.claude', 'skills', kitSkillName(role, n)).replace(/\\/g, '/'));
  const conflicts = (await input.trackedCheck?.(worktreePath, relPaths)) ?? [];
  if (conflicts.length > 0) {
    return { ok: false, error: 'kit paths collide with tracked files', conflicts };
  }
  const registry = readKitRegistry(worktreePath);
  const entry = registry[marker] ?? { marker, refs: [], skills: [] };
  const installed: string[] = [];
  const excludeEntries = excludeBlockEntries(worktreePath, marker);
  for (const name of names) {
    const dirName = kitSkillName(role, name);
    const target = path.join(root, dirName);
    if (!existsSync(target)) {
      try {
        statSync(input.skills[name]!);
      } catch {
        return { ok: false, error: `skill source not found: ${input.skills[name]}` };
      }
      mkdirSync(target, { recursive: true });
      try {
        cpSync(input.skills[name]!, target, { recursive: true });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'kit copy failed' };
      }
      installed.push(dirName);
    }
    if (!entry.skills.includes(dirName)) entry.skills.push(dirName);
    const rel = path.posix.join('.claude', 'skills', dirName);
    if (!excludeEntries.includes(rel)) excludeEntries.push(rel);
  }
  upsertExcludeBlock(worktreePath, marker, excludeEntries);
  if (!entry.refs.includes(instanceId)) entry.refs.push(instanceId);
  registry[marker] = entry;
  writeKitRegistry(worktreePath, registry);
  return { ok: true, installed, marker };
}

/**
 * 清场（收尾）：引用计数 -1；归零 = 摘 exclude 块 + 删本块装下的 kit 目录。
 * 非归零只摘引用。幂等：marker 不在登记 = no-op。
 */
export function cleanupKit(worktreePath: string, role: string, instanceId: string): { removed: boolean; refsLeft: number } {
  const marker = kitExcludeMarker(role, role);
  const registry = readKitRegistry(worktreePath);
  const entry = registry[marker];
  if (!entry) return { removed: false, refsLeft: 0 };
  entry.refs = entry.refs.filter((r) => r !== instanceId);
  if (entry.refs.length > 0) {
    registry[marker] = entry;
    writeKitRegistry(worktreePath, registry);
    return { removed: false, refsLeft: entry.refs.length };
  }
  removeExcludeBlock(worktreePath, marker);
  const root = kitSkillsRoot(worktreePath);
  for (const dirName of entry.skills) {
    rmSync(path.join(root, dirName), { recursive: true, force: true });
  }
  delete registry[marker];
  writeKitRegistry(worktreePath, registry);
  return { removed: true, refsLeft: 0 };
}

// ---- `.git/info/exclude` 块状编辑（幂等；只动自己的 marker 块）----

/**
 * 追加/更新 marker 块：块形 = marker 行 + 每目录一行 + `# end <marker>` 行。
 * 已有同名块 = 先整块摘除再追加（幂等重写）。
 */
export function upsertExcludeBlock(worktreePath: string, marker: string, entries: readonly string[]): void {
  const file = excludePath(worktreePath);
  let lines: string[] = [];
  try {
    lines = readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    /* 无文件 = 新建 */
  }
  lines = stripBlock(lines, marker);
  if (entries.length === 0) return writeExclude(file, lines);
  lines.push(marker, ...entries, `# end ${marker}`);
  writeExclude(file, lines);
}

/** 摘 marker 块（块不存在 = no-op）。 */
export function removeExcludeBlock(worktreePath: string, marker: string): void {
  const file = excludePath(worktreePath);
  try {
    writeExclude(file, stripBlock(readFileSync(file, 'utf8').split(/\r?\n/), marker));
  } catch {
    /* 无文件 = no-op */
  }
}

/** exclude 里该 marker 块覆盖的目录行（块外同名条目不动——那是用户自己的）。 */
export function excludeBlockEntries(worktreePath: string, marker: string): string[] {
  try {
    const lines = readFileSync(excludePath(worktreePath), 'utf8').split(/\r?\n/);
    const out: string[] = [];
    let inside = false;
    for (const line of lines) {
      if (line === marker) {
        inside = true;
        continue;
      }
      if (inside && line === `# end ${marker}`) break;
      if (inside && line.trim() !== '') out.push(line);
    }
    return out;
  } catch {
    return [];
  }
}

function stripBlock(lines: string[], marker: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line === marker) {
      inside = true;
      continue;
    }
    if (inside && line === `# end ${marker}`) {
      inside = false;
      continue;
    }
    if (!inside) out.push(line);
  }
  return out;
}

function excludePath(worktreePath: string): string {
  // worktree 的 git 目录 = 主仓 .git/worktrees/<name>；`git rev-parse --git-dir`
  // 的缝由调用方在需要严格解析时用——这里按共享 exclude 的常见布局解析：
  // worktree 本目录下没有 `.git` 目录（是文件），逐级上溯找 `.git` 根。
  let dir = worktreePath;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, '.git');
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isDirectory()) return path.join(candidate, 'info', 'exclude');
        // .git 是文件（worktree 形态）：读 gitdir 指针
        const pointer = readFileSync(candidate, 'utf8').trim();
        const m = /^gitdir:\s*(.+)$/.exec(pointer);
        if (m) return path.join(m[1]!.trim(), 'info', 'exclude');
      } catch {
        /* 读不动 = 按原路径试 */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(worktreePath, '.git', 'info', 'exclude');
}

function writeExclude(file: string, lines: string[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const trimmed = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  writeFileSync(file, (trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`), 'utf8');
}
