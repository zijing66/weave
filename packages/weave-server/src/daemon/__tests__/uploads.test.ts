import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { UploadRepository, UPLOAD_MAX_BYTES } from '../../repositories/uploads.js';

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

  it('不同字节各占一行', () => {
    const a = uploads.save({ name: 'x.png', mediaType: 'image/png', bytes: randomBytes(16) });
    const b = uploads.save({ name: 'y.png', mediaType: 'image/png', bytes: randomBytes(16) });
    expect(a.id).not.toBe(b.id);
  });
});
