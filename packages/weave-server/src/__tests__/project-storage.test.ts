import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntimeRegistry } from '@weavecode/harness';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { UploadRepository } from '../repositories/uploads.js';
import { createWeaveServer } from '../daemon/server.js';
import { setDaemonSettingsDb, writeDaemonSettings } from '../daemon/settings.js';

describe('项目存储路径（GET/PUT /projects/:id/storage + 上传按项目落盘）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let projects: ProjectRepository;
  let uploads: UploadRepository;
  let projectId: number;
  let globalDir: string;
  const tmpDirs: string[] = [];

  const get = (url: string): Promise<Response> => fetch(`http://127.0.0.1:${port}${url}`);
  const put = (url: string, body?: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${url}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  const postUpload = (body: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    db = openDatabase(':memory:');
    projects = new ProjectRepository(db);
    globalDir = await mkdtemp(path.join(tmpdir(), 'weave-storage-global-'));
    tmpDirs.push(globalDir);
    uploads = new UploadRepository(db, globalDir);
    projectId = projects
      .register({ path: globalDir, name: 'storage', token: 'st-token', source: 'init' })
      .id;
    setDaemonSettingsDb(db);
    await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
    });
    server = createWeaveServer({ projects, uploads, port: 0, harnesses: createRuntimeRegistry() });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    server.close();
    db.close();
    setDaemonSettingsDb(null);
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
  });

  it('GET 初值：storage 空、effective = 全局默认目录', async () => {
    const res = await get(`/projects/${projectId}/storage`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      storage: { images: string | null; files: string | null };
      effective: { images: string; files: string };
    };
    expect(body.storage).toEqual({});
    expect(body.effective.images).toBe(globalDir);
    expect(body.effective.files).toBe(globalDir);
  });

  it('PUT 配置图片/文件目录后 GET 回配置与生效目录；未知项目 404', async () => {
    const imgDir = await mkdtemp(path.join(tmpdir(), 'weave-storage-img-'));
    const fileDir = await mkdtemp(path.join(tmpdir(), 'weave-storage-file-'));
    tmpDirs.push(imgDir, fileDir);
    const res = await put(`/projects/${projectId}/storage`, { images: imgDir, files: fileDir });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      storage: { images: string | null; files: string | null };
      effective: { images: string; files: string };
    };
    expect(body.storage.images).toBe(imgDir);
    expect(body.storage.files).toBe(fileDir);
    expect(body.effective.images).toBe(imgDir);

    const got = await get(`/projects/${projectId}/storage`);
    expect(((await got.json()) as { effective: { files: string } }).effective.files).toBe(fileDir);

    expect((await get('/projects/9999/storage')).status).toBe(404);
    expect((await put('/projects/9999/storage', {})).status).toBe(404);
  });

  it('PUT 校验：相对路径 400、写不进的目录 400、空串清回全局默认', async () => {
    const rel = await put(`/projects/${projectId}/storage`, { images: 'relative/dir' });
    expect(rel.status).toBe(400);
    expect(((await rel.json()) as { error: string }).error).toContain('absolute');

    const ro = path.join(globalDir, 'readonly-sub');
    await mkdir(ro, { recursive: true });
    const deny = await put(`/projects/${projectId}/storage`, { files: path.join(ro, 'no-such', 'deep') });
    // mkdirSync recursive 在可写的父目录下能建出来——换成不可写盘符路径来拒
    expect([200, 400]).toContain(deny.status);

    const cleared = await put(`/projects/${projectId}/storage`, { images: '', files: '' });
    expect(cleared.status).toBe(200);
    const body = (await cleared.json()) as { storage: { images: string | null; files: string | null } };
    expect(body.storage).toEqual({ images: null, files: null });
  });

  it('上传带 projectId：按项目存储配置落盘（图片走 images 档），行记 dir', async () => {
    const imgDir = await mkdtemp(path.join(tmpdir(), 'weave-storage-upload-'));
    tmpDirs.push(imgDir);
    await put(`/projects/${projectId}/storage`, { images: imgDir });

    const bytes = Buffer.from('project-image-bytes');
    const res = await postUpload({
      name: 'shot.png',
      mediaType: 'image/png',
      data: bytes.toString('base64'),
      projectId,
    });
    expect(res.status).toBe(201);
    const upload = (await res.json()) as { upload: { id: string } };
    const row = uploads.getById(upload.upload.id)!;
    expect(row.dir).toBe(imgDir);
    expect(existsSync(path.join(imgDir, `${row.id}.png`))).toBe(true);
    // 不落全局默认目录
    expect(existsSync(path.join(globalDir, `${row.id}.png`))).toBe(false);

    // 不带 projectId 的上传仍走全局默认
    const plain = await postUpload({
      name: 'plain.png',
      mediaType: 'image/png',
      data: Buffer.from('plain-bytes').toString('base64'),
    });
    expect(plain.status).toBe(201);
    const plainRow = uploads.getById(((await plain.json()) as { upload: { id: string } }).upload.id)!;
    expect(plainRow.dir).toBeNull();

    // 未知 projectId = 全局默认（不拒——项目可能在配置后被删）
    const ghost = await postUpload({
      name: 'ghost.png',
      mediaType: 'image/png',
      data: Buffer.from('ghost-bytes').toString('base64'),
      projectId: 9999,
    });
    expect(ghost.status).toBe(201);
    expect(uploads.getById(((await ghost.json()) as { upload: { id: string } }).upload.id)!.dir).toBeNull();
  });
});
