import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { handleHooksRoutes } from '../hooks-routes.js';
import type { WeaveServerDeps } from '../server.js';

/**
 * `POST /sessions/:id/interrupt`：键送出去之后要**回读转录**才敢说「停了」。
 * 只有转录里的中断标记是「宿主到底停没停」的证据（hook 域没有中断事件）——
 * 实机 2026-10-21 8c85b9c7 连按三次停止全 200、转录里一个标记都没有。
 */
describe('中断路由：一记 ESC 之后的自证与补打', () => {
  let db: ReturnType<typeof openDatabase>;
  let deps: WeaveServerDeps;
  let marker: number | null;
  let transcriptKnown: boolean;
  const interrupt = vi.fn();

  const call = async (): Promise<{ status: number; body: unknown }> => {
    const req = Readable.from([Buffer.from('')]) as unknown as IncomingMessage;
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
    const url = new URL('/sessions/sess/interrupt', 'http://x');
    await handleHooksRoutes(req, res as unknown as ServerResponse, deps, url.pathname, url);
    return { status: res.statusCode, body: bodyOut };
  };

  beforeEach(() => {
    db = openDatabase(':memory:');
    const project = new ProjectRepository(db).register({
      path: '/p',
      name: 'p',
      token: 't',
      source: 'init',
    });
    new SessionRepository(db).touch('sess', project.id);
    marker = null;
    transcriptKnown = true;
    interrupt.mockReset();
    interrupt.mockResolvedValue({ ok: true, paneId: 'pane-locator' });
    deps = {
      hookSessions: new SessionRepository(db),
      sessionProbe: {
        transcriptPresent: () => (transcriptKnown ? true : null),
        interruptedAt: () => marker,
      },
      messageDeliverer: { interrupt },
    } as unknown as WeaveServerDeps;
  });

  afterEach(() => {
    db.close();
  });

  it('标记落地 → interrupted:true（不再补打）', async () => {
    interrupt.mockImplementation(async () => {
      marker = Date.now();
      return { ok: true, sent: true, paneId: 'pane-locator' };
    });
    const hit = await call();
    expect(hit.status).toBe(200);
    expect(hit.body).toMatchObject({ ok: true, interrupted: true });
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it('第一记没反应、按标题+cwd 补打的是另一个 pane → 补打生效', async () => {
    interrupt.mockImplementation(async (_sid: string, source?: string) => {
      if (source === 'heuristic') marker = Date.now();
      return { ok: true, sent: true, paneId: source === 'heuristic' ? 'pane-title' : 'pane-locator' };
    });
    const hit = await call();
    expect(hit.body).toMatchObject({ ok: true, interrupted: true });
    expect(interrupt).toHaveBeenCalledTimes(2);
    expect(interrupt.mock.calls[1]).toEqual(['sess', 'heuristic', 'pane-locator']);
  });

  it('补打会落到同一个 pane（sent:false，压根没打）→ 如实答「没停」', async () => {
    interrupt.mockImplementation(async (_sid: string, source?: string) => ({
      ok: true,
      paneId: 'pane-locator',
      sent: source !== 'heuristic',
    }));
    const hit = await call();
    expect(hit.body).toMatchObject({ ok: true, interrupted: false });
    expect(interrupt).toHaveBeenCalledTimes(2);
    expect(interrupt.mock.calls[1]).toEqual(['sess', 'heuristic', 'pane-locator']);
  });

  it('转录路径未知（判不了）→ interrupted:null，照旧只报送出', async () => {
    transcriptKnown = false;
    const hit = await call();
    expect(hit.body).toMatchObject({ ok: true, interrupted: null });
    expect(interrupt).toHaveBeenCalledTimes(1);
  });
});
