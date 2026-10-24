import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { UploadRepository, UPLOAD_MAX_BYTES } from '../../repositories/uploads.js';
import { handleHooksRoutes } from '../hooks-routes.js';
import type { WeaveServerDeps } from '../server.js';

describe('UploadRepository 清理面（设置页「对话附件存储」）', () => {
  let db: ReturnType<typeof openDatabase>;
  let dir: string;
  let uploads: UploadRepository;
  let sessionId: string;
  let eventId: number;

  const bytesOf = (fill: string): Buffer => Buffer.from(fill.repeat(8), 'utf8');

  beforeEach(() => {
    db = openDatabase(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'weave-uploads-clean-'));
    uploads = new UploadRepository(db, dir);
    const project = new ProjectRepository(db).register({
      path: join(dir, 'proj'),
      name: 'clean',
      token: 'clean-token',
      source: 'init',
    });
    sessionId = 'sess-clean';
    new SessionRepository(db).touch(sessionId, project.id);
    eventId = new HookEventRepository(db).insert({
      projectId: project.id,
      source: 'claude',
      eventType: 'UserPromptSubmit',
      sessionId,
      payload: '{}',
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('uploadsBySession 去重回该会话的全部随附件；无随附件回 null', () => {
    const a = uploads.save({ name: 'a.png', mediaType: 'image/png', bytes: bytesOf('a') });
    const b = uploads.save({ name: 'b.md', mediaType: 'text/markdown', bytes: bytesOf('b') });
    uploads.linkToEvent(eventId, [a.id, a.id, b.id]);
    const rows = uploads.uploadsBySession(sessionId)!;
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(uploads.uploadsBySession('sess-none')).toBeNull();
  });

  it('removeMany 删文件 + 行；已删的 id 跳过不重复计', () => {
    const a = uploads.save({ name: 'a.png', mediaType: 'image/png', bytes: bytesOf('a') });
    uploads.linkToEvent(eventId, [a.id]);
    expect(uploads.removeMany([a.id])).toBe(1);
    expect(uploads.getById(a.id)).toBeUndefined();
    expect(existsSync(uploads.filePath(a.id, 'image/png'))).toBe(false);
    expect(uploads.removeMany([a.id])).toBe(0);
  });

  it('unreferencedStats 只数过宽限期的无引用件；cleanupUnreferenced 逐条报进度', () => {
    const kept = uploads.save({ name: 'kept.png', mediaType: 'image/png', bytes: bytesOf('k') });
    const orphan = uploads.save({ name: 'orphan.png', mediaType: 'image/png', bytes: bytesOf('o') });
    uploads.linkToEvent(eventId, [kept.id]);
    db.prepare('UPDATE uploads SET created_at = ?').run(new Date(Date.now() - 2 * 60 * 60_000).toISOString());

    expect(uploads.unreferencedStats()).toEqual({ count: 1, bytes: orphan.size });
    const seen: Array<[number, number]> = [];
    expect(uploads.cleanupUnreferenced((done, total) => seen.push([done, total]))).toBe(1);
    expect(seen).toEqual([[1, 1]]);
    expect(uploads.getById(orphan.id)).toBeUndefined();
    expect(uploads.getById(kept.id)).toBeDefined();
  });

  it('宽限期内的无引用件不算可清（报了数就得真能清掉）', () => {
    uploads.save({ name: 'fresh.png', mediaType: 'image/png', bytes: bytesOf('f') });
    expect(uploads.unreferencedStats()).toEqual({ count: 0, bytes: 0 });
    expect(uploads.cleanupUnreferenced(() => {})).toBe(0);
  });

  it('overview 五档一次聚合：图/文件分档、被引用与可安全清互斥', () => {
    const img = uploads.save({ name: 'i.png', mediaType: 'image/png', bytes: bytesOf('i') });
    const file = uploads.save({ name: 'f.md', mediaType: 'text/markdown', bytes: bytesOf('f') });
    const orphan = uploads.save({ name: 'o.png', mediaType: 'image/png', bytes: bytesOf('o') });
    uploads.linkToEvent(eventId, [img.id, file.id]);
    db.prepare('UPDATE uploads SET created_at = ?').run(new Date(Date.now() - 2 * 60 * 60_000).toISOString());

    const o = uploads.overview();
    expect(o.total).toEqual({ count: 3, bytes: img.size + file.size + orphan.size });
    expect(o.images).toEqual({ count: 2, bytes: img.size + orphan.size });
    expect(o.files).toEqual({ count: 1, bytes: file.size });
    expect(o.referenced).toEqual({ count: 2, bytes: img.size + file.size });
    expect(o.unreferenced).toEqual({ count: 1, bytes: orphan.size });
  });

  it('sessionBreakdown 按图/文件分档；无随附件回 null', () => {
    const img = uploads.save({ name: 'i.png', mediaType: 'image/png', bytes: bytesOf('i') });
    const file = uploads.save({ name: 'f.md', mediaType: 'text/markdown', bytes: bytesOf('f') });
    uploads.linkToEvent(eventId, [img.id, file.id]);
    const b = uploads.sessionBreakdown(sessionId)!;
    expect(b.images).toEqual({ count: 1, bytes: img.size });
    expect(b.files).toEqual({ count: 1, bytes: file.size });
    expect(uploads.sessionBreakdown('sess-none')).toBeNull();
  });
});

describe('清理路由（/sessions/:id/uploads 与 /uploads/unreferenced）', () => {
  let dir: string;
  let uploads: UploadRepository;
  let eventId: number;
  let sessionId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-uploads-cleanroute-'));
    const db = openDatabase(':memory:');
    uploads = new UploadRepository(db, join(dir, 'data'));
    const project = new ProjectRepository(db).register({
      path: join(dir, 'proj'),
      name: 'cr',
      token: 'cr-token',
      source: 'init',
    });
    sessionId = 'sess-cr';
    new SessionRepository(db).touch(sessionId, project.id);
    eventId = new HookEventRepository(db).insert({
      projectId: project.id,
      source: 'claude',
      eventType: 'UserPromptSubmit',
      sessionId,
      payload: '{}',
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ handled: boolean; status: number; body: unknown }> => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = Readable.from([Buffer.from(payload)]) as unknown as IncomingMessage;
    req.method = method;
    let bodyOut: unknown = null;
    const res = {
      statusCode: 0,
      setHeader: () => {},
      writeHead: (code: number) => {
        res.statusCode = code;
      },
      end: (chunk?: unknown) => {
        bodyOut = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
      },
    };
    const handled = await handleHooksRoutes(
      req,
      res as unknown as ServerResponse,
      { uploads } as WeaveServerDeps,
      path.split('?')[0]!,
      new URL(path, 'http://x'),
    );
    return { handled, status: res.statusCode, body: bodyOut };
  };

  it('GET 统计 + DELETE 按会话清（无随附件也 200）', async () => {
    const a = uploads.save({ name: 'a.png', mediaType: 'image/png', bytes: Buffer.from('aaaa') });
    const b = uploads.save({ name: 'b.md', mediaType: 'text/markdown', bytes: Buffer.from('bbbbbb') });
    uploads.linkToEvent(eventId, [a.id, b.id]);

    const stats = await call('GET', `/sessions/${encodeURIComponent(sessionId)}/uploads`);
    expect(stats.status).toBe(200);
    expect((stats.body as { totalBytes: number }).totalBytes).toBe(10);

    const del = await call('DELETE', `/sessions/${encodeURIComponent(sessionId)}/uploads`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ removed: 2, freedBytes: 10 });
    expect(uploads.getById(a.id)).toBeUndefined();

    const empty = await call('DELETE', `/sessions/${encodeURIComponent(sessionId)}/uploads`);
    expect(empty.body).toEqual({ removed: 0, freedBytes: 0 });
  });

  it('GET/POST /uploads/unreferenced：预告数与实清数一致', async () => {
    const orphan = uploads.save({ name: 'o.png', mediaType: 'image/png', bytes: Buffer.from('oo') });
    const stats = await call('GET', '/uploads/unreferenced');
    expect(stats.status).toBe(200);
    expect(stats.body).toEqual({ count: 0, bytes: 0 }); // 宽限期内不算
    const post = await call('POST', '/uploads/unreferenced');
    expect(post.body).toEqual({ removed: 0, done: 0, total: 0 });
    expect(uploads.getById(orphan.id)).toBeDefined();
  });

  it('GET /uploads/overview 与 POST /uploads/remove（按 ids 批量删）', async () => {
    const a = uploads.save({ name: 'a.png', mediaType: 'image/png', bytes: Buffer.from('aa') });
    const b = uploads.save({ name: 'b.md', mediaType: 'text/markdown', bytes: Buffer.from('bb') });
    uploads.linkToEvent(eventId, [a.id, b.id]);

    const ov = await call('GET', '/uploads/overview');
    expect(ov.status).toBe(200);
    expect((ov.body as { total: { count: number } }).total.count).toBe(2);

    const bad = await call('POST', '/uploads/remove', { ids: ['zz'] });
    expect(bad.status).toBe(400);

    const del = await call('POST', '/uploads/remove', { ids: [a.id, b.id] });
    expect(del.status).toBe(200);
    expect((del.body as { removed: number }).removed).toBe(2);
    expect(uploads.getById(a.id)).toBeUndefined();
    expect(uploads.getById(b.id)).toBeUndefined();

    const again = await call('POST', '/uploads/remove', { ids: [a.id] });
    expect((again.body as { removed: number }).removed).toBe(0);
  });
});

describe('UploadRepository', () => {
  let db: ReturnType<typeof openDatabase>;
  let dir: string;
  let uploads: UploadRepository;
  let sessionId: string;
  let eventId: number;

  const bytesOf = (fill: string): Buffer => Buffer.from(fill.repeat(8), 'utf8');

  beforeEach(() => {
    db = openDatabase(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'weave-uploads-'));
    uploads = new UploadRepository(db, dir);
    const project = new ProjectRepository(db).register({
      path: join(dir, 'proj'),
      name: 'up',
      token: 'upload-token',
      source: 'init',
    });
    sessionId = 'sess-up';
    new SessionRepository(db).touch(sessionId, project.id);
    eventId = new HookEventRepository(db).insert({
      projectId: project.id,
      source: 'claude',
      eventType: 'UserPromptSubmit',
      sessionId,
      payload: '{}',
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('内容寻址：同字节重复上传只落一份行，id = sha256', () => {
    const bytes = bytesOf('a');
    const a = uploads.save({ name: 'a.png', mediaType: 'image/png', bytes });
    const b = uploads.save({ name: 'renamed.png', mediaType: 'image/png', bytes });
    expect(a.id).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(b.id).toBe(a.id);
    expect(uploads.getById(a.id)?.name).toBe('a.png'); // 首次的名字留下
    expect(existsSync(uploads.filePath(a.id, 'image/png'))).toBe(true);
  });

  it('refsOf 带落盘绝对路径；任一 id 查不到整条返 null', () => {
    const row = uploads.save({ name: 'a.png', mediaType: 'image/png', bytes: bytesOf('b') });
    const refs = uploads.refsOf([row.id]);
    expect(refs).toEqual([
      {
        id: row.id,
        name: 'a.png',
        mediaType: 'image/png',
        path: join(dir, `${row.id}.png`),
      },
    ]);
    expect(uploads.refsOf([row.id, 'f'.repeat(64)])).toBeNull();
    expect(uploads.refsOf([])).toEqual([]);
  });

  it('fileOf 回字节；行在文件不在 = undefined（serve 404）', () => {
    const row = uploads.save({ name: 'c.webp', mediaType: 'image/webp', bytes: bytesOf('c') });
    expect(uploads.fileOf(row.id)?.bytes.equals(bytesOf('c'))).toBe(true);
    rmSync(uploads.filePath(row.id, 'image/webp'));
    expect(uploads.fileOf(row.id)).toBeUndefined();
    expect(uploads.fileOf('0'.repeat(64))).toBeUndefined();
  });

  it('挂到开轮事件上：imagesBySession 逐事件回，重复挂不重复', () => {
    const row = uploads.save({ name: 'd.gif', mediaType: 'image/gif', bytes: bytesOf('d') });
    uploads.linkToEvent(eventId, [row.id, row.id]);
    const map = uploads.imagesBySession(sessionId);
    expect(map.get(eventId)?.map((r) => r.id)).toEqual([row.id]);
    expect(uploads.imagesBySession('sess-unknown').size).toBe(0);
  });

  it('大小上限是常量口径（路由据此拒 413）', () => {
    expect(UPLOAD_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it('孤儿回收：没人引用且过了宽限期的上传件（文件 + 行）清掉，被事件引用的留着', () => {
    const kept = uploads.save({ name: 'kept.png', mediaType: 'image/png', bytes: bytesOf('k') });
    const orphan = uploads.save({ name: 'orphan.png', mediaType: 'image/png', bytes: bytesOf('o') });
    uploads.linkToEvent(eventId, [kept.id]);
    db.prepare('UPDATE uploads SET created_at = ?').run(new Date(Date.now() - 2 * 60 * 60_000).toISOString());

    expect(uploads.pruneUnreferenced()).toBe(1);
    expect(uploads.getById(orphan.id)).toBeUndefined();
    expect(existsSync(uploads.filePath(orphan.id, 'image/png'))).toBe(false);
    expect(uploads.getById(kept.id)).toBeDefined();
    expect(existsSync(uploads.filePath(kept.id, 'image/png'))).toBe(true);
  });

  it('宽限期内的无引用上传件不动（编辑器里选了图、还没发）', () => {
    const fresh = uploads.save({ name: 'staged.png', mediaType: 'image/png', bytes: bytesOf('s') });
    expect(uploads.pruneUnreferenced()).toBe(0);
    expect(uploads.getById(fresh.id)).toBeDefined();
  });

  it('会话事件被清（event_images 级联）后那批图才变孤儿——顺序反过来一条都删不掉', () => {
    const row = uploads.save({ name: 'gone.png', mediaType: 'image/png', bytes: bytesOf('g') });
    uploads.linkToEvent(eventId, [row.id]);
    db.prepare('UPDATE uploads SET created_at = ?').run(new Date(Date.now() - 2 * 60 * 60_000).toISOString());
    expect(uploads.pruneUnreferenced()).toBe(0); // 指针还在
    new HookEventRepository(db).deleteBySession(sessionId);
    expect(uploads.pruneUnreferenced()).toBe(1);
    expect(uploads.getById(row.id)).toBeUndefined();
  });

  it('不同字节各占一行', () => {
    const a = uploads.save({ name: 'x.png', mediaType: 'image/png', bytes: randomBytes(16) });
    const b = uploads.save({ name: 'y.png', mediaType: 'image/png', bytes: randomBytes(16) });
    expect(a.id).not.toBe(b.id);
  });
});

/** 路由可达性：分支写进 hooks-routes 还不够，得进它开头那张**路径认领表**——
 *  表里漏一项，那条路由就永远由主链答 404 Not found。`/uploads` 与 `/images`
 *  实际这么死过（2026-10-17 前端「图片上传失败：Not found」，服务端分支其实
 *  一直在），故这里断言的是 `handled`，不是状态码本身。 */
describe('上传路由可达（handleHooksRoutes 的路径认领表）', () => {
  let dir: string;
  let uploads: UploadRepository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-uploads-route-'));
    uploads = new UploadRepository(openDatabase(':memory:'), dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ handled: boolean; status: number; body: unknown }> => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = Readable.from([Buffer.from(payload)]) as unknown as IncomingMessage;
    req.method = method;
    let bodyOut: unknown = null;
    // /images/:id 现在流式回显（pipe 进 res）：桩要是个能收流的 Writable
    const chunks: Buffer[] = [];
    const res = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk as Buffer);
        cb();
      },
    }) as ServerResponse & { statusCode: number };
    res.statusCode = 0;
    res.setHeader = () => res;
    res.writeHead = (code: number) => {
      res.statusCode = code;
      return res;
    };
    const realEnd = res.end.bind(res);
    res.end = ((chunk?: unknown) => {
      if (typeof chunk === 'string') bodyOut = JSON.parse(chunk);
      else if (chunk !== undefined) bodyOut = chunk;
      realEnd(); // 真正收流：pipe 完成要靠它触发 'finish'
      return res;
    }) as typeof res.end;
    const handled = await handleHooksRoutes(
      req,
      res,
      { uploads } as WeaveServerDeps,
      path,
      new URL(path, 'http://x'),
    );
    // pipe 的流在 handleHooksRoutes 返回后才灌完：等 'finish' 再收字节
    // （JSON 应答走 res.end(chunk)，字节已在 bodyOut；只有流式应答才等 flush）
    if (bodyOut === null) {
      await new Promise<void>((resolve) => {
        if (res.writableFinished) resolve();
        else res.on('finish', () => resolve());
      });
      if (chunks.length > 0) bodyOut = Buffer.concat(chunks);
    }
    return { handled, status: res.statusCode, body: bodyOut };
  };

  it('POST /uploads 由本路由认领并落盘（不是主链 404）', async () => {
    const bytes = Buffer.from('pasted-image');
    const hit = await call('POST', '/uploads', {
      name: 'clip.png',
      mediaType: 'image/png',
      data: bytes.toString('base64'),
    });
    expect(hit.handled).toBe(true);
    expect(hit.status).toBe(201);
    const upload = (hit.body as { upload: { id: string; name: string } }).upload;
    expect(upload.id).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(upload.name).toBe('clip.png');
  });

  it('GET /images/:id 由本路由认领并回字节', async () => {
    const bytes = Buffer.from('thumb-bytes');
    const row = uploads.save({
      name: 't.webp',
      mediaType: 'image/webp',
      bytes,
    });
    const hit = await call('GET', `/images/${row.id}`);
    expect(hit.handled).toBe(true);
    expect(hit.status).toBe(200);
    expect(hit.body).toEqual(bytes);
  });

  it('未知 id 也由本路由答 404（handled=true，不是漏到主链）', async () => {
    const hit = await call('GET', `/images/${'0'.repeat(64)}`);
    expect(hit.handled).toBe(true);
    expect(hit.status).toBe(404);
  });
});
