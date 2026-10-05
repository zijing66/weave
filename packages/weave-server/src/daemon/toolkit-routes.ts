import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { WeaveServerDeps } from './server.js';
import { readJson, sendJson } from './http.js';
import { ToolkitError } from '../hooks/toolkit.js';

/**
 * 批 10 工具包路由（范式同 hooks-routes）：
 *   GET  /projects/:id/toolkit                        — 包清单 + 启用态 + 外置目录 + 旧副本
 *   POST /projects/:id/toolkit/:packId/enable|disable — 幂等开关，返回后置状态
 *   POST /projects/:id/toolkit/legacy-copies/cleanup  — 幂等清理项目插件位旧副本（批 3）
 *   GET  /toolkit/dirs                                — 外置目录 / 索引源
 *   POST /toolkit/dirs                                — add-dir 注册
 *   POST /toolkit/dirs/remove                         — remove-dir + 级联卸载
 * 返回 false 表示未命中，主链继续分发。
 */

const DirBody = z.object({ path: z.string().min(1) });

export async function handleToolkitRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
  url: URL,
  isAuthed: boolean,
): Promise<boolean> {
  if (!pathname.includes('/toolkit')) return false;

  if (!isAuthed) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }
  if (!deps.toolkit) {
    sendJson(res, 503, { error: 'Toolkit unavailable' });
    return true;
  }

  const fail = (err: unknown): void => {
    if (err instanceof ToolkitError) {
      sendJson(res, err.code === 'not-found' ? 404 : 400, { error: err.message, code: err.code });
      return;
    }
    sendJson(res, 400, { error: err instanceof Error ? err.message : 'Toolkit operation failed' });
  };

  // ---- 包清单 ----
  const listMatch = pathname.match(/^\/projects\/(\d+)\/toolkit$/);
  if (listMatch) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }
    try {
      sendJson(res, 200, await deps.toolkit.list(Number(listMatch[1])));
    } catch (err) {
      fail(err);
    }
    return true;
  }

  // ---- 启用 / 禁用（幂等，返回后置状态；?source= 消歧同 id 多来源）----
  const toggleMatch = pathname.match(/^\/projects\/(\d+)\/toolkit\/([^/]+)\/(enable|disable)$/);
  if (toggleMatch) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }
    const projectId = Number(toggleMatch[1]);
    const packId = decodeURIComponent(toggleMatch[2]!);
    const enable = toggleMatch[3] === 'enable';
    const source = url.searchParams.get('source');
    try {
      const result = enable
        ? await deps.toolkit.enable(projectId, packId, source ?? undefined)
        : await deps.toolkit.disable(projectId, packId, source ?? undefined);
      sendJson(res, 200, result);
    } catch (err) {
      fail(err);
    }
    return true;
  }

  // ---- 项目插件位旧副本清理（幂等；宿主不加载，安全）----
  const cleanupMatch = pathname.match(/^\/projects\/(\d+)\/toolkit\/legacy-copies\/cleanup$/);
  if (cleanupMatch) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }
    try {
      sendJson(res, 200, await deps.toolkit.cleanupLegacyCopies(Number(cleanupMatch[1])));
    } catch (err) {
      fail(err);
    }
    return true;
  }

  // ---- 外置目录管理 ----
  if (pathname === '/toolkit/dirs') {
    if (req.method === 'GET') {
      try {
        const { dirs, indexes } = await deps.toolkit.listDirs();
        sendJson(res, 200, { dirs, indexes });
      } catch (err) {
        fail(err);
      }
      return true;
    }
    if (req.method === 'POST') {
      try {
        const body = DirBody.parse(await readJson(req));
        sendJson(res, 201, await deps.toolkit.addDir(body.path));
      } catch (err) {
        fail(err);
      }
      return true;
    }
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  if (pathname === '/toolkit/dirs/remove') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }
    try {
      const body = DirBody.parse(await readJson(req));
      sendJson(res, 200, await deps.toolkit.removeDir(body.path));
    } catch (err) {
      fail(err);
    }
    return true;
  }

  return false;
}
