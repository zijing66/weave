import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { UploadRepository, UPLOAD_MAX_BYTES } from '../../repositories/uploads.js';
import { handleHooksRoutes } from '../hooks-routes.js';
import type { WeaveServerDeps } from '../server.js';

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
      path,
      new URL(path, 'http://x'),
    );
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
