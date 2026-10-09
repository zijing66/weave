import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WEAVE_PLUGIN_MANIFEST, WeavePluginManifestSchema } from '@weavecode/core';
import { getDataDir } from '../db/paths.js';

/**
 * 插件分发通道（A3）：install（本地路径 / git URL）/ uninstall / export +
 * installed.json 安装清单（ruflo `.claude-flow/plugins/installed.json` 同构）。
 * 安装落点 = 全局插件根 `<configDir>/weave/plugins/`，由 SPI 加载器自动识别。
 */

interface InstalledEntry {
  id: string;
  name: string;
  version: string;
  /** 来源描述：本地路径 / git URL / index 条目。 */
  source: string;
  /** 相对全局插件根的目录名。 */
  dir: string;
  installedAt: string;
}

export function globalPluginRoot(): string {
  return path.join(getDataDir(), 'plugins');
}

function installedManifestPath(root?: string): string {
  return path.join(root ?? globalPluginRoot(), 'installed.json');
}

async function readInstalled(root?: string): Promise<InstalledEntry[]> {
  try {
    const raw = JSON.parse(await readFile(installedManifestPath(root), 'utf8'));
    return Array.isArray(raw) ? (raw as InstalledEntry[]) : [];
  } catch {
    return [];
  }
}

async function writeInstalled(entries: InstalledEntry[], root?: string): Promise<void> {
  const dir = root ?? globalPluginRoot();
  await mkdir(dir, { recursive: true });
  await writeFile(installedManifestPath(root), JSON.stringify(entries, null, 2) + '\n', 'utf8');
}

/** 读一个目录的 manifest（非法返回 null）。 */
async function readManifest(dir: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(dir, WEAVE_PLUGIN_MANIFEST), 'utf8'));
    return WeavePluginManifestSchema.safeParse(raw).success ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 在给定目录下找插件包：根自身，或一级子目录。返回 (目录, manifest) 列表。 */
async function findPluginDirs(root: string): Promise<Array<{ dir: string; manifest: Record<string, unknown> }>> {
  const found: Array<{ dir: string; manifest: Record<string, unknown> }> = [];
  const self = await readManifest(root);
  if (self) return [{ dir: root, manifest: self }];
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return found;
  }
  for (const name of names) {
    const dir = path.join(root, name);
    const m = await readManifest(dir);
    if (m) found.push({ dir, manifest: m });
  }
  return found;
}

function run(cmd: string, args: string[], cwd?: string, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} ${args.join(' ')} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} 退出码 ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

/** src 为本地路径（存在目录/含 manifest 的父目录）或 git URL（https:// 或 git@ 或 *.git 结尾）。 */
export function isGitSource(src: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(src) || src.endsWith('.git');
}

export interface InstallResult {
  installed: Array<{ id: string; name: string; version: string; dir: string }>;
  /** 风险提示（git/npm 来源的无沙箱警告由 CLI 转述）。 */
  warnings: string[];
}

/**
 * 安装插件到全局插件根。src = 本地目录 | git URL。
 * 找到的每个插件包复制为 `<root>/<id>/`，写 installed.json（同 id 覆盖更新）。
 * 路径穿越防护：目标目录名只用 manifest.id（已过 schema 的 kebab-case）。
 */
export async function installPlugin(src: string, opts?: { root?: string }): Promise<InstallResult> {
  const warnings: string[] = [];
  let scanRoot: string;
  let cleanup: (() => Promise<void>) | undefined;

  if (isGitSource(src)) {
    warnings.push(`从 ${src} 安装的插件未经沙箱隔离，请确认来源可信`);
    const tmp = path.join(getDataDir(), 'tmp', `install-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
    await run('git', ['clone', '--depth', '1', src, path.join(tmp, 'repo')]);
    scanRoot = path.join(tmp, 'repo');
    cleanup = () => rm(tmp, { recursive: true, force: true });
  } else {
    scanRoot = path.resolve(src);
    if (!existsSync(scanRoot)) throw new Error(`本地路径不存在: ${scanRoot}`);
  }

  try {
    const found = await findPluginDirs(scanRoot);
    if (found.length === 0) throw new Error(`未找到 ${WEAVE_PLUGIN_MANIFEST}（src 或其一级子目录）`);

    const root = opts?.root ?? globalPluginRoot();
    await mkdir(root, { recursive: true });
    const installed: InstalledEntry[] = await readInstalled(opts?.root);
    const result: InstallResult['installed'] = [];

    for (const { dir, manifest } of found) {
      const id = String(manifest.id);
      const dest = path.join(root, id);
      if (path.resolve(dest).startsWith(path.resolve(root) + path.sep)) {
        await rm(dest, { recursive: true, force: true });
        await cp(dir, dest, {
          recursive: true,
          filter: (p) => !p.includes('node_modules') && !p.includes(`${path.sep}.git`),
        });
      }
      const entry: InstalledEntry = {
        id,
        name: String(manifest.name ?? id),
        version: String(manifest.version ?? '0.0.0'),
        source: src,
        dir: id,
        installedAt: new Date().toISOString(),
      };
      const idx = installed.findIndex((e) => e.id === id);
      if (idx >= 0) installed[idx] = entry;
      else installed.push(entry);
      result.push({ id, name: entry.name, version: entry.version, dir: id });
    }
    await writeInstalled(installed, opts?.root);
    return { installed: result, warnings };
  } finally {
    if (cleanup) await cleanup();
  }
}

/** 卸载：删目录 + 清 installed.json。规则级联删除由 daemon 热重载完成。 */
export async function uninstallPlugin(pluginId: string, opts?: { root?: string }): Promise<boolean> {
  const root = opts?.root ?? globalPluginRoot();
  const installed = await readInstalled(opts?.root);
  const entry = installed.find((e) => e.id === pluginId);
  const dir = entry
    ? path.join(root, entry.dir)
    : path.join(root, pluginId); // 目录扫描装的（无清单）按 id 猜
  if (!existsSync(dir)) return false;
  await rm(dir, { recursive: true, force: true });
  if (entry) await writeInstalled(installed.filter((e) => e.id !== pluginId), opts?.root);
  return true;
}

/**
 * 导出插件为可分发目录（剔除 node_modules/.git）：`<out>/<id>`。
 * 目标已存在则覆盖——export 是生成物而非用户数据。
 */
export async function exportPlugin(pluginId: string, outDir: string, opts?: { root?: string }): Promise<string> {
  const src = path.join(opts?.root ?? globalPluginRoot(), pluginId);
  if (!existsSync(src)) throw new Error(`插件目录不存在: ${src}`);
  const manifest = await readManifest(src);
  if (!manifest) throw new Error(`插件缺少合法 ${WEAVE_PLUGIN_MANIFEST}: ${pluginId}`);
  const dest = path.join(path.resolve(outDir), pluginId);
  await rm(dest, { recursive: true, force: true });
  await cp(src, dest, {
    recursive: true,
    filter: (p) => !p.includes('node_modules') && !p.includes(`${path.sep}.git`),
  });
  return dest;
}

export interface PluginIndexEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** 下载地址（git URL 或可直接 clone 的地址）。 */
  url: string;
  checksum?: string; // 一期存在性占位，签名/校验后续批次
}

/**
 * sources.json 结构（批 10 schema 演进）：旧形为 index URL 字符串数组，
 * 新形为 `{ indexes, dirs }`——`dirs` 是经 REST `POST /toolkit/dirs` 注册的
 * 本地工具包目录，**不进远程搜索源**。读侧两种形都接受，写侧统一落新形。
 */
export interface SourcesFileShape {
  indexes: string[];
  dirs: string[];
}

function sourcesPath(root?: string): string {
  return path.join(root ?? globalPluginRoot(), 'sources.json');
}

/** 解析 sources.json 原始值：旧 `string[]` 与新 `{indexes, dirs}` 双形兼容。 */
export function parseSources(raw: unknown): SourcesFileShape {
  if (Array.isArray(raw)) {
    return { indexes: raw.filter((s): s is string => typeof s === 'string'), dirs: [] };
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const pick = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
    return { indexes: pick(obj['indexes']), dirs: pick(obj['dirs']) };
  }
  return { indexes: [], dirs: [] };
}

export async function readSourcesFile(root?: string): Promise<SourcesFileShape> {
  try {
    return parseSources(JSON.parse(await readFile(sourcesPath(root), 'utf8')));
  } catch {
    return { indexes: [], dirs: [] };
  }
}

export async function writeSourcesFile(sources: SourcesFileShape, root?: string): Promise<void> {
  const dir = root ?? globalPluginRoot();
  await mkdir(dir, { recursive: true });
  await writeFile(sourcesPath(root), JSON.stringify(sources, null, 2) + '\n', 'utf8');
}

/** 注册外置工具包目录（批 10，REST `POST /toolkit/dirs`）；已存在则幂等。 */
export async function addToolkitDir(dir: string, root?: string): Promise<SourcesFileShape> {
  const abs = path.resolve(dir);
  if (!existsSync(abs)) throw new Error(`目录不存在: ${abs}`);
  const sources = await readSourcesFile(root);
  if (!sources.dirs.includes(abs)) {
    sources.dirs.push(abs);
    await writeSourcesFile(sources, root);
  }
  return sources;
}

/** 移除外置工具包目录注册；级联卸载由调用方（toolkit service）负责。 */
export async function removeToolkitDir(dir: string, root?: string): Promise<SourcesFileShape> {
  const abs = path.resolve(dir);
  const sources = await readSourcesFile(root);
  const next = { ...sources, dirs: sources.dirs.filter((d) => d !== abs) };
  if (next.dirs.length !== sources.dirs.length) await writeSourcesFile(next, root);
  return next;
}

/**
 * marketplace 搜索：读 sources.json（`<configDir>/weave/plugins/sources.json`）
 * 逐 index 源拉取，按 term 过滤 id/name/description。
 * 批 10：只遍历 `indexes`、跳过 `dirs`（外置工具包目录不是远程搜索源）。
 */
export async function searchPlugins(term: string): Promise<PluginIndexEntry[]> {
  const { indexes } = await readSourcesFile();
  const results: PluginIndexEntry[] = [];
  for (const url of indexes) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const data = (await res.json()) as { plugins?: PluginIndexEntry[] };
      for (const p of data.plugins ?? []) {
        const hay = `${p.id} ${p.name} ${p.description ?? ''}`.toLowerCase();
        if (!term || hay.includes(term.toLowerCase())) results.push(p);
      }
    } catch {
      // 单源失败不影响其他源
    }
  }
  return results;
}
