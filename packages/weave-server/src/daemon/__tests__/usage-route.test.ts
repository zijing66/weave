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
 * `GET /sessions/:id/usage`：聚合零逻辑——取数归 harness 能力面，server 只装配
 * 「查归属 → 找转录 → 原样转发」。没有面 / 读不到转录都不许编，一律 usage:null。
 */
describe('会话用量路由', () => {
  let db: ReturnType<typeof openDatabase>;
  let deps: WeaveServerDeps;
  let dir: string;
  let source: Harness;
  let transcriptPath: string | null;

  interface Body {
    supported: boolean;
    usage: Array<{
      at: string | null;
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      reasoningTokens: number;
      contextTokens: number | null;
    }> | null;
  }

  const call = async (): Promise<{ status: number; body: Body }> => {
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
    const url = new URL('/sessions/sess/usage', 'http://x');
    await handleHooksRoutes(req, res as unknown as ServerResponse, deps, url.pathname, url);
    return { status: res.statusCode, body: JSON.parse(bodyOut) as Body };
  };

  /** 写一份转录，并把会话的转录路径指过去。 */
  const transcript = (lines: string[]): void => {
    const path = join(dir, 'sess.jsonl');
    writeFileSync(path, lines.join('\n'));
    transcriptPath = path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-usage-route-'));
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
      hookEvents: { listBySession: () => [{ source }] },
      sessionProbe: { transcriptPathOf: () => transcriptPath },
    } as unknown as WeaveServerDeps;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('claude 转录的 usage 条目原样转发', async () => {
    transcript([
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-05T01:00:00.000Z',
        message: {
          id: 'msg_1',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 30, output_tokens: 500 },
        },
      }),
    ]);
    const hit = await call();
    expect(hit.status).toBe(200);
    expect(hit.body.supported).toBe(true);
    expect(hit.body.usage).toHaveLength(1);
    expect(hit.body.usage![0]).toMatchObject({ inputTokens: 120, outputTokens: 500, contextTokens: 650 });
  });

  it('转录读不到 → supported:false + usage:null（不猜）', async () => {
    const hit = await call();
    expect(hit.body).toEqual({ supported: false, usage: null });
  });

  it('无该面的 harness → supported:false + usage:null（codex 有，另测 harness 层）', async () => {
    source = 'codex';
    transcript([
      JSON.stringify({
        timestamp: '2026-11-05T17:17:19.322Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 },
            last_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 5, reasoning_output_tokens: 0 },
          },
        },
      }),
    ]);
    const hit = await call();
    expect(hit.body.supported).toBe(true);
    expect(hit.body.usage![0]).toMatchObject({ inputTokens: 40, cacheReadInputTokens: 60, reasoningTokens: 0 });
  });
});
