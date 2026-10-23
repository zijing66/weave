import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { UploadRepository } from '../../repositories/uploads.js';
import { UploadSessions, UPLOAD_SESSION_MAX_AGE_MS } from '../upload-sessions.js';
import { handleHooksRoutes } from '../hooks-routes.js';
import type { WeaveServerDeps } from '../server.js';

/**
 * 分块上传（断点续传）：`begin → PUT(offset) → finish`。判据都在「偏移对不上就
 * 回真实长度」与「没收到最后一块就不许 finish」这两条上——客户端据此续传，
 * 服务端不猜、不补齐。
 */

describe('UploadSessions', () => {
  let dir: string;
  let sessions: UploadSessions;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-upload-sessions-'));
    sessions = new UploadSessions(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('顺序追加到收完，finish 交出临时件', async () => {
    const s = await sessions.begin({ name: 'a.bin', mediaType: 'application/octet-stream', size: 6 });
    expect(await sessions.append(s.id, 0, Buffer.from('abc'))).toEqual({ kind: 'ok', received: 3 });
    expect(await sessions.append(s.id, 3, Buffer.from('def'))).toEqual({ kind: 'ok', received: 6 });
    const done = await sessions.finish(s.id);
    expect(done?.size).toBe(6);
    expect(existsSync(done!.file)).toBe(true);
  });

  it('偏移对不上 → conflict 回真实长度（客户端从那里续，不用重传）', async () => {
    const s = await sessions.begin({ name: 'a.bin', mediaType: 'application/octet-stream', size: 6 });
    await sessions.append(s.id, 0, Buffer.from('abc'));
    expect(await sessions.append(s.id, 0, Buffer.from('abc'))).toEqual({ kind: 'conflict', received: 3 });
    expect(await sessions.append(s.id, 3, Buffer.from('def'))).toEqual({ kind: 'ok', received: 6 });
  });

  it('超出声明长度 → overflow；没收到最后一块 → finish 给 null', async () => {
    const s = await sessions.begin({ name: 'a.bin', mediaType: 'application/octet-stream', size: 3 });
    expect(await sessions.append(s.id, 0, Buffer.from('abcd'))).toEqual({ kind: 'overflow', received: 0 });
    await sessions.append(s.id, 0, Buffer.from('ab'));
    expect(await sessions.finish(s.id)).toBeNull();
  });

  it('未知 id / 坏 id：不抛、当成没有', async () => {
    expect(await sessions.get('0'.repeat(36))).toBeNull();
    expect(await sessions.get('not-a-uuid')).toBeNull();
    expect(await sessions.append('0'.repeat(36), 0, Buffer.from('x'))).toEqual({ kind: 'missing' });
  });

  it('sweep 只清过期的半截件', async () => {
    const old = await sessions.begin({ name: 'old.bin', mediaType: 'text/plain', size: 9 });
    const fresh = await sessions.begin({ name: 'new.bin', mediaType: 'text/plain', size: 9 });
    const removed = await sessions.sweep(UPLOAD_SESSION_MAX_AGE_MS, Date.now() + UPLOAD_SESSION_MAX_AGE_MS + 1);
    expect(removed).toBe(2);
    expect(await sessions.get(old.id)).toBeNull();
    expect(await sessions.get(fresh.id)).toBeNull();
  });

  it('abort 连元数据一起删（半截件不留孤儿）', async () => {
    const s = await sessions.begin({ name: 'a.bin', mediaType: 'text/plain', size: 9 });
    await sessions.abort(s.id);
    expect(await sessions.get(s.id)).toBeNull();
  });
});

describe('分块上传路由 + adoptFromFile', () => {
  let dir: string;
  let sessions: UploadSessions;
  let uploads: UploadRepository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-upload-chunk-'));
    sessions = new UploadSessions(join(dir, 'tmp'));
    uploads = new UploadRepository(openDatabase(':memory:'), join(dir, 'data'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ handled: boolean; status: number; body: unknown }> => {
    const payload =
      body === undefined
        ? ''
        : Buffer.isBuffer(body)
          ? body
          : JSON.stringify(body);
    const req = Readable.from([Buffer.from(payload)]) as unknown as IncomingMessage;
    req.method = method;
    let out: unknown = null;
    const res = {
      statusCode: 0,
      setHeader: () => {},
      writeHead: (code: number) => {
        res.statusCode = code;
      },
      end: (chunk?: unknown) => {
        out = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
      },
    };
    const handled = await handleHooksRoutes(
      req,
      res as unknown as ServerResponse,
      { uploads, uploadSessions: sessions } as WeaveServerDeps,
      path.split('?')[0]!,
      new URL(path, 'http://x'),
    );
    return { handled, status: res.statusCode, body: out };
  };

  it('begin → PUT → finish：内容寻址落盘，临时件清掉', async () => {
    const bytes = Buffer.from('hello chunked upload');
    const begun = await call('POST', '/uploads/begin', {
      name: 'notes.md',
      mediaType: 'text/markdown',
      size: bytes.length,
    });
    expect(begun.handled).toBe(true);
    expect(begun.status).toBe(201);
    const { uploadId } = begun.body as { uploadId: string };

    const first = await call('PUT', `/uploads/${uploadId}?offset=0`, bytes.subarray(0, 5));
    expect(first).toEqual({ handled: true, status: 200, body: { received: 5 } });
    // 拿着旧偏移再来一次：409 + 真实长度
    const stale = await call('PUT', `/uploads/${uploadId}?offset=0`, bytes.subarray(0, 5));
    expect(stale).toEqual({ handled: true, status: 409, body: { received: 5 } });
    const rest = await call('PUT', `/uploads/${uploadId}?offset=5`, bytes.subarray(5));
    expect(rest).toEqual({ handled: true, status: 200, body: { received: bytes.length } });

    const fin = await call('POST', `/uploads/${uploadId}/finish`);
    expect(fin.handled).toBe(true);
    expect(fin.status).toBe(201);
    const upload = (fin.body as { upload: { id: string; name: string; mediaType: string; size: number } }).upload;
    expect(upload.name).toBe('notes.md');
    expect(upload.mediaType).toBe('text/markdown');
    expect(upload.size).toBe(bytes.length);
    // 正式落点按原后缀（非图不换扩展名），半截件已搬走
    expect(uploads.fileOf(upload.id)?.bytes.equals(bytes)).toBe(true);
    expect(existsSync(join(dir, 'tmp', 'uploads', `${uploadId}.part`))).toBe(false);
  });

  it('没收完就 finish → 409（不假装收完）', async () => {
    const begun = await call('POST', '/uploads/begin', { name: 'a.bin', mediaType: 'text/plain', size: 4 });
    const { uploadId } = begun.body as { uploadId: string };
    await call('PUT', `/uploads/${uploadId}?offset=0`, Buffer.from('ab'));
    const fin = await call('POST', `/uploads/${uploadId}/finish`);
    expect(fin).toEqual({ handled: true, status: 409, body: { error: 'Upload incomplete' } });
  });

  it('GET 回当前进度（续传入口）；DELETE 丢弃', async () => {
    const begun = await call('POST', '/uploads/begin', { name: 'a.bin', mediaType: 'text/plain', size: 4 });
    const { uploadId } = begun.body as { uploadId: string };
    await call('PUT', `/uploads/${uploadId}?offset=0`, Buffer.from('ab'));
    const got = await call('GET', `/uploads/${uploadId}`);
    expect(got.body).toEqual({ received: 2, size: 4, name: 'a.bin', mediaType: 'text/plain' });
    expect((await call('DELETE', `/uploads/${uploadId}`)).status).toBe(200);
    expect((await call('GET', `/uploads/${uploadId}`)).status).toBe(404);
  });

  it('超限在 begin 就拒（413），不先收一兆再报错', async () => {
    const hit = await call('POST', '/uploads/begin', {
      name: 'big.png',
      mediaType: 'image/png',
      size: 10 * 1024 * 1024 + 1,
    });
    expect(hit).toEqual({ handled: true, status: 413, body: { error: 'File too large' } });
  });
});
