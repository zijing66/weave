import { createReadStream } from 'node:fs';
import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WeaveServerDeps } from '../server.js';
import { readJson, readRawBody, sendJson } from '../http.js';
import { isImageMediaType, maxUploadBytes, type UploadRow } from '../../repositories/uploads.js';
import { defaultUploadSessions } from '../upload-sessions.js';
import type { ProjectStorage } from './projects.js';

const UploadBody = z.object({
  name: z.string().min(1).max(200),
  mediaType: z.string().min(1).max(100),
  /** base64（无 data: 前缀）；字节数以解码后计。 */
  data: z.string().min(1),
  /** 所属项目：给了就按项目存储配置解析落盘目录（图片/文件各一档）。 */
  projectId: z.number().int().positive().optional(),
});

const UploadBeginBody = z.object({
  name: z.string().min(1).max(200),
  mediaType: z.string().min(1).max(100),
  size: z.number().int().positive(),
  projectId: z.number().int().positive().optional(),
});

/** 项目存储配置里这个上传件该落哪档：图片走 images、其余走 files。 */
function storageDirOf(storage: ProjectStorage | null | undefined, mediaType: string): string | null {
  return (isImageMediaType(mediaType) ? storage?.images : storage?.files) ?? null;
}

/** 分块上限：一块 16MB，够大（大文件几百块）又不至于把内存顶爆。 */
const UPLOAD_CHUNK_MAX_BYTES = 16 * 1024 * 1024;

/**
 * 上传件出参。`path` = 落盘绝对路径：附件占位胶囊序列化要用它（原文里已含路径的
 * 附件投递时不再重复追加），前端不拼路径、只透传。取图仍走 `/images/<id>`。
 */
function toUploadDto(
  deps: WeaveServerDeps,
  row: UploadRow,
): { id: string; name: string; mediaType: string; size: number; path: string } {
  return {
    id: row.id,
    name: row.name,
    mediaType: row.mediaType,
    size: row.size,
    path: deps.uploads!.filePath(row.id, row.mediaType, row.name, row.dir ?? deps.uploads!.defaultDir),
  };
}

/** 项目上传件落哪：项目不存在/没配 = null（全局默认）；按媒体类型分 images/files 档。 */
function projectUploadDir(
  deps: WeaveServerDeps,
  projectId: number,
  mediaType: string,
): string | null {
  const project = deps.projects.getById(projectId);
  if (!project) return null;
  const meta = deps.projects.getMeta(projectId) as { storage?: ProjectStorage } | null;
  return storageDirOf(meta?.storage, mediaType);
}

/**
 * 上传域路由：分块上传（断点续传 begin → PUT → finish）、一次性上传、
 * 会话附件统计/清理、图片回显。返回 true = 本路由认领；false = 未命中，主链继续。
 */
export async function handleUploadRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
  url: URL,
): Promise<boolean> {
  // ---- 分块上传（断点续传）：begin → 按 offset 顺序 PUT → finish ----
  const uploadSessions = deps.uploadSessions ?? defaultUploadSessions;
  if (pathname === '/uploads/begin' && req.method === 'POST') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    let body: z.infer<typeof UploadBeginBody>;
    try {
      body = UploadBeginBody.parse(await readJson(req));
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
      return true;
    }
    if (body.size > maxUploadBytes(body.mediaType)) {
      sendJson(res, 413, { error: 'File too large' });
      return true;
    }
    const dir = body.projectId ? projectUploadDir(deps, body.projectId, body.mediaType) : null;
    const begun = await uploadSessions.begin({ ...body, dir });
    sendJson(res, 201, { uploadId: begun.id, received: 0, size: begun.size });
    return true;
  }

  const finishMatch = pathname.match(/^\/uploads\/([0-9a-f-]{36})\/finish$/);
  if (finishMatch && req.method === 'POST') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    const info = await uploadSessions.finish(finishMatch[1]!);
    if (!info) {
      sendJson(res, 409, { error: 'Upload incomplete' });
      return true;
    }
    const row = await deps.uploads.adoptFromFile(info);
    await uploadSessions.abort(finishMatch[1]!);
    sendJson(res, 201, { upload: toUploadDto(deps, row) });
    return true;
  }

  const chunkMatch = pathname.match(/^\/uploads\/([0-9a-f-]{36})$/);
  if (chunkMatch) {
    const uploadId = chunkMatch[1]!;
    if (req.method === 'GET') {
      const cur = await uploadSessions.get(uploadId);
      if (!cur) {
        sendJson(res, 404, { error: 'Upload not found' });
        return true;
      }
      sendJson(res, 200, { received: cur.received, size: cur.size, name: cur.name, mediaType: cur.mediaType });
      return true;
    }
    if (req.method === 'PUT') {
      const offset = Number(url.searchParams.get('offset') ?? '');
      if (!Number.isInteger(offset) || offset < 0) {
        sendJson(res, 400, { error: 'Invalid offset' });
        return true;
      }
      const bytes = await readRawBody(req, UPLOAD_CHUNK_MAX_BYTES).catch(() => null);
      if (!bytes) {
        sendJson(res, 413, { error: 'Chunk too large' });
        return true;
      }
      const result = await uploadSessions.append(uploadId, offset, bytes);
      if (result.kind === 'missing') {
        sendJson(res, 404, { error: 'Upload not found' });
        return true;
      }
      if (result.kind === 'conflict') {
        // 客户端拿着旧偏移：把真实长度回给它，从那儿续
        sendJson(res, 409, { received: result.received });
        return true;
      }
      if (result.kind === 'overflow') {
        sendJson(res, 413, { received: result.received, error: 'Exceeds declared size' });
        return true;
      }
      sendJson(res, 200, { received: result.received });
      return true;
    }
    if (req.method === 'DELETE') {
      await uploadSessions.abort(uploadId);
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  // ---- 会话上传件：一次性上传 / 回显（内容寻址 `data/uploads/`；上传 ≠ 投递） ----
  if (pathname === '/uploads' && req.method === 'POST') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    let body: z.infer<typeof UploadBody>;
    try {
      body = UploadBody.parse(await readJson(req));
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
      return true;
    }
    const bytes = Buffer.from(body.data, 'base64');
    if (bytes.length === 0) {
      sendJson(res, 400, { error: 'Empty upload' });
      return true;
    }
    if (bytes.length > maxUploadBytes(body.mediaType)) {
      sendJson(res, 413, { error: 'File too large' });
      return true;
    }
    const row = deps.uploads.save({
      name: body.name,
      mediaType: body.mediaType,
      bytes,
      dir: body.projectId ? projectUploadDir(deps, body.projectId, body.mediaType) : null,
    });
    sendJson(res, 201, { upload: toUploadDto(deps, row) });
    return true;
  }

  // ---- 对话附件存储清理（设置页）：按会话统计/删除 + 无引用件一键清 ----
  const sessionUploadsMatch = pathname.match(/^\/sessions\/([^/]+)\/uploads$/);
  if (sessionUploadsMatch && req.method === 'GET') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    const rows = deps.uploads.uploadsBySession(decodeURIComponent(sessionUploadsMatch[1]!));
    sendJson(res, 200, {
      uploads: (rows ?? []).map((r) => ({ ...toUploadDto(deps, r), createdAt: r.createdAt })),
      totalBytes: (rows ?? []).reduce((sum, r) => sum + r.size, 0),
    });
    return true;
  }
  if (sessionUploadsMatch && req.method === 'DELETE') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    const rows = deps.uploads.uploadsBySession(decodeURIComponent(sessionUploadsMatch[1]!));
    if (!rows) {
      sendJson(res, 200, { removed: 0, freedBytes: 0 });
      return true;
    }
    const freedBytes = rows.reduce((sum, r) => sum + r.size, 0);
    const removed = deps.uploads.removeMany(rows.map((r) => r.id));
    deps.dataBus?.emit({ key: 'sessions' });
    sendJson(res, 200, { removed, freedBytes });
    return true;
  }

  if (pathname === '/uploads/unreferenced' && req.method === 'GET') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    sendJson(res, 200, deps.uploads.unreferencedStats());
    return true;
  }
  // ---- 存储总览（微信式清理面头部）：总/图/文件/被引用/可安全清五档一次聚合 ----
  if (pathname === '/uploads/overview' && req.method === 'GET') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    sendJson(res, 200, deps.uploads.overview());
    return true;
  }
  // ---- 按 ids 批量删（单件/分组勾选清的落点）：只删行里存在的，文件尽力删 ----
  const removeBody = z.object({ ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(500) });
  if (pathname === '/uploads/remove' && req.method === 'POST') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    let body: z.infer<typeof removeBody>;
    try {
      body = removeBody.parse(await readJson(req));
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
      return true;
    }
    const removed = deps.uploads.removeMany(body.ids);
    deps.dataBus?.emit({ key: 'sessions' });
    sendJson(res, 200, { removed });
    return true;
  }
  if (pathname === '/uploads/usage' && req.method === 'GET') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    sendJson(res, 200, { sessions: deps.uploads.usageBySession() });
    return true;
  }
  if (pathname === '/uploads/unreferenced' && req.method === 'POST') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    // 逐条回调只是给响应攒进度快照——HTTP 应答是一次性的，进度条由前端按
    // 「已清 / 预告数」自行推进，这里最后只报总数。
    let last = { done: 0, total: 0 };
    const removed = deps.uploads.cleanupUnreferenced((done, total) => {
      last = { done, total };
    });
    deps.dataBus?.emit({ key: 'sessions' });
    sendJson(res, 200, { removed, ...last });
    return true;
  }

  const imageMatch = pathname.match(/^\/images\/([a-f0-9]{64})$/);
  if (imageMatch && req.method === 'GET') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    const file = deps.uploads.fileStatOf(imageMatch[1]!);
    if (!file) {
      sendJson(res, 404, { error: 'Image not found' });
      return true;
    }
    // 内容寻址（id = sha256）→ 永不改写，可长缓存。流式回显：512MB 的附件
    // 不整份进内存，管道直灌（content-length 取 stat，不读内容）。
    res.writeHead(200, {
      'content-type': file.row.mediaType,
      'content-length': String(file.size),
      'cache-control': 'private, max-age=31536000, immutable',
    });
    const stream = createReadStream(file.file);
    stream.on('error', () => {
      if (typeof (res as { destroy?: unknown }).destroy === 'function') res.destroy();
    });
    stream.pipe(res);
    return true;
  }

  return false;
}
