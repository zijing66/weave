import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VISUALIZATION_PROTOCOL } from '@weavecode/core';
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
    expect(res.body).toEqual({ html: '<div id="x">hi</div>', mtimeMs: expect.any(Number) });
  });

  it('带 mtime 是轮询的条件形：没变只回空壳，变过才搬正文', async () => {
    const file = join(projectPath, 'live.html');
    writeFileSync(file, '<b>v1</b>');
    const first = await call(`path=${encodeURIComponent(file)}`);
    const mtimeMs = (first.body as { mtimeMs: number }).mtimeMs;

    const same = await call(`path=${encodeURIComponent(file)}&mtime=${mtimeMs}`);
    expect(same.status).toBe(200);
    expect(same.body).toEqual({ unchanged: true, mtimeMs });

    // mtime 粒度不靠写入快慢赌一把：直接拨到 5 秒后（平台会截断，以 stat 为准）
    writeFileSync(file, '<b>v2</b>');
    utimesSync(file, new Date(mtimeMs + 5000), new Date(mtimeMs + 5000));
    const changed = await call(`path=${encodeURIComponent(file)}&mtime=${mtimeMs}`);
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ html: '<b>v2</b>' });
    const newer = Math.floor(statSync(file).mtimeMs);
    expect(newer).not.toBe(mtimeMs);
    expect((changed.body as { mtimeMs: number }).mtimeMs).toBe(newer);

    // 坏参数回落成全量（不把 `mtime=abc` 当成「没变」）
    const junk = await call(`path=${encodeURIComponent(file)}&mtime=abc`);
    expect(junk.body).toMatchObject({ html: '<b>v2</b>' });
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
    writeFileSync(file, 'x'.repeat(VISUALIZATION_PROTOCOL.maxFragmentBytes + 1));
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

/**
 * 设置页存储面板的渲染块账目：只有「无对话引用 且 过了宽限期」的才算可清理；
 * 被引用过的、刚写出来的都留着（历史气泡不破图）。
 */
describe('渲染块统计与清理', () => {
  let db: ReturnType<typeof openDatabase>;
  let root: string;
  let vizRoot: string;
  let referenced: string[];
  let deps: WeaveServerDeps;

  const callRoute = async (
    pathname: string,
    method = 'GET',
  ): Promise<{ status: number; body: unknown }> => {
    const req = Readable.from([]) as unknown as IncomingMessage;
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
    const url = new URL(pathname, 'http://x');
    await handleVisualizationRoutes(req, res as unknown as ServerResponse, deps, url.pathname, url);
    return { status: res.statusCode, body: bodyOut };
  };

  const writeFragment = (name: string, ageMs = 0): string => {
    const file = join(vizRoot, name);
    writeFileSync(file, '<b>x</b>');
    if (ageMs > 0) {
      const at = new Date(Date.now() - ageMs);
      utimesSync(file, at, at);
    }
    return file;
  };

  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    db = openDatabase(':memory:');
    root = mkdtempSync(join(os.tmpdir(), 'weave-viz-store-'));
    vizRoot = join(root, 'visualizations');
    mkdirSync(vizRoot, { recursive: true });
    referenced = [];
    deps = {
      projects: new ProjectRepository(db),
      visualizationsDir: vizRoot,
      hookEvents: {
        conversationTextsContaining: () => referenced,
      },
    } as unknown as WeaveServerDeps;
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('stats：只把无引用且过了宽限期的算进可清理', async () => {
    const stale = writeFragment('stale.html', 2 * DAY);
    const fresh = writeFragment('fresh.html');
    const used = writeFragment('used.html', 2 * DAY);
    referenced = [
      `\u{e200}visualize\u{e202}${JSON.stringify({ path: used })}\u{e201}`,
    ];

    const res = await callRoute('/visualizations/stats');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      count: 3,
      unreferenced: { count: 1 },
    });
    expect(existsSync(stale)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
  });

  it('cleanup：删掉的正好是无引用且过宽限期的那份', async () => {
    const stale = writeFragment('stale.html', 2 * DAY);
    const fresh = writeFragment('fresh.html');
    const used = writeFragment('used.html', 2 * DAY);
    referenced = [
      `\u{e200}visualize\u{e202}${JSON.stringify({ path: used })}\u{e201}`,
    ];

    const res = await callRoute('/visualizations/cleanup', 'POST');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ removed: 1 });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(used)).toBe(true);
  });

  it('子目录里的 fragment 也计入', async () => {
    mkdirSync(join(vizRoot, 'nested'), { recursive: true });
    const nested = join(vizRoot, 'nested', 'deep.html');
    writeFileSync(nested, '<i>d</i>');
    const at = new Date(Date.now() - 2 * DAY);
    utimesSync(nested, at, at);

    const stats = await callRoute('/visualizations/stats');
    expect(stats.body).toMatchObject({ count: 1, unreferenced: { count: 1 } });
    const cleaned = await callRoute('/visualizations/cleanup', 'POST');
    expect(cleaned.body).toMatchObject({ removed: 1 });
    expect(existsSync(nested)).toBe(false);
  });

  it('落点根不存在时 stats 是空账、cleanup 是空操作', async () => {
    rmSync(vizRoot, { recursive: true, force: true });
    const stats = await callRoute('/visualizations/stats');
    expect(stats.body).toMatchObject({ count: 0, bytes: 0, unreferenced: { count: 0, bytes: 0 } });
    const cleaned = await callRoute('/visualizations/cleanup', 'POST');
    expect(cleaned.body).toMatchObject({ removed: 0, freedBytes: 0 });
  });
});
