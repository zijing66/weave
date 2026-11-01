import path from 'node:path';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fsp } from 'node:fs';
import { HARNESS_DIRS, VISUALIZATION_PROTOCOL } from '@weavecode/core';
import type { WeaveServerDeps } from '../server.js';
import { sendJson } from '../http.js';
import { isInsideDir } from '../../market/resolve.js';
import { getVisualizationsDir } from '../../db/paths.js';

/**
 * 渲染块只读端点：按绝对路径回读 HTML fragment（JSON 包裹）。路径必须落在
 * 白名单根内（codex 官方线程目录 / claude·codex 用户目录 / codex 插件缓存 /
 * weave 的临时目录 / 已注册项目根）——fragment 是模型产物，绝不能变成任意文件读取口。
 */

/**
 * 白名单根集（每次请求现算：项目表会变，家目录派生项恒定）。
 * 临时目录只放 `<tmp>/weave` 这个专属子目录：整个 `%TEMP%` 里任何 .html 都能被
 * 引用行拉进 iframe，边界没必要放宽到那一步。
 */
function visualizationsRootOf(deps: WeaveServerDeps): string {
  return deps.visualizationsDir ?? getVisualizationsDir();
}

function whitelistRoots(deps: WeaveServerDeps): string[] {
  const home = os.homedir();
  const roots = [
    path.join(home, HARNESS_DIRS.codex.userDir, 'visualizations'),
    path.join(home, HARNESS_DIRS.claude.userDir),
    path.join(home, HARNESS_DIRS.codex.userDir, 'plugins'),
    path.join(os.tmpdir(), 'weave'),
    visualizationsRootOf(deps),
  ];
  for (const project of deps.projects.list()) roots.push(project.path);
  return roots;
}

/** 清理宽限：刚写出来的 fragment 可能还没落进对话事件，不把它算作无引用。 */
const VISUALIZATION_GRACE_MS = 24 * 60 * 60 * 1000;

const REF_PREFIXES = [
  VISUALIZATION_PROTOCOL.referencePrefix,
  ...VISUALIZATION_PROTOCOL.referencePrefixAliases,
];
const REF_SUFFIXES = [
  VISUALIZATION_PROTOCOL.referenceSuffix,
  ...VISUALIZATION_PROTOCOL.referenceSuffixAliases,
];

/** 引用行 → fragment 绝对路径。web `visualizeRefOf` 同判据（它只 import type、常量镜像）。 */
function visualizePathsIn(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const prefix = REF_PREFIXES.find((p) => trimmed.startsWith(p));
    if (!prefix) continue;
    let body = trimmed.slice(prefix.length);
    const suffix = REF_SUFFIXES.find((s) => body.endsWith(s));
    if (suffix) body = body.slice(0, -suffix.length);
    try {
      const parsed = JSON.parse(body) as { path?: unknown };
      if (typeof parsed.path === 'string' && parsed.path) out.push(path.resolve(parsed.path));
    } catch {
      /* 坏行当普通文本（与 web 同口径） */
    }
  }
  return out;
}

/** 历史上被对话引用过的 fragment 路径（小写归一，Windows 路径大小写不定）。 */
function referencedPathsOf(deps: WeaveServerDeps): Set<string> {
  const set = new Set<string>();
  for (const text of deps.hookEvents?.conversationTextsContaining('visualize') ?? []) {
    for (const p of visualizePathsIn(text)) set.add(p.toLowerCase());
  }
  return set;
}

interface FragmentFile {
  file: string;
  size: number;
  mtimeMs: number;
}

async function listFragments(dir: string): Promise<FragmentFile[]> {
  const out: FragmentFile[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.html') continue;
      try {
        const stat = await fsp.stat(full);
        out.push({ file: full, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        /* 并发删除：跳过 */
      }
    }
  };
  await walk(dir);
  return out;
}

interface FragmentStats {
  root: string;
  count: number;
  bytes: number;
  /** 可安全清理：无对话引用且过了宽限期（历史气泡不会因此破图）。 */
  unreferenced: { count: number; bytes: number };
}

async function fragmentStats(deps: WeaveServerDeps): Promise<FragmentStats> {
  const root = visualizationsRootOf(deps);
  const files = await listFragments(root);
  const referenced = referencedPathsOf(deps);
  const cutoff = Date.now() - VISUALIZATION_GRACE_MS;
  const stats: FragmentStats = {
    root,
    count: files.length,
    bytes: 0,
    unreferenced: { count: 0, bytes: 0 },
  };
  for (const f of files) {
    stats.bytes += f.size;
    if (referenced.has(f.file.toLowerCase()) || f.mtimeMs > cutoff) continue;
    stats.unreferenced.count += 1;
    stats.unreferenced.bytes += f.size;
  }
  return stats;
}

export async function handleVisualizationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
  url: URL,
): Promise<boolean> {
  if (pathname === '/visualizations/stats' && req.method === 'GET') {
    sendJson(res, 200, await fragmentStats(deps));
    return true;
  }
  if (pathname === '/visualizations/cleanup' && req.method === 'POST') {
    const files = await listFragments(visualizationsRootOf(deps));
    const referenced = referencedPathsOf(deps);
    const cutoff = Date.now() - VISUALIZATION_GRACE_MS;
    let removed = 0;
    let freedBytes = 0;
    for (const file of files) {
      if (referenced.has(file.file.toLowerCase()) || file.mtimeMs > cutoff) continue;
      try {
        await fsp.unlink(file.file);
        removed += 1;
        freedBytes += file.size;
      } catch {
        /* 删不掉就留着，下次再试 */
      }
    }
    sendJson(res, 200, { removed, freedBytes });
    return true;
  }
  if (pathname !== '/visualizations/fragment' || req.method !== 'GET') return false;
  const raw = url.searchParams.get('path') ?? '';
  const abs = path.resolve(raw);
  if (!raw || !path.isAbsolute(raw)) {
    sendJson(res, 400, { error: 'Missing or relative "path" query parameter' });
    return true;
  }

  const roots = whitelistRoots(deps);
  if (!roots.some((root) => isInsideDir(abs, root))) {
    sendJson(res, 403, {
      error: `Fragment path is outside the allowed roots: ${roots.join(', ')}`,
    });
    return true;
  }
  if (path.extname(abs).toLowerCase() !== '.html') {
    sendJson(res, 403, { error: 'Only .html fragments are served' });
    return true;
  }

  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(abs);
  } catch {
    sendJson(res, 404, { error: 'Fragment file not found' });
    return true;
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { error: 'Fragment path is not a file' });
    return true;
  }
  // fragment 是活文件（模型随时重写）：不缓存，跨机访问才拿得到当下快照
  res.setHeader('cache-control', 'no-store');
  // 轮询的条件形：带上客户端手上那份的 mtime，没变就只回一个空壳——热更新
  // 每几秒一拍，没必要把整份正文（≤1MB）反复搬一遍
  const mtimeMs = Math.floor(stat.mtimeMs);
  const sinceRaw = url.searchParams.get('mtime');
  const since = sinceRaw == null ? NaN : Number(sinceRaw);
  if (Number.isFinite(since) && since === mtimeMs) {
    sendJson(res, 200, { unchanged: true, mtimeMs });
    return true;
  }
  if (stat.size > VISUALIZATION_PROTOCOL.maxFragmentBytes) {
    sendJson(res, 413, { error: 'Fragment exceeds the 1 MB size limit' });
    return true;
  }

  const html = await fsp.readFile(abs, 'utf8');
  sendJson(res, 200, { html, mtimeMs });
  return true;
}
