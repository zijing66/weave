import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { handleVisualizationRoutes } from '../routes/visualizations.js';
import type { WeaveServerDeps } from '../server.js';

/**
 * 渲染块只读端点：白名单根（家目录派生 + 已注册项目根）内的 .html fragment
 * 才回显；穿越 / 非 html / 超限 / 不存在各有明确状态码。
 */
describe('渲染块 fragment 端点', () => {
  let db: ReturnType<typeof openDatabase>;
  let root: string;
  let projectPath: string;
  let deps: WeaveServerDeps;

  const call = async (qs: string): Promise<{ handled: boolean; status: number; body: unknown }> => {
    const req = Readable.from([]) as unknown as IncomingMessage;
    req.method = 'GET';
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
    const url = new URL(`/visualizations/fragment?${qs}`, 'http://x');
    const handled = await handleVisualizationRoutes(
      req,
      res as unknown as ServerResponse,
      deps,
      url.pathname,
      url,
    );
    return { handled, status: res.statusCode, body: bodyOut };
  };

  beforeEach(() => {
    db = openDatabase(':memory:');
    root = mkdtempSync(join(os.tmpdir(), 'weave-viz-'));
    projectPath = join(root, 'proj');
    mkdirSync(projectPath, { recursive: true });
    new ProjectRepository(db).register({
      path: projectPath,
      name: 'p',
      token: 'tok',
      source: 'init',
    });
    deps = {
      projects: new ProjectRepository(db),
    } as unknown as WeaveServerDeps;
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('项目根内的 .html 回显', async () => {
    const file = join(projectPath, 'chart.html');
    writeFileSync(file, '<div id="x">hi</div>');
    const res = await call(`path=${encodeURIComponent(file)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ html: '<div id="x">hi</div>' });
  });

  it('家目录派生根（~/.claude）内回显', async () => {
    const dir = join(os.homedir(), '.claude', 'weave-viz-test-' + process.pid);
    mkdirSync(dir, { recursive: true });
    try {
      const file = join(dir, 'f.html');
      writeFileSync(file, '<b>x</b>');
      const res = await call(`path=${encodeURIComponent(file)}`);
      expect(res.status).toBe(200);
      expect((res.body as { html: string }).html).toBe('<b>x</b>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('临时目录下的 <tmp>/weave 子目录内回显（整个 %TEMP% 不放行）', async () => {
    const dir = join(os.tmpdir(), 'weave', 'viz-test-' + process.pid);
    mkdirSync(dir, { recursive: true });
    try {
      const file = join(dir, 'f.html');
      writeFileSync(file, '<i>t</i>');
      const res = await call(`path=${encodeURIComponent(file)}`);
      expect(res.status).toBe(200);
      expect((res.body as { html: string }).html).toBe('<i>t</i>');

      // 同盘同前缀的旁支（<tmp>/weave-viz-…）仍在外
      const sibling = join(root, 'sibling.html');
      writeFileSync(sibling, 'x');
      expect((await call(`path=${encodeURIComponent(sibling)}`)).status).toBe(403);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('白名单外 403（文案带根集）', async () => {
    const res = await call(`path=${encodeURIComponent(join(root, 'elsewhere', 'a.html'))}`);
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toContain('allowed roots');
  });

  it('穿越（.. 段逃出项目根）403', async () => {
    const outside = join(root, 'outside.html');
    writeFileSync(outside, 'x');
    const sneaky = join(projectPath, '..', 'outside.html');
    const res = await call(`path=${encodeURIComponent(sneaky)}`);
    // .. 归一后在 root 下但不在项目根内 → 仍 403（项目根才是白名单）
    expect(res.status).toBe(403);
  });

  it('非 .html 403', async () => {
    const file = join(projectPath, 'data.json');
    writeFileSync(file, '{}');
    const res = await call(`path=${encodeURIComponent(file)}`);
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toContain('.html');
  });

  it('不存在 404', async () => {
    const res = await call(`path=${encodeURIComponent(join(projectPath, 'nope.html'))}`);
    expect(res.status).toBe(404);
  });

  it('相对路径 400', async () => {
    const res = await call('path=rel/a.html');
    expect(res.status).toBe(400);
  });

  it('超限 413', async () => {
    const file = join(projectPath, 'big.html');
    writeFileSync(file, 'x'.repeat(1024 * 1024 + 1));
    const res = await call(`path=${encodeURIComponent(file)}`);
    expect(res.status).toBe(413);
  });

  it('非本路由路径不认领', async () => {
    const req = Readable.from([]) as unknown as IncomingMessage;
    req.method = 'GET';
    const res = { statusCode: 0, setHeader: () => {}, writeHead: () => {}, end: () => {} };
    const url = new URL('/visualizations/other', 'http://x');
    const handled = await handleVisualizationRoutes(
      req,
      res as unknown as ServerResponse,
      deps,
      url.pathname,
      url,
    );
    expect(handled).toBe(false);
  });
});
