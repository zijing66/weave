import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Harness } from '@weavecode/core';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { handleSessionInsightRoutes } from '../routes/session-insights.js';
import type { WeaveServerDeps } from '../server.js';

/**
 * 会话活动三端点（activity 槽）：合账口径 = 文件面 meta + 事件账状态；
 * tasks 文件优先、事件账重建兜底标 source；无该槽的 harness 答 supported:false。
 * 详情端点白名单 = subagents 目录内（agentId 消毒）。
 */
describe('会话活动路由', () => {
  let db: ReturnType<typeof openDatabase>;
  let deps: WeaveServerDeps;
  let dir: string;
  let source: Harness;
  let transcriptPath: string | null;
  let savedHome: { HOME?: string; USERPROFILE?: string };

  const call = async (path: string): Promise<{ status: number; body: unknown }> => {
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
    const url = new URL(path, 'http://x');
    await handleSessionInsightRoutes(req, res as unknown as ServerResponse, deps, url.pathname, url);
    return { status: res.statusCode, body: bodyOut ? JSON.parse(bodyOut) : null };
  };

  /** 写一条子 agent 转录 + meta（place = subagents 目录）。 */
  const agent = (id: string, text = '思考中'): string => {
    // 真实布局：<dir>/sess.jsonl + <dir>/sess/subagents/
    const subagents = join(dir, 'sess', 'subagents');
    mkdirSync(subagents, { recursive: true });
    const file = join(subagents, `agent-${id}.jsonl`);
    writeFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-04T10:00:00.000Z',
        isSidechain: true,
        message: { id: `m${id}`, content: [{ type: 'text', text }] },
      }),
    );
    writeFileSync(join(subagents, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'Explore', description: 'scan' }));
  };

  /** 任务清单文件（真实落点 `<home>/.claude/tasks/<会话id>/<N>.json`）。 */
  const task = (id: string, subject: string, status: string): void => {
    const tasksDir = join(dir, '.claude', 'tasks', 'sess');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, `${id}.json`), JSON.stringify({ id, subject, status, activeForm: subject }));
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-activity-routes-'));
    // tasks 目录的真落点在 home 下：把 home 指到临时目录（绝不读本机真 ~/.claude）。
    savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    db = openDatabase(':memory:');
    const projectId = new ProjectRepository(db).register({
      path: dir,
      name: 'p',
      token: 't',
      source: 'init',
    }).id;
    new SessionRepository(db).touch('sess', projectId);
    source = 'claude';
    transcriptPath = join(dir, 'sess.jsonl');
    deps = {
      projects: new ProjectRepository(db),
      hookSessions: new SessionRepository(db),
      hookEvents: { listBySession: () => [{ source }] },
      sessionProbe: { transcriptPathOf: () => transcriptPath },
      activityTracker: {
        agentsOf: () => new Map([['ag1', { status: 'completed', lastSeenAt: '2026-11-04T10:01:00.000Z' }]]),
        shellsOf: () => new Map(),
      },
    } as unknown as WeaveServerDeps;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    if (savedHome.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome.HOME;
    if (savedHome.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedHome.USERPROFILE;
  });

  it('合账：surface 给 meta/路径、tracker 给状态；任务清单读 tasks 目录', async () => {
    agent('ag1');
    task('1', '写测试', 'in_progress');
    task('2', '发版', 'completed');
    const hit = await call('/sessions/sess/activity');
    expect(hit.status).toBe(200);
    const body = hit.body as {
      supported: boolean;
      agents: Array<Record<string, unknown>>;
      tasks: Array<Record<string, unknown>> | null;
      shells: unknown[];
    };
    expect(body.supported).toBe(true);
    expect(body.agents[0]).toMatchObject({ agentId: 'ag1', agentType: 'Explore', status: 'completed' });
    expect(body.tasks?.map((r) => r.status).sort()).toEqual(['completed', 'in_progress']);
    expect(body.shells).toEqual([]);
  });

  it('tasks 目录被宿主清空 → tasks:null（不从事件账重建）', async () => {
    agent('ag1');
    const hit = await call('/sessions/sess/activity');
    expect((hit.body as { tasks: unknown }).tasks).toBeNull();
  });

  it('没有 activity 槽的 harness → supported:false（不摆空壳）', async () => {
    source = 'codex';
    const hit = await call('/sessions/sess/activity');
    expect(hit.body).toMatchObject({ supported: false, agents: null, tasks: null, shells: null });
  });

  it('子 agent 转录：读到 offset 增量', async () => {
    agent('ag1', '第一段');
    const hit = await call('/sessions/sess/agents/ag1/transcript');
    expect(hit.status).toBe(200);
    const body = hit.body as { segs: Array<{ text: string }>; nextOffset: number | null };
    expect(body.segs.map((s) => s.text)).toEqual(['第一段']);
    expect(body.nextOffset).toBeNull();
  });

  it('子 agent 转录：路径穿越被消毒后落空 → 404', async () => {
    agent('ag1');
    const hit = await call('/sessions/sess/agents/..%2F..%2Fsecret/transcript');
    expect(hit.status).toBe(404);
  });

  it('shell 输出：文件不存在 → 404', async () => {
    const hit = await call('/sessions/sess/shells/nope/output');
    expect(hit.status).toBe(404);
  });
});
