import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isHarness, type Harness } from '@weavecode/core';
import type { PathRefSpec } from '@weavecode/harness';
import type { WeaveServerDeps } from '../server.js';
import { readJson, sendJson } from '../http.js';
import { messagingSurfaceFor } from '../../surfaces.js';
import { listDirOf, matchPaths, projectFileIndex } from '../project-files.js';
import { resolveWithinProject } from '../../install/reader.js';
import type { ProjectRow } from '../../repositories/projects.js';

/**
 * 路径引用域路由：项目文件索引（搜索/目录浏览）、引用表达式现算、反向认引用、
 * 项目根内只读预览。表达式归 harness 能力面，web 只当不透明字符串。
 */

/** 预览栏的字节上限（比资产读取小：预览只要头几十行，不需要整份大文件）。 */
const PREVIEW_MAX_BYTES = 4 * 1024 * 1024;

/** 文本预览上限：编辑器扛得动更大的，但一次预览不需要整份大文件。 */
const PREVIEW_MAX_TEXT_BYTES = 1024 * 1024;

/** 二进制嗅探窗：前这么多字节里出现 NUL 就当二进制（编辑器渲不出它，别塞乱码）。 */
const BINARY_SNIFF_BYTES = 8192;

/** 列表条数：缺省 100，封顶 200。 */
function clampLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(200, Math.floor(n));
}

/** 预览的图片类型；非图返回 null（调用方回落 text/plain）。 */
function imageTypeOf(relPath: string): string | null {
  const ext = relPath.slice(relPath.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return null;
  }
}

/** 会话 → 项目（路径引用的四条路由共用）：判定不过就写好响应并返回 null。 */
function projectOfSession(
  res: ServerResponse,
  deps: WeaveServerDeps,
  sessionId: string,
): ProjectRow | null {
  if (!deps.hookSessions || !deps.hookEvents) {
    sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
    return null;
  }
  const session = deps.hookSessions.getBySessionId(sessionId);
  if (!session) {
    sendJson(res, 404, { error: 'Session not found' });
    return null;
  }
  if (session.projectId == null) {
    sendJson(res, 400, { error: 'Session is not bound to a project' });
    return null;
  }
  const project = deps.projects.getById(session.projectId);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  return project;
}

/** harness 归属 = 最新事件的 source（与 open-terminal / 投递器同口径）。 */
function latestHarnessOf(deps: WeaveServerDeps, sessionId: string): Harness | null {
  if (!deps.hookEvents) return null;
  const latest = deps.hookEvents.listBySession(sessionId, 1);
  const src = latest[latest.length - 1]?.source;
  return isHarness(src) ? src : null;
}

/** 会话所属 harness 的路径引用面；没有文法时写好 409 并返回 null。 */
function pathRefSpecOf(
  res: ServerResponse,
  deps: WeaveServerDeps,
  sessionId: string,
): PathRefSpec | null {
  const src = latestHarnessOf(deps, sessionId);
  const surface = src ? messagingSurfaceFor(src) : null;
  const spec = surface?.pathRefs ?? null;
  if (spec) return spec;
  sendJson(res, 409, {
    error: src
      ? (surface?.unsupportedReasons?.pathRefs ?? `Harness "${src}" has no path reference syntax`)
      : 'Session has no hook events to determine its harness',
  });
  return null;
}

/** 正整数行号（`Number('')` 是 0，故先挡空串——缺省与非法要分开）。 */
function lineOf(raw: string | null): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 升序数组里二分查一条路径（索引几万到几十万条，Set 化一遍就是白占一份内存）。 */
function hasPath(sorted: readonly string[], target: string): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = sorted[mid]!;
    if (v === target) return true;
    if (v < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/**
 * 路径引用域路由。返回 true = 本路由认领；false = 未命中，主链继续。
 */
export async function handlePathRefRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
  url: URL,
): Promise<boolean> {
  // ---- 路径引用：项目文件索引（打开即重建的面，不常驻、不进 DataKey） ----
  // 表达式归 harness：`ref` 由能力面现算，web 只把它当不透明字符串贴进输入框。
  const filesMatch = pathname.match(/^\/sessions\/([^/]+)\/files$/);
  if (filesMatch && req.method === 'GET') {
    const sessionId = decodeURIComponent(filesMatch[1]!);
    const project = projectOfSession(res, deps, sessionId);
    if (!project) return true;
    const refSpec = pathRefSpecOf(res, deps, sessionId);
    if (!refSpec) return true;

    // 打开选择器那一拍带 `fresh=1`：索引立刻重建一次，之后按 git 指纹重验
    const index = await projectFileIndex(project.id, project.path, {
      fresh: url.searchParams.get('fresh') === '1',
    });
    const q = url.searchParams.get('q') ?? '';
    const dir = (url.searchParams.get('dir') ?? '').replace(/^\/+|\/+$/g, '');
    const limit = clampLimit(url.searchParams.get('limit'));
    const toEntry = (p: string, kind: 'file' | 'dir', ranges?: [number, number][]) => ({
      path: p,
      name: p.slice(p.lastIndexOf('/') + 1),
      kind,
      ref: refSpec.expression({ path: p, kind }),
      ...(ranges ? { ranges } : {}),
    });

    // 搜索模式：`dir` 子树内按名字模糊匹配，不带 size/mtime（100 条 stat 每键一次太贵）
    if (q.trim()) {
      const { hits, total, capped } = await matchPaths(index, q, limit, dir);
      sendJson(res, 200, {
        root: project.path,
        dir,
        total,
        capped,
        truncated: index.truncated,
        entries: hits.map((h) => toEntry(h.path, h.kind, h.ranges)),
      });
      return true;
    }

    // 目录浏览模式：直接子项，文件补 size/mtime（≤200 条，一次并行 stat）
    const children = listDirOf(index, dir);
    const entries = await Promise.all(
      children.slice(0, limit).map(async (c) => {
        const base = toEntry(c.path, c.kind);
        if (c.kind !== 'file') return base;
        try {
          const s = await stat(path.join(project.path, c.path));
          return { ...base, size: s.size, mtime: s.mtime.toISOString() };
        } catch {
          return base;
        }
      }),
    );
    sendJson(res, 200, {
      root: project.path,
      dir,
      total: children.length,
      capped: false,
      truncated: index.truncated,
      entries,
    });
    return true;
  }

  // ---- 路径引用的表达式：带行区间时由这里现算（前端不拼 `#L` 这类文法） ----
  const refMatch = pathname.match(/^\/sessions\/([^/]+)\/ref$/);
  if (refMatch && req.method === 'GET') {
    const sessionId = decodeURIComponent(refMatch[1]!);
    if (!projectOfSession(res, deps, sessionId)) return true;
    const refSpec = pathRefSpecOf(res, deps, sessionId);
    if (!refSpec) return true;
    const relPath = (url.searchParams.get('path') ?? '').replace(/^\/+|\/+$/g, '');
    if (!relPath) {
      sendJson(res, 400, { error: 'Missing "path" query parameter' });
      return true;
    }
    const kind = url.searchParams.get('kind') === 'dir' ? 'dir' : 'file';
    if (!refSpec.kinds.includes(kind)) {
      sendJson(res, 409, { error: `Harness does not accept "${kind}" references` });
      return true;
    }
    const start = lineOf(url.searchParams.get('start'));
    const end = lineOf(url.searchParams.get('end'));
    if (!refSpec.lines) {
      sendJson(res, 200, { ref: refSpec.expression({ path: relPath, kind }) });
      return true;
    }
    if (start == null) {
      sendJson(res, 200, { ref: refSpec.expression({ path: relPath, kind }) });
      return true;
    }
    if (end != null && end < start) {
      sendJson(res, 400, { error: '"end" must not precede "start"' });
      return true;
    }
    sendJson(res, 200, {
      ref: refSpec.expression({ path: relPath, kind, lines: { start, end: end ?? start } }),
    });
    return true;
  }

  // ---- 反向认引用：一段现成文本里的表达式还原成「路径 + 类型 + 行区间」 ----
  // 粘贴 / 取回队列消息时前端要把 `@src/a.ts#L3-5` 摆成胶囊，而语法是 harness 知识：
  // 文法由 `recognize` 认、存在性由文件索引判（索引里没有的路径不算引用），
  // web 只拿到「哪一段、换成什么胶囊」。
  const recognizeMatch = pathname.match(/^\/sessions\/([^/]+)\/refs\/recognize$/);
  if (recognizeMatch && req.method === 'POST') {
    const sessionId = decodeURIComponent(recognizeMatch[1]!);
    const project = projectOfSession(res, deps, sessionId);
    if (!project) return true;
    const refSpec = pathRefSpecOf(res, deps, sessionId);
    if (!refSpec) return true;
    let text = '';
    try {
      const body = (await readJson(req)) as { text?: unknown };
      text = typeof body?.text === 'string' ? body.text : '';
    } catch {
      sendJson(res, 400, { error: 'Body must be JSON' });
      return true;
    }
    const index = await projectFileIndex(project.id, project.path);
    const refs: {
      start: number;
      end: number;
      ref: string;
      path: string;
      kind: 'file' | 'dir';
      lines?: { start: number; end: number };
    }[] = [];
    for (const hit of refSpec.recognize(text)) {
      // 索引里真有这条路径才算引用（否则 `@types/node` 这类字样也会变胶囊）
      const kind =
        hit.kind === 'dir' && hasPath(index.dirs, hit.path)
          ? 'dir'
          : hasPath(index.files, hit.path)
            ? 'file'
            : null;
      if (!kind || !refSpec.kinds.includes(kind)) continue;
      const lines = hit.lines && refSpec.lines ? hit.lines : undefined;
      refs.push({
        start: hit.start,
        end: hit.end,
        // 归一：`@docs` 与 `@docs/` 都摆成文法那种形状
        ref: refSpec.expression({ path: hit.path, kind, ...(lines ? { lines } : {}) }),
        path: hit.path,
        kind,
        ...(lines ? { lines } : {}),
      });
    }
    sendJson(res, 200, { refs });
    return true;
  }

  // ---- 路径引用的预览：项目根内的只读字节流 ----
  // 与 `/projects/:id/file` 分开：那条只认资产白名单（`.claude/` 等），预览要读源码。
  // 这里的收窄 = 项目根 containment + 大小上限 + Content-Type 白名单（非图一律
  // text/plain——绝不下发 text/html，否则等于把 dashboard origin 交给任意项目文件）。
  const fileMatch = pathname.match(/^\/sessions\/([^/]+)\/file$/);
  if (fileMatch && req.method === 'GET') {
    const sessionId = decodeURIComponent(fileMatch[1]!);
    const project = projectOfSession(res, deps, sessionId);
    if (!project) return true;
    const relPath = url.searchParams.get('path');
    if (!relPath) {
      sendJson(res, 400, { error: 'Missing "path" query parameter' });
      return true;
    }
    let abs: string;
    try {
      abs = resolveWithinProject(project.path, relPath);
    } catch {
      sendJson(res, 403, { error: 'Path escapes the project' });
      return true;
    }
    let info;
    try {
      info = await stat(abs);
    } catch {
      sendJson(res, 404, { error: 'File not found' });
      return true;
    }
    if (!info.isFile()) {
      sendJson(res, 404, { error: 'Not a file' });
      return true;
    }
    if (info.size > PREVIEW_MAX_BYTES) {
      sendJson(res, 413, { error: 'File too large to preview' });
      return true;
    }
    const image = imageTypeOf(relPath);
    let bytes = await readFile(abs);
    if (!image) {
      // 二进制（NUL 打头那种）不给编辑器：CM 渲出来是一片乱码占位符，不如明说没有预览
      if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        sendJson(res, 415, { error: 'Binary file' });
        return true;
      }
      // 文本按上限截断，且切在行边界上——切在半个字符里会让整段变成替换符
      if (bytes.length > PREVIEW_MAX_TEXT_BYTES) {
        const cut = bytes.subarray(0, PREVIEW_MAX_TEXT_BYTES);
        const nl = cut.lastIndexOf(10);
        bytes = nl > 0 ? cut.subarray(0, nl) : cut;
        res.setHeader('x-weave-truncated', '1');
      }
    }
    res.writeHead(200, {
      'content-type': image ?? 'text/plain; charset=utf-8',
      'content-length': String(bytes.length),
      'cache-control': 'private, max-age=60',
    });
    res.end(bytes);
    return true;
  }

  return false;
}
