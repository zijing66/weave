import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiLogger, MAX_LOG_FILES, logFileFor, type ApiLogEntry } from '../api-log';
import { readBody, sendJson } from '../http';

const dirs: string[] = [];
const tmpDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'weave-apilog-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** 起一个真 HTTP 服务挂上 ApiLogger（ip/状态/中断这些只有真请求才测得准）。 */
async function withServer(logger: ApiLogger, handler: Handler) {
  const server = createServer((req, res) => {
    logger.begin(req, res);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: (): Promise<void> => new Promise((resolve) => server.close(() => resolve())),
  };
}

const entriesOf = (dir: string): ApiLogEntry[] =>
  readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl'))
    .sort()
    .flatMap((n) =>
      readFileSync(path.join(dir, n), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as ApiLogEntry),
    );

describe('logFileFor', () => {
  it('按本地小时切文件名', () => {
    const dir = tmpDir();
    expect(logFileFor(dir, new Date(2026, 0, 5, 9, 7))).toBe(
      path.join(dir, 'api-2026-01-05T09.jsonl'),
    );
  });
});

describe('ApiLogger 落盘', () => {
  it('每个请求一行：方法/路径/状态/耗时/ip/出入参都对得上', async () => {
    const dir = tmpDir();
    const logger = new ApiLogger({ dir });
    const server = await withServer(logger, (req, res) => {
      void (async () => {
        const body = await readBody(req);
        sendJson(res, 201, { ok: true, echo: JSON.parse(body) as unknown });
      })();
    });
    try {
      const res = await fetch(`${server.url}/projects?x=1`, {
        method: 'POST',
        headers: { 'user-agent': 'vitest', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'p1' }),
      });
      expect(res.status).toBe(201);
      await logger.onIdle();
    } finally {
      await server.close();
    }
    const [entry] = entriesOf(dir);
    expect(entry).toBeDefined();
    expect(entry!.method).toBe('POST');
    expect(entry!.path).toBe('/projects?x=1');
    expect(entry!.status).toBe(201);
    expect(entry!.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry!.ip).toBe('127.0.0.1');
    expect(entry!.ua).toBe('vitest');
    expect(entry!.req).toEqual({ name: 'p1' });
    expect(entry!.res).toEqual({ ok: true, echo: { name: 'p1' } });
    expect(entry!.resBytes).toBeGreaterThan(0);
    expect(entry!.stream).toBeUndefined();
    expect(entry!.aborted).toBeUndefined();
  });

  it('请求头不落盘（cookie/authorization/x-weave-local 的值绝不出现在行里）', async () => {
    const dir = tmpDir();
    const logger = new ApiLogger({ dir });
    const server = await withServer(logger, (_req, res) => sendJson(res, 200, { ok: true }));
    try {
      await fetch(server.url, {
        headers: {
          cookie: 'weave_session=COOKIE-SECRET',
          authorization: 'Bearer AUTH-SECRET',
          'x-weave-local': 'LOCAL-TOKEN-SECRET',
        },
      });
      await logger.onIdle();
    } finally {
      await server.close();
    }
    const raw = readdirSync(dir)
      .map((n) => readFileSync(path.join(dir, n), 'utf8'))
      .join('');
    expect(raw).not.toContain('COOKIE-SECRET');
    expect(raw).not.toContain('AUTH-SECRET');
    expect(raw).not.toContain('LOCAL-TOKEN-SECRET');
  });

  it('SSE 响应标 stream、不落正文', async () => {
    const dir = tmpDir();
    const logger = new ApiLogger({ dir });
    const server = await withServer(logger, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {\"type\":\"hook\"}\n\n');
      res.end();
    });
    try {
      await fetch(server.url);
      await logger.onIdle();
    } finally {
      await server.close();
    }
    const [entry] = entriesOf(dir);
    expect(entry!.stream).toBe(true);
    expect(entry!.res).toBeUndefined();
  });

  it('客户端中断标 aborted', async () => {
    const dir = tmpDir();
    const logger = new ApiLogger({ dir });
    let closed = (): void => {};
    const closedP = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const server = await withServer(logger, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"partial":');
      res.on('close', closed);
    });
    try {
      const ac = new AbortController();
      const inflight = fetch(server.url, { signal: ac.signal }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      await inflight;
      await closedP;
      await logger.onIdle();
    } finally {
      await server.close();
    }
    const [entry] = entriesOf(dir);
    expect(entry!.aborted).toBe(true);
    // 断在半路的响应也照记已写出来的那段（非 JSON 原样留）
    expect(entry!.res).toBe('{"partial":');
  });

  it('按小时入文件，只留最近 MAX_LOG_FILES 个', async () => {
    const dir = tmpDir();
    for (let i = 1; i <= 25; i++) {
      writeFileSync(path.join(dir, `api-2020-01-${String(i).padStart(2, '0')}T00.jsonl`), '{}\n');
    }
    const logger = new ApiLogger({ dir });
    const server = await withServer(logger, (_req, res) => sendJson(res, 200, { ok: true }));
    try {
      await fetch(server.url);
      await logger.onIdle();
    } finally {
      await server.close();
    }
    const names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    expect(names).toHaveLength(MAX_LOG_FILES);
    expect(names.some((n) => n.startsWith('api-2020-01-01'))).toBe(false);
    expect(names.some((n) => n.startsWith('api-2020-01-25'))).toBe(true);
  });
});

describe('截断与脱敏', () => {
  it('超长字符串/数组/深度换占位符，凭据键打码，行仍是 JSON', async () => {
    const dir = tmpDir();
    const logger = new ApiLogger({ dir });
    const deep = { a: { b: { c: { d: { e: { f: { g: 'leaf' } } } } } } };
    const big = {
      password: 'hunter2',
      apiKey: 'AK-1',
      nested: { token: 't-1', keep: 'ok' },
      secret: 's-1',
      authorization: 'Bearer x',
      cookie: 'c=1',
      'x-weave-local': 'l-1',
      long: 'x'.repeat(3000),
      list: Array.from({ length: 60 }, (_, i) => i),
      deep,
    };
    const server = await withServer(logger, (req, res) => {
      void (async () => {
        await readBody(req);
        sendJson(res, 200, { mirror: big });
      })();
    });
    try {
      await fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(big),
      });
      await logger.onIdle();
    } finally {
      await server.close();
    }
    const [entry] = entriesOf(dir);
    const req = entry!.req as Record<string, unknown>;
    expect(req.password).toBe('[redacted]');
    expect(req.apiKey).toBe('[redacted]');
    expect((req.nested as Record<string, unknown>).token).toBe('[redacted]');
    expect((req.nested as Record<string, unknown>).keep).toBe('ok');
    expect(req.secret).toBe('[redacted]');
    expect(req.authorization).toBe('[redacted]');
    expect(req.cookie).toBe('[redacted]');
    expect(req['x-weave-local']).toBe('[redacted]');
    expect(req.long).toBe('[truncated 3000 chars]');
    expect((req.list as unknown[]).at(-1)).toBe('[truncated 10 items]');
    expect((req.list as unknown[]).length).toBe(51);
    // 深度预算从整段正文的根算起：deep 挂在 big 下面，第 6 层就截断
    expect(req.deep).toEqual({
      a: { b: { c: { d: { e: '[depth-limited]' } } } },
    });
    // 响应侧同口径
    const res = entry!.res as { mirror: Record<string, unknown> };
    expect(res.mirror.password).toBe('[redacted]');
    expect(res.mirror.long).toBe('[truncated 3000 chars]');
    // 行本身仍是可解析 JSON（entriesOf 已经 parse 过一遍）
    expect(entry!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('整段超捕获上限换整段占位符（不再逐字段解析）', async () => {
    const dir = tmpDir();
    const logger = new ApiLogger({ dir });
    const huge = 'y'.repeat(20_000);
    const server = await withServer(logger, (req, res) => {
      void (async () => {
        await readBody(req);
        sendJson(res, 200, { huge });
      })();
    });
    try {
      await fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ huge }),
      });
      await logger.onIdle();
    } finally {
      await server.close();
    }
    const [entry] = entriesOf(dir);
    expect(entry!.req).toBe(`[truncated body ${JSON.stringify({ huge }).length} bytes]`);
    expect(entry!.res).toBe(`[truncated body ${JSON.stringify({ huge }).length} bytes]`);
  });
});

describe('query', () => {
  const line = (e: Partial<ApiLogEntry>): string =>
    JSON.stringify({
      ts: '2026-01-01T00:00:00.000Z',
      method: 'GET',
      path: '/',
      status: 200,
      durationMs: 1,
      ip: '127.0.0.1',
      ...e,
    });

  it('倒序返回，按时间/路径/方法/状态过滤，limit 封顶', async () => {
    const dir = tmpDir();
    const file = logFileFor(dir, new Date(2026, 0, 1, 10));
    writeFileSync(
      file,
      [
        line({ ts: '2026-01-01T01:00:00.000Z', path: '/projects', method: 'GET', status: 200 }),
        line({ ts: '2026-01-01T02:00:00.000Z', path: '/projects/x', method: 'POST', status: 400 }),
        line({ ts: '2026-01-01T03:00:00.000Z', path: '/settings', method: 'PUT', status: 500 }),
      ].join('\n') + '\n',
    );
    const logger = new ApiLogger({ dir });

    const all = await logger.query({});
    expect(all.files).toBe(1);
    expect(all.entries.map((e) => e.path)).toEqual(['/settings', '/projects/x', '/projects']);

    const filtered = await logger.query({ path: 'projects', method: 'get', status: 200 });
    expect(filtered.entries.map((e) => e.path)).toEqual(['/projects']);

    const ranged = await logger.query({ from: '2026-01-01T02:00:00.000Z', to: '2026-01-01T02:30:00.000Z' });
    expect(ranged.entries.map((e) => e.path)).toEqual(['/projects/x']);

    const capped = await logger.query({ limit: 1 });
    expect(capped.entries).toHaveLength(1);
    expect(capped.entries[0]!.path).toBe('/settings');
  });

  it('目录不存在时空表不抛', async () => {
    const logger = new ApiLogger({ dir: path.join(tmpDir(), 'nope') });
    expect(await logger.query({})).toEqual({ entries: [], files: 0 });
  });
});
