import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { handleProjectRoutes } from '../routes/projects.js';
import type { WeaveServerDeps } from '../server.js';

// harness-install-status 真跑 <bin> --version（5s 超时）——模块级安装态缓存也要清
vi.mock('../project-harnesses.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../project-harnesses.js')>()),
  probeBinVersion: vi.fn(async (bin: string) => (bin.includes('claude') ? '2.1.0' : null)),
}));

/**
 * 首启引导卡的两条新路由：POST /projects（dashboard 注册，幂等）与
 * GET /harness-install-status（机器级安装态）。
 */
describe('project register routes', () => {
  let root: string;
  let db: ReturnType<typeof openDatabase>;
  let deps: WeaveServerDeps;

  const call = async (
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
  ): Promise<{ handled: boolean; status: number; body: Record<string, unknown> }> => {
    const req = Readable.from([
      Buffer.from(body === undefined ? '' : JSON.stringify(body)),
    ]) as unknown as IncomingMessage;
    req.method = method;
    let out: unknown = null;
    const res = {
      statusCode: 0,
      setHeader: () => undefined,
      writeHead: (code: number) => {
        res.statusCode = code;
      },
      end: (chunk?: unknown) => {
        out = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
      },
    };
    const url = new URL(path, 'http://x');
    const handled = await handleProjectRoutes(req, res as unknown as ServerResponse, deps, url.pathname);
    return { handled, status: res.statusCode, body: out as Record<string, unknown> };
  };

  beforeEach(() => {
    db = openDatabase(':memory:');
    root = mkdtempSync(join(tmpdir(), 'weave-register-routes-'));
    deps = { projects: new ProjectRepository(db) } as unknown as WeaveServerDeps;
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('POST /projects 注册并回项目行（harnesses 随行）', async () => {
    const dir = join(root, 'proj');
    mkdirSync(dir, { recursive: true });
    const r = await call('/projects', 'POST', { path: dir });
    expect(r.status).toBe(200);
    const row = r.body['project'] as { id: number; path: string; source: string; harnesses: unknown[] };
    expect(row.path.replace(/[\\/]+$/, '')).toBe(dir);
    expect(row.source).toBe('dashboard');
    expect(Array.isArray(row.harnesses)).toBe(true);
  });

  it('幂等：同路径重复注册返回同一行、不换 token', async () => {
    const dir = join(root, 'proj');
    mkdirSync(dir, { recursive: true });
    const first = (await call('/projects', 'POST', { path: dir })).body['project'] as { id: number };
    const second = (await call('/projects', 'POST', { path: dir + '/' })).body['project'] as { id: number };
    expect(second.id).toBe(first.id);
  });

  it('非法请求：相对路径 / 不存在的目录 / 非目录 一律 400', async () => {
    expect((await call('/projects', 'POST', { path: 'relative/path' })).status).toBe(400);
    expect((await call('/projects', 'POST', { path: join(root, 'nope') })).status).toBe(400);
    const file = join(root, 'f.txt');
    writeFileSync(file, 'x', 'utf8');
    expect((await call('/projects', 'POST', { path: file })).status).toBe(400);
  });

  it('GET /harness-install-status：每 harness 一行，桩版本进 installed/version', async () => {
    const r = await call('/harness-install-status', 'GET');
    expect(r.status).toBe(200);
    const status = r.body['status'] as Array<{ harness: string; installed: boolean; version: string | null }>;
    expect(status.length).toBeGreaterThanOrEqual(2);
    const claude = status.find((s) => s.harness === 'claude')!;
    expect(claude.installed).toBe(true);
    expect(claude.version).toBe('2.1.0');
  });
});
