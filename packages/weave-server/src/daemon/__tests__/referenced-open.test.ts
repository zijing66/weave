import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { handleHooksRoutes } from '../hooks-routes.js';
import { resetCombinedLivenessForTest } from '../liveness.js';
import type { WeaveServerDeps } from '../server.js';

/**
 * `POST /sessions/:id/messages` 的发送前拉起（2026-11-04 裁决「实现，失败阻断发送」，
 * 2026-11-05 扩到目标会话自己）：正文里 `#<id>「名」` 标注的目标、以及被发送的那个
 * 会话本身，判死都先 ensureOpen 拉起；拉不起来即拒发。引用本身仍是收件人标注，
 * 代投归宿主模型——这里只保证目标在 TUI 里活着。
 */
describe('发送前的会话拉起', () => {
  let db: ReturnType<typeof openDatabase>;
  let deps: WeaveServerDeps;
  let send: ReturnType<typeof vi.fn>;
  let ensureOpen: ReturnType<typeof vi.fn>;
  const SELF = '11111111-1111-4111-8111-111111111111';
  const DEAD = '22222222-2222-4222-8222-222222222222';
  const GHOST = '33333333-3333-4333-8333-333333333333';
  const FRESH = '44444444-4444-4444-8444-444444444444';

  /** 造一个判死会话：claude + 两条事件（非空壳）+ 十分钟前最后活动。 */
  const seedDead = (sessionId: string): void => {
    const project = new ProjectRepository(db).register({
      path: '/p',
      name: 'p',
      token: 't',
      source: 'init',
    });
    const events = new HookEventRepository(db);
    const sessions = new SessionRepository(db);
    for (const eventType of ['SessionStart', 'Stop']) {
      events.insert({
        projectId: project.id,
        source: 'claude',
        eventType,
        sessionId,
        payload: '{}',
      });
    }
    sessions.touch(sessionId, project.id);
    db.prepare('update sessions set last_seen_at = ? where session_id = ?').run(
      new Date(Date.now() - 600_000).toISOString(),
      sessionId,
    );
  };

  /** 造一个「还新鲜、判不动」的会话（豁免窗内 ⇒ 不猜、不拉起）。 */
  const seedFresh = (sessionId: string): void => {
    const project = new ProjectRepository(db).register({
      path: '/p3',
      name: 'p3',
      token: 't3',
      source: 'init',
    });
    new HookEventRepository(db).insert({
      projectId: project.id,
      source: 'claude',
      eventType: 'SessionStart',
      sessionId,
      payload: '{}',
    });
    new SessionRepository(db).touch(sessionId, project.id);
  };

  const call = async (text: string, at = SELF): Promise<{ status: number; body: unknown }> => {
    const req = Readable.from([Buffer.from(JSON.stringify({ text }))]) as unknown as IncomingMessage;
    req.method = 'POST';
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
    const url = new URL(`/sessions/${at}/messages`, 'http://x');
    await handleHooksRoutes(req, res as unknown as ServerResponse, deps, url.pathname, url);
    return { status: res.statusCode, body: bodyOut };
  };

  beforeEach(() => {
    resetCombinedLivenessForTest();
    db = openDatabase(':memory:');
    seedDead(SELF);
    seedDead(DEAD);
    seedFresh(FRESH);
    send = vi.fn(async () => ({
      ok: true,
      messageId: 'm1',
      status: 'queued',
      message: { id: 'm1', text: 'x', status: 'queued' },
    }));
    ensureOpen = vi.fn(async () => ({ ok: true, ack: 'session-start' }));
    deps = {
      hookSessions: new SessionRepository(db),
      messageDeliverer: { send },
      ensureOpen,
    } as unknown as WeaveServerDeps;
  });

  afterEach(() => {
    db.close();
    resetCombinedLivenessForTest();
  });

  it('目标会话自己判死 → 投递前先拉起，拉起成功照常发送', async () => {
    const hit = await call('普通一条消息');
    expect(ensureOpen).toHaveBeenCalledWith(SELF);
    expect(send).toHaveBeenCalledTimes(1);
    expect(hit.status).toBe(201);
  });

  it('目标会话自己拉不起来 → 502，不投递', async () => {
    ensureOpen.mockResolvedValue({ ok: false, error: 'session did not report ready within 15s' });
    const hit = await call('普通一条消息');
    expect(hit.status).toBe(502);
    expect(send).not.toHaveBeenCalled();
  });

  it('被引用的目标判死 → 投递前拉起，拉起成功照常发送', async () => {
    const hit = await call(`帮我看下 #${DEAD}「vxspace-a0」 那个会话`);
    expect(ensureOpen).toHaveBeenCalledWith(DEAD);
    expect(send).toHaveBeenCalledTimes(1);
    expect(hit.status).toBe(201);
  });

  it('拉起失败 → 拒发（502），不投递', async () => {
    ensureOpen.mockResolvedValue({ ok: false, error: 'session did not report ready within 15s' });
    const hit = await call(`看下 #${DEAD}「vxspace-a0」`);
    expect(hit.status).toBe(502);
    expect(send).not.toHaveBeenCalled();
  });

  it('引用不存在的会话 → 404 拒发', async () => {
    const hit = await call(`看下 #${GHOST}「幽灵」`);
    expect(hit.status).toBe(404);
    expect(ensureOpen).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('引用本会话自己只算一次（不重复拉起）', async () => {
    const hit = await call(`注意 #${SELF}「自己」`);
    expect(ensureOpen).toHaveBeenCalledTimes(1);
    expect(ensureOpen).toHaveBeenCalledWith(SELF);
    expect(hit.status).toBe(201);
  });

  it('目标还新鲜（豁免窗内判不动）→ 不猜、不拉起', async () => {
    const hit = await call(`看下 #${FRESH}「新鲜的」`, FRESH);
    expect(ensureOpen).not.toHaveBeenCalled();
    expect(hit.status).toBe(201);
  });

  it('会话活着 + 没有引用标注 → 完全不走拉起路径', async () => {
    const hit = await call('普通一条消息', FRESH);
    expect(ensureOpen).not.toHaveBeenCalled();
    expect(hit.status).toBe(201);
  });
});
