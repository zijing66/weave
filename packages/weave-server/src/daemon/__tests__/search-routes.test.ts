import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { handleSearchRoutes } from '../routes/search.js';
import type { WeaveServerDeps } from '../server.js';

/** GET /search 三路聚合：会话名 / 聊天记录 / 项目文件（冷项目跳过）。 */

const call = async (deps: WeaveServerDeps, q: string) => {
  const req = Readable.from([Buffer.from('')]) as unknown as IncomingMessage;
  req.method = 'GET';
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
  const url = new URL(`/search?q=${encodeURIComponent(q)}`, 'http://x');
  await handleSearchRoutes(req, res as unknown as ServerResponse, deps, url.pathname, url);
  return { status: res.statusCode, body: out as Record<string, unknown> };
};

const makeDeps = (): { deps: WeaveServerDeps; db: ReturnType<typeof openDatabase> } => {
  const db = openDatabase(':memory:');
  const projects = new ProjectRepository(db);
  const p = projects.register({ path: '/proj', name: 'proj', token: 't', source: 'init' });
  return {
    db,
    deps: {
      port: 6420,
      projects,
      hookEvents: new HookEventRepository(db),
      hookSessions: new SessionRepository(db),
    } as unknown as WeaveServerDeps,
  };
};

describe('GET /search', () => {
  it('空 q 返回空三组', async () => {
    const { deps, db } = makeDeps();
    try {
      const { status, body } = await call(deps, '');
      expect(status).toBe(200);
      expect(body.sessions).toEqual([]);
      expect(body.messages).toEqual([]);
      expect(body.files).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('会话名与聊天记录命中；文件路对无索引项目静默跳过', async () => {
    const { deps, db } = makeDeps();
    try {
      const project = deps.projects!.list()[0]!;
      const events = deps.hookEvents!;
      const sessions = deps.hookSessions!;
      sessions.touch('sess-1', project.id);
      sessions.setTitle('sess-1', '编排画布讨论');
      events.insert({
        projectId: project.id,
        source: 'claude',
        eventType: 'UserPromptSubmit',
        sessionId: 'sess-1',
        payload: JSON.stringify({ raw: { prompt: '帮我看看编排画布' } }),
      });

      const { status, body } = await call(deps, '编排');
      expect(status).toBe(200);
      expect(body.q).toBe('编排');
      expect((body.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId)).toEqual(['sess-1']);
      const messages = body.messages as Array<{ text: string; offset: number; sessionId: string }>;
      expect(messages).toHaveLength(1);
      expect(messages[0]!.text).toBe('帮我看看编排画布');
      expect(messages[0]!.offset).toBe(4);
      expect(messages[0]!.sessionId).toBe('sess-1');
      // /proj 没建过索引（peekCachedIndex miss）→ files 空但不报错
      expect(body.files).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('长正文截命中窗口(offset/clipped 正确)', async () => {
    const { deps, db } = makeDeps();
    try {
      const project = deps.projects!.list()[0]!;
      const filler = '啊'.repeat(300);
      deps.hookEvents!.insert({
        projectId: project.id,
        source: 'claude',
        eventType: 'UserPromptSubmit',
        sessionId: 's',
        payload: JSON.stringify({ raw: { prompt: `${filler}关键词${filler}` } }),
      });
      const { body } = await call(deps, '关键词');
      const messages = body.messages as Array<{ text: string; offset: number; clipped: boolean }>;
      expect(messages[0]!.clipped).toBe(true);
      expect(messages[0]!.offset).toBe(80);
      expect(messages[0]!.text).toContain('关键词');
      expect(messages[0]!.text.length).toBeLessThan(200);
    } finally {
      db.close();
    }
  });

  it('hooks 子系统缺位回 503', async () => {
    const { deps, db } = makeDeps();
    try {
      const bare = { port: 6420, projects: deps.projects } as unknown as WeaveServerDeps;
      const { status } = await call(bare, 'x');
      expect(status).toBe(503);
    } finally {
      db.close();
    }
  });
});
