import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { AuthService, LOCAL_TOKEN_HEADER, SESSION_COOKIE } from '../daemon/dashboard-auth.js';
import { createWeaveServer } from '../daemon/server.js';

/** 装 auth 的 server：门、登录、本机令牌、改密轮换的端到端口径。 */
describe('daemon auth gate', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let auth: AuthService;
  let dir: string;

  const url = (p: string): string => `http://127.0.0.1:${port}${p}`;
  const json = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    dir = mkdtempSync(path.join(tmpdir(), 'weave-auth-srv-'));
    projects.register({ path: dir, name: 'test', token: 'ptoken', source: 'init' });
    auth = new AuthService({
      authPath: path.join(dir, 'auth.json'),
      initialPasswordPath: path.join(dir, 'initial-password'),
    });
    server = createWeaveServer({ projects, port: 0, auth });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('/health 与 /auth/status 未认证可访问', async () => {
    const health = await fetch(url('/health'));
    expect(health.status).toBe(200);
    const status = await fetch(url('/auth/status'));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ passwordSet: true, authenticated: false });
  });

  it('无凭据的 API 调用 401', async () => {
    const res = await fetch(url('/projects'));
    expect(res.status).toBe(401);
  });

  it('HTML 导航（SPA 外壳/登录页）不受门拦截', async () => {
    const res = await fetch(url('/projects'), { headers: { accept: 'text/html' } });
    expect(res.status).not.toBe(401);
  });

  it('登录：错口令 401；对口令发会话 cookie 并放行', async () => {
    const bad = await fetch(url('/auth/login'), json({ password: 'wrong-password' }));
    expect(bad.status).toBe(401);

    const ok = await fetch(url('/auth/login'), json({ password: auth.initialPassword }));
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);

    const authed = await fetch(url('/projects'), {
      headers: { cookie: setCookie.split(';')[0]! },
    });
    expect(authed.status).toBe(200);
  });

  it('本机令牌头放行（CLI / hooks 通道）', async () => {
    const res = await fetch(url('/projects'), {
      headers: { [LOCAL_TOKEN_HEADER]: auth.getLocalToken() },
    });
    expect(res.status).toBe(200);
  });

  it('改密轮换：旧 cookie 失效、新口令可登录', async () => {
    const before = await fetch(url('/auth/login'), json({ password: auth.initialPassword }));
    const oldCookie = (before.headers.get('set-cookie') ?? '').split(';')[0]!;

    const put = await fetch(url('/auth/password'), {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        [LOCAL_TOKEN_HEADER]: auth.getLocalToken(),
      },
      body: JSON.stringify({ next: 'brand-new-pw' }),
    });
    expect(put.status).toBe(200);

    const stale = await fetch(url('/projects'), { headers: { cookie: oldCookie } });
    expect(stale.status).toBe(401);

    const relogin = await fetch(url('/auth/login'), json({ password: 'brand-new-pw' }));
    expect(relogin.status).toBe(200);
  });

  it('未认证改密 401；短口令 400', async () => {
    const unauthed = await fetch(url('/auth/password'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ next: 'long-enough-pw' }),
    });
    expect(unauthed.status).toBe(401);

    const short = await fetch(url('/auth/password'), {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        [LOCAL_TOKEN_HEADER]: auth.getLocalToken(),
      },
      body: JSON.stringify({ next: '123' }),
    });
    expect(short.status).toBe(400);
  });

  it('登出清 cookie', async () => {
    const res = await fetch(url('/auth/logout'), { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
  });
});
