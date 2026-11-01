import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handlePetRoutes } from '../routes/pets.js';
import type { WeaveServerDeps } from '../server.js';

/**
 * GET /pets 与 /pets/:id/spritesheet：列举、白名单 id、containment、
 * 大小上限、png 回落。数据目录经 APPDATA stub 隔离（getPetsDir 无注入参数）。
 */

const call = async (
  pathname: string,
  method = 'GET',
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> => {
  const req = Readable.from([Buffer.from('')]) as unknown as IncomingMessage;
  req.method = method;
  let out: unknown = null;
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
      if (typeof chunk === 'string') out = JSON.parse(chunk);
      else if (chunk) out = chunk;
    },
  };
  const url = new URL(pathname, 'http://x');
  await handlePetRoutes(req, res as unknown as ServerResponse, {} as WeaveServerDeps, url.pathname, url);
  return { status: res.statusCode, body: out, headers };
};

/** 假 res：statusCode 直写 sink（sendJson 走赋值不走 writeHead），补 pipe/on/once。 */
const makeRes = (sink: { status: number; headers: Record<string, string>; chunks: Buffer[] }) => {
  const res = {
    setHeader: (k: string, v: string) => {
      sink.headers[k.toLowerCase()] = v;
    },
    writeHead: (code: number, hdrs?: Record<string, string>) => {
      sink.status = code;
      for (const [k, v] of Object.entries(hdrs ?? {})) sink.headers[k.toLowerCase()] = v;
    },
    end: (chunk?: unknown) => {
      if (chunk) sink.chunks.push(Buffer.from(chunk as Buffer));
    },
    on: () => res,
    once: () => res,
    emit: () => res,
    write: (c: unknown) => {
      sink.chunks.push(Buffer.from(c as Buffer));
      return true;
    },
  };
  Object.defineProperty(res, 'statusCode', {
    get: () => sink.status,
    set: (v: number) => {
      sink.status = v;
    },
  });
  return res;
};

/** 最小 PNG（1×1 透明）。 */
const tinyPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

describe('GET /pets（桌面宠物只读面）', () => {
  let dataRoot: string;
  let oldAppdata: string | undefined;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(tmpdir(), 'weave-pets-'));
    oldAppdata = process.env.APPDATA;
    process.env.APPDATA = dataRoot;
    vi.resetModules();
  });

  afterEach(() => {
    if (oldAppdata === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = oldAppdata;
    rmSync(dataRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  const seedPet = (id: string): void => {
    const dir = path.join(dataRoot, 'weave', 'data', 'pets', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'pet.json'),
      JSON.stringify({ id, displayName: id, description: '', spriteVersionNumber: 1 }),
    );
    writeFileSync(path.join(dir, 'spritesheet.png'), tinyPng);
  };

  it('列举：读各 pet.json，损坏条目跳过、id≠目录名跳过', async () => {
    seedPet('alpha');
    seedPet('beta');
    // 损坏 JSON
    const broken = path.join(dataRoot, 'weave', 'data', 'pets', 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(path.join(broken, 'pet.json'), '{oops');
    // id 与目录名不符
    const liar = path.join(dataRoot, 'weave', 'data', 'pets', 'liar');
    mkdirSync(liar, { recursive: true });
    writeFileSync(path.join(liar, 'pet.json'), JSON.stringify({ id: 'other' }));

    const { handlePetRoutes: fresh } = await import('../routes/pets.js');
    const req = Readable.from([Buffer.from('')]) as unknown as IncomingMessage;
    req.method = 'GET';
    let out: unknown = null;
    const res = { statusCode: 0, setHeader: () => undefined, writeHead: () => undefined, end: (c?: unknown) => { out = c; } };
    const url = new URL('/pets', 'http://x');
    await fresh(req, res as unknown as ServerResponse, {} as WeaveServerDeps, url.pathname, url);
    const body = JSON.parse(String(out)) as { pets: Array<{ id: string }>; root: string };
    expect(body.pets.map((p) => p.id)).toEqual(['alpha', 'beta']);
    expect(body.root).toBe(path.join(dataRoot, 'weave', 'data', 'pets'));
  });

  it('spritesheet：png 回落 + immutable 缓存头；缺失回 404', async () => {
    seedPet('alpha');
    const { handlePetRoutes: fresh } = await import('../routes/pets.js');
    const callFresh = async (pathname: string): Promise<{ status: number; headers: Record<string, string>; chunks: Buffer[] }> => {
      const req = Readable.from([Buffer.from('')]) as unknown as IncomingMessage;
      req.method = 'GET';
      const sink = { status: 0, headers: {} as Record<string, string>, chunks: [] as Buffer[] };
      const url = new URL(pathname, 'http://x');
      await fresh(req, makeRes(sink) as unknown as ServerResponse, {} as WeaveServerDeps, url.pathname, url);
      return sink;
    };

    const ok = await callFresh('/pets/alpha/spritesheet?v=123');
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
    expect(ok.headers['cache-control']).toContain('immutable');

    const missing = await callFresh('/pets/ghost/spritesheet');
    expect(missing.status).toBe(404);
  });

  it('id 白名单：路径分隔符与 .. 一律 400', async () => {
    const { handlePetRoutes: fresh } = await import('../routes/pets.js');
    for (const bad of ['..%2Fescape', 'a%2Fb', '%2e%2e']) {
      const req = Readable.from([Buffer.from('')]) as unknown as IncomingMessage;
      req.method = 'GET';
      const sink = { status: 0, headers: {} as Record<string, string>, chunks: [] as Buffer[] };
      // 手拼 pathname（不过 URL 归一化——服务端收到的就是未解码原文）
      await fresh(req, makeRes(sink) as unknown as ServerResponse, {} as WeaveServerDeps, `/pets/${bad}/spritesheet`, new URL('/pets/x/spritesheet', 'http://x'));
      expect(sink.status, `id=${bad}`).toBe(400);
    }
  });

  it('非 /pets 路径不认领（claim-or-pass）', async () => {
    const { handlePetRoutes: fresh } = await import('../routes/pets.js');
    const req = Readable.from([Buffer.from('')]) as unknown as IncomingMessage;
    req.method = 'GET';
    const claimed = await fresh(
      req,
      { statusCode: 0, setHeader: () => undefined, writeHead: () => undefined, end: () => undefined } as unknown as ServerResponse,
      {} as WeaveServerDeps,
      '/petscape',
      new URL('/petscape', 'http://x'),
    );
    expect(claimed).toBe(false);
  });
});
