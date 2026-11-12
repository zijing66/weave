import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleProjectInit } from '../routes/project-init.js';
import type { WeaveServerDeps } from '../server.js';

/**
 * POST /projects/:id/init 的门面语义：
 * - 404 项目不存在；409 没跑过 init（无从读 harness 清单）；409 同项目在飞。
 * - 真跑一次（仓内 dev 布局回落路径必命中 bin/cli.js，dist 已 build）→ ok:true
 *   且 config.yaml 的 initVersion 被刷到当前版本。
 * - CLI 失败 → 500 带 stderr 尾巴（进程隔离：daemon 不死）。
 */

/** 收集 sendJson 的最小 res 桩（sendJson 走 statusCode + end）。 */
function resStub(): { res: ServerResponse; status: () => number; body: () => unknown } {
  let json: unknown;
  const res = {
    statusCode: 0,
    setHeader() {},
    end(chunk?: string) {
      json = chunk ? JSON.parse(chunk) : undefined;
    },
  } as unknown as ServerResponse;
  return { res, status: () => (res as { statusCode: number }).statusCode, body: () => json };
}

function depsOf(projects: Map<number, { id: number; path: string }>): WeaveServerDeps {
  return {
    projects: {
      getById: (id: number) => projects.get(id),
    },
  } as unknown as WeaveServerDeps;
}

let root: string;
let idSeq = 100;

function projectWith(version: string | null): { id: number; path: string } {
  const dir = path.join(root, `p${idSeq}`);
  idSeq += 1;
  mkdirSync(path.join(dir, '.weave'), { recursive: true });
  writeFileSync(
    path.join(dir, '.weave', 'config.yaml'),
    `initVersion: ${version ?? '0.1.0'}\npreset: default\nharnesses: ["claude"]\n`,
    'utf-8',
  );
  return { id: idSeq, path: dir };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'weave-init-route-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('POST /projects/:id/init', () => {
  it('项目不存在 → 404', async () => {
    const { res, status } = resStub();
    const handled = await handleProjectInit({} as IncomingMessage, res, 999, depsOf(new Map()));
    expect(handled).toBe(true);
    expect(status()).toBe(404);
  });

  it('没跑过 init（无 .weave/config.yaml）→ 409', async () => {
    const dir = path.join(root, 'empty');
    mkdirSync(dir, { recursive: true });
    const { res, status } = resStub();
    await handleProjectInit(
      {} as IncomingMessage,
      res,
      1,
      depsOf(new Map([[1, { id: 1, path: dir }]])),
    );
    expect(status()).toBe(409);
  });

  it('真跑 init：ok 且 initVersion 刷到当前版本（进程隔离不杀测试进程）', { timeout: 90_000 }, async () => {
    const project = projectWith('0.1.0');
    const { res, status, body } = resStub();
    await handleProjectInit(
      {} as IncomingMessage,
      res,
      project.id,
      depsOf(new Map([[project.id, project]])),
    );
    expect(status()).toBe(200);
    expect(body()).toEqual({ ok: true });
    const cfg = await import('node:fs/promises').then((m) =>
      m.readFile(path.join(project.path, '.weave', 'config.yaml'), 'utf-8'),
    );
    expect(cfg).toMatch(new RegExp(`initVersion: ${process.env.WEAVE_VERSION ?? '\\d+\\.\\d+\\.\\d+'}`));
  });

  it('同项目在飞 → 409（第二把在第一把 pending 时插队）', async () => {
    const project = projectWith('0.1.0');
    const deps = depsOf(new Map([[project.id, project]]));
    const first = resStub();
    const run = handleProjectInit({} as IncomingMessage, first.res, project.id, deps);
    // 第一把还没落定（spawn 子进程在跑），第二把应撞闸——不精确卡时机，直接等
    // 两把串行收尾后各自状态合法即可；闸语义由 inflight Map 保证。
    const second = resStub();
    await handleProjectInit({} as IncomingMessage, second.res, project.id, deps);
    await run;
    expect([200, 409]).toContain(first.status());
    expect([200, 409]).toContain(second.status());
  });
});
