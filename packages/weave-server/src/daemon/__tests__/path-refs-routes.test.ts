import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { handleHooksRoutes } from '../hooks-routes.js';
import { clearFileIndexCache } from '../project-files.js';
import type { WeaveServerDeps } from '../server.js';

/**
 * 路径引用的三条路由：`GET /sessions/:id/files`（列表 + 服务端算好的表达式）、
 * `GET /sessions/:id/ref`（带行区间时现算表达式）与 `GET /sessions/:id/file`
 * （预览字节流）。重点不是「能取到」，而是**越界的一律拒不**、以及表达式只在
 * 服务端产出。
 */
describe('路径引用路由', () => {
  let db: ReturnType<typeof openDatabase>;
  let root: string;
  let projectPath: string;
  let deps: WeaveServerDeps;

  const call = async (
    path: string,
    body?: unknown,
  ): Promise<{ handled: boolean; status: number; body: unknown; headers: Record<string, string> }> => {
    const req = Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body))]) as unknown as IncomingMessage;
    req.method = body === undefined ? 'GET' : 'POST';
    let bodyOut: unknown = null;
    const headers: Record<string, string> = {};
    const res = {
      statusCode: 0,
      setHeader: (k: string, v: string) => {
        headers[k.toLowerCase()] = v;
      },
      writeHead: (code: number, hdrs?: Record<string, string>) => {
        res.statusCode = code;
        for (const [k, v] of Object.entries(hdrs ?? {})) headers[k.toLowerCase()] = v;
      },
      end: (chunk?: unknown) => {
        bodyOut = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
      },
    };
    // 第 4 个参数是**不带查询串**的 pathname（路由器按它匹配），查询串在第 5 个
    const url = new URL(path, 'http://x');
    const handled = await handleHooksRoutes(
      req,
      res as unknown as ServerResponse,
      deps,
      url.pathname,
      url,
    );
    return { handled, status: res.statusCode, body: bodyOut, headers };
  };

  const registerSession = (source: string): void => {
    const project = new ProjectRepository(db).register({
      path: projectPath,
      name: 'p',
      token: 'tok',
      source: 'init',
    });
    new SessionRepository(db).touch('sess', project.id);
    new HookEventRepository(db).insert({
      projectId: project.id,
      source,
      eventType: 'SessionStart',
      sessionId: 'sess',
      payload: '{}',
    });
  };

  beforeEach(() => {
    db = openDatabase(':memory:');
    root = mkdtempSync(join(tmpdir(), 'weave-paths-'));
    projectPath = join(root, 'proj');
    mkdirSync(join(projectPath, 'src'), { recursive: true });
    writeFileSync(join(projectPath, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(projectPath, 'page.html'), '<script>alert(1)</script>');
    deps = {
      projects: new ProjectRepository(db),
      hookSessions: new SessionRepository(db),
      hookEvents: new HookEventRepository(db),
    } as unknown as WeaveServerDeps;
    clearFileIndexCache();
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('① 列表：表达式由服务端按 harness 文法算好（web 不自拼）', async () => {
    registerSession('claude');
    const hit = await call('/sessions/sess/files?dir=src');
    expect(hit.handled).toBe(true);
    expect(hit.status).toBe(200);
    const body = hit.body as { entries: { path: string; kind: string; ref: string }[] };
    expect(body.entries).toEqual([
      { path: 'src/a.ts', name: 'a.ts', kind: 'file', ref: '@src/a.ts', size: 20, mtime: expect.any(String) },
    ]);
  });

  it('② 目录带尾斜杠引用（宿主里手敲的惯例形状）', async () => {
    registerSession('claude');
    const hit = await call('/sessions/sess/files');
    const body = hit.body as { entries: { path: string; kind: string; ref: string }[] };
    const dir = body.entries.find((e) => e.path === 'src')!;
    expect(dir.ref).toBe('@src/');
  });

  it('③ 搜索模式带上命中区间（前端拿来上色）', async () => {
    registerSession('claude');
    const hit = await call('/sessions/sess/files?q=a.ts');
    const body = hit.body as { entries: { path: string; ranges?: [number, number][] }[] };
    expect(body.entries[0]!.path).toBe('src/a.ts');
    expect(body.entries[0]!.ranges).toBeDefined();
  });

  it('④ harness 没有路径文法（codex）= 409 并带上能力面的理由', async () => {
    registerSession('codex');
    const hit = await call('/sessions/sess/files');
    expect(hit.status).toBe(409);
    expect((hit.body as { error: string }).error).toMatch(/Codex/);
  });

  it('⑤ 预览：非图一律 text/plain（绝不下发 text/html 把 origin 交出去）', async () => {
    registerSession('claude');
    const hit = await call('/sessions/sess/file?path=page.html');
    expect(hit.status).toBe(200);
    expect(hit.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(String(hit.body)).toContain('<script>');
  });

  it('⑥ 越界路径 403：绝对路径、.. 都拒', async () => {
    registerSession('claude');
    expect((await call('/sessions/sess/file?path=../outside.txt')).status).toBe(403);
    expect((await call(`/sessions/sess/file?path=${encodeURIComponent('D:/Windows/win.ini')}`)).status).toBe(403);
  });

  it('⑦ 不存在 404、缺参数 400、目录 404', async () => {
    registerSession('claude');
    expect((await call('/sessions/sess/file?path=src/nope.ts')).status).toBe(404);
    expect((await call('/sessions/sess/file')).status).toBe(400);
    expect((await call('/sessions/sess/file?path=src')).status).toBe(404);
  });

  it('⑧ 会话不存在 404（不是漏到主链）', async () => {
    const hit = await call('/sessions/unknown/files');
    expect(hit.handled).toBe(true);
    expect(hit.status).toBe(404);
  });

  it('⑨ 行引用：带行区间由服务端现算（单行 / 区间 / 不带 / 目录）', async () => {
    registerSession('claude');
    const ref = async (qs: string): Promise<string> =>
      ((await call(`/sessions/sess/ref?${qs}`)).body as { ref: string }).ref;
    expect(await ref('path=src/a.ts&start=12&end=34')).toBe('@src/a.ts#L12-34');
    expect(await ref('path=src/a.ts&start=12')).toBe('@src/a.ts#L12');
    expect(await ref('path=src/a.ts&start=12&end=12')).toBe('@src/a.ts#L12');
    expect(await ref('path=src/a.ts')).toBe('@src/a.ts');
    expect(await ref('path=src&kind=dir')).toBe('@src/');
  });

  it('⑩ 行引用的非法入参：倒序 400、缺路径 400、没有文法 409', async () => {
    registerSession('claude');
    expect((await call('/sessions/sess/ref?path=src/a.ts&start=9&end=3')).status).toBe(400);
    expect((await call('/sessions/sess/ref')).status).toBe(400);
    registerSession('codex');
    const hit = await call('/sessions/sess/ref?path=src/a.ts');
    expect(hit.status).toBe(409);
  });

  it('⑪ 二进制（含 NUL）不给编辑器：415', async () => {
    registerSession('claude');
    writeFileSync(join(projectPath, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
    const hit = await call('/sessions/sess/file?path=blob.bin');
    expect(hit.status).toBe(415);
  });

  it('⑫ 能力矩阵带 pathRefLines / pathRefKinds（选择器据它决定摆不摆行号与目录引用）', async () => {
    const hit = await call('/messaging/capabilities');
    const body = hit.body as {
      capabilities: { harness: string; pathRefs: boolean; pathRefLines: boolean; pathRefKinds: string[] }[];
    };
    const claude = body.capabilities.find((c) => c.harness === 'claude')!;
    expect(claude.pathRefs).toBe(true);
    expect(claude.pathRefLines).toBe(true);
    expect(claude.pathRefKinds).toEqual(['file', 'dir']);
    const codex = body.capabilities.find((c) => c.harness === 'codex')!;
    expect(codex.pathRefs).toBe(false);
    expect(codex.pathRefKinds).toEqual([]);
  });

  it('⑬ 反向认引用：只认文法、存在性由索引判（索引里没有的不变胶囊）', async () => {
    registerSession('claude');
    const text = '看 @src/a.ts#L3-5 这处，还有 @src/nope.ts 与 @src/ 都行，别碰 foo@bar.com';
    const hit = await call('/sessions/sess/refs/recognize', { text });
    expect(hit.handled).toBe(true);
    expect(hit.status).toBe(200);
    const body = hit.body as {
      refs: { start: number; end: number; ref: string; path: string; kind: string; lines?: object }[];
    };
    expect(body.refs.map(({ start, end, ...rest }) => rest)).toEqual([
      { ref: '@src/a.ts#L3-5', path: 'src/a.ts', kind: 'file', lines: { start: 3, end: 5 } },
      // 文法是文件形、索引说它是目录 → 归一成目录表达式
      { ref: '@src/', path: 'src', kind: 'dir' },
    ]);
    // 区间覆盖的正是原文那一段（前端按它切文本）
    for (const r of body.refs) expect(text.slice(r.start, r.end)).toBe(r.ref);
    // 前后粘着别的字的不算引用（服务端与输入框那条 `@` 判据同一套）
    expect((await call('/sessions/sess/refs/recognize', { text: '看@src/a.ts' })).body).toEqual({ refs: [] });
  });

  it('⑭ 反向认引用：坏 body 400、没有文法 409', async () => {
    registerSession('claude');
    const bad = Readable.from([Buffer.from('not json')]) as unknown as IncomingMessage;
    bad.method = 'POST';
    const res = { statusCode: 0, setHeader: () => {}, writeHead: () => {}, end: () => {} };
    const handled = await handleHooksRoutes(
      bad,
      res as unknown as ServerResponse,
      deps,
      '/sessions/sess/refs/recognize',
      new URL('http://x/sessions/sess/refs/recognize'),
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);

    registerSession('codex');
    expect((await call('/sessions/sess/refs/recognize', { text: '@src/a.ts' })).status).toBe(409);
  });
});
