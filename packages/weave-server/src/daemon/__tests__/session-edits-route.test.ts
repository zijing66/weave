import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Harness } from '@weavecode/core';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { handleHooksRoutes } from '../hooks-routes.js';
import type { WeaveServerDeps } from '../server.js';

/**
 * `GET /sessions/:id/edits`：取数归 harness 能力面（claude = 转录里的编辑调用），
 * 这条路由只做「按文件汇总 + 把绝对路径换成展示名 + 限流」。没有面 / 读不到转录
 * 都不许编，一律 files:null 加 reason。
 */
describe('会话改动汇总路由', () => {
  let db: ReturnType<typeof openDatabase>;
  let deps: WeaveServerDeps;
  let dir: string;
  let source: Harness;
  let transcriptPath: string | null;

  interface Body {
    files: Array<{
      path: string;
      hunks: Array<{ before: string; after: string; at: string | null; clamped?: true }>;
    }> | null;
    hunks: number;
    truncated: boolean;
    reason?: string;
  }

  const call = async (query = ''): Promise<{ status: number; body: Body }> => {
    const req = Readable.from([Buffer.from('')]) as unknown as IncomingMessage;
    req.method = 'GET';
    let bodyOut = '';
    const res = {
      statusCode: 0,
      setHeader: () => {},
      writeHead: (code: number) => {
        res.statusCode = code;
      },
      end: (chunk?: unknown) => {
        bodyOut = typeof chunk === 'string' ? chunk : '';
      },
    };
    const url = new URL(`/sessions/sess/edits${query}`, 'http://x');
    await handleHooksRoutes(req, res as unknown as ServerResponse, deps, url.pathname, url);
    return { status: res.statusCode, body: JSON.parse(bodyOut) as Body };
  };

  const use = (id: string, name: string, input: unknown): string =>
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-21T01:00:00.000Z',
      message: { content: [{ type: 'tool_use', id, name, input }] },
    });

  /** 写一份转录，并把会话的转录路径指过去。 */
  const transcript = (lines: string[]): void => {
    const path = join(dir, 'sess.jsonl');
    writeFileSync(path, lines.join('\n'));
    transcriptPath = path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-edits-route-'));
    db = openDatabase(':memory:');
    const projectId = new ProjectRepository(db).register({
      path: dir,
      name: 'p',
      token: 't',
      source: 'init',
    }).id;
    new SessionRepository(db).touch('sess', projectId);
    source = 'claude';
    transcriptPath = null;
    deps = {
      projects: new ProjectRepository(db),
      hookSessions: new SessionRepository(db),
      // harness 归属 = 最新事件的 source（同 open-terminal / plan 口径）
      hookEvents: { listBySession: () => [{ source }] },
      sessionProbe: { transcriptPathOf: () => transcriptPath },
    } as unknown as WeaveServerDeps;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('同一文件的多处改动并成一条，路径相对项目、posix 分隔', async () => {
    const file = join(dir, 'src', 'a.ts');
    transcript([
      use('t1', 'Write', { file_path: file, content: 'one\n' }),
      use('t2', 'Edit', { file_path: file, old_string: 'one', new_string: 'two' }),
      use('t3', 'Edit', { file_path: join(dir, 'b.md'), old_string: 'x', new_string: 'y' }),
    ]);
    const hit = await call();
    expect(hit.status).toBe(200);
    expect(hit.body.files?.map((f) => f.path)).toEqual(['src/a.ts', 'b.md']);
    expect(hit.body.hunks).toBe(3);
    expect(hit.body.files?.[0]?.hunks).toEqual([
      { before: '', after: 'one\n', at: '2026-10-21T01:00:00.000Z' },
      { before: 'one', after: 'two', at: '2026-10-21T01:00:00.000Z' },
    ]);
    expect(hit.body.truncated).toBe(false);
  });

  it('超长的一处裁掉尾巴并如实标注（不假装是全份）', async () => {
    transcript([
      use('t1', 'Write', { file_path: join(dir, 'big.ts'), content: 'x'.repeat(250_000) }),
    ]);
    const hit = await call();
    expect(hit.body.files?.[0]?.hunks[0]?.clamped).toBe(true);
    expect(hit.body.files?.[0]?.hunks[0]?.after).toHaveLength(200_000);
    expect(hit.body.truncated).toBe(true);
  });

  it('读不到转录 → files:null + unreadable（不猜）', async () => {
    const hit = await call();
    expect(hit.body).toMatchObject({ files: null, reason: 'unreadable' });
  });

  it('没有改动提取面的 harness → files:null + unsupported', async () => {
    source = 'codex';
    transcript([use('t1', 'Edit', { file_path: join(dir, 'a.ts'), old_string: 'a', new_string: 'b' })]);
    const hit = await call();
    expect(hit.body).toMatchObject({ files: null, reason: 'unsupported' });
  });

  // ---- 按轮取数（?since=&until=，语义 (since, until]）----

  const useAt = (id: string, name: string, input: unknown, at: string): string =>
    JSON.stringify({
      type: 'assistant',
      timestamp: at,
      message: { content: [{ type: 'tool_use', id, name, input }] },
    });

  it('窗口只回界内的改动：at==since 排除、at==until 包含、at:null 不归轮', async () => {
    transcript([
      useAt('t0', 'Edit', { file_path: join(dir, 'prev.ts'), old_string: 'a', new_string: 'b' }, '2026-10-21T00:59:00.000Z'),
      useAt('t1', 'Edit', { file_path: join(dir, 'in1.ts'), old_string: 'a', new_string: 'b' }, '2026-10-21T01:00:30.000Z'),
      useAt('t2', 'Edit', { file_path: join(dir, 'edge.ts'), old_string: 'a', new_string: 'b' }, '2026-10-21T01:02:00.000Z'),
      useAt('t3', 'Edit', { file_path: join(dir, 'later.ts'), old_string: 'a', new_string: 'b' }, '2026-10-21T01:05:00.000Z'),
      // 无时刻的改动没法归轮：范围视图不摆
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't4', name: 'Edit', input: { file_path: join(dir, 'noat.ts'), old_string: 'a', new_string: 'b' } }] },
      }),
    ]);
    const hit = await call('?since=2026-10-21T01:00:00.000Z&until=2026-10-21T01:02:00.000Z');
    expect(hit.body.files?.map((f) => f.path)).toEqual(['in1.ts', 'edge.ts']);
    expect(hit.body.hunks).toBe(2);
  });

  it('不带参 = 全部（现行为），非法 ISO 按缺省处理', async () => {
    transcript([
      useAt('t1', 'Edit', { file_path: join(dir, 'a.ts'), old_string: 'a', new_string: 'b' }, '2026-10-21T01:00:00.000Z'),
      useAt('t2', 'Edit', { file_path: join(dir, 'b.ts'), old_string: 'a', new_string: 'b' }, '2026-10-21T02:00:00.000Z'),
    ]);
    const all = await call();
    expect(all.body.hunks).toBe(2);
    // since 非法 → 当没带；until 合法仍生效
    const bad = await call('?since=not-a-date&until=2026-10-21T01:30:00.000Z');
    expect(bad.body.files?.map((f) => f.path)).toEqual(['a.ts']);
  });
});
