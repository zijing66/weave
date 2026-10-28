import type { IncomingMessage, ServerResponse } from 'node:http';
import { isHarness, type Harness } from '@weavecode/core';
import type { PathRefSpec } from '@weavecode/harness';
import type { WeaveServerDeps } from '../server.js';
import { readJson, sendJson } from '../http.js';
import { messagingSurfaceFor } from '../../surfaces.js';
import { projectFileIndex } from '../project-files.js';
import type { ProjectRow } from '../../repositories/projects.js';

/**
 * 路径引用域路由（session 维度）：引用表达式现算、反向认引用。文件数据面
 * （索引浏览/搜索/预览）是项目的，在 project-files.ts；表达式才是会话域——
 * 文法按会话 harness 的能力面取，web 只当不透明字符串。
 */

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

  return false;
}
