import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { handleHooksRoutes } from '../hooks-routes.js';
import type { WeaveServerDeps } from '../server.js';

/**
 * `POST /sessions/:id/interrupt`：ESC 送进运行中的会话 = **必然中断**（2026-10-28
 * 裁决）——宿主收到 ESC 就停，只是中断标记要等工具收尾才写进转录（实测 10–29s）。
 * 故键送出即 200，不做「等标记确认」的阻塞轮询（那只会把「正在停」误报成失败）；
 * 「已中断」的呈现交给 interruptRefresher 在标记落地后推 sessionInterrupt 帧。
 */
describe('中断路由：一记 ESC，送出即成功', () => {
  let db: ReturnType<typeof openDatabase>;
  let deps: WeaveServerDeps;
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
    vi.useFakeTimers();
    db = openDatabase(':memory:');
    const project = new ProjectRepository(db).register({
      path: '/p',
      name: 'p',
      token: 't',
      source: 'init',
    });
    new SessionRepository(db).touch('sess', project.id);
    interrupt.mockReset();
    interrupt.mockResolvedValue({ ok: true, paneId: 'pane-locator', sent: true });
    deps = {
      hookSessions: new SessionRepository(db),
      messageDeliverer: { interrupt },
    } as unknown as WeaveServerDeps;
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('键送出 → 200 立即返回，不轮询转录、不补打第二记', async () => {
    const hit = await call();
    expect(hit.status).toBe(200);
    expect(hit.body).toMatchObject({ ok: true });
    expect(hit.body).not.toHaveProperty('interrupted');
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(interrupt).toHaveBeenCalledWith('sess');
    // 两拍探针已排（标记落地后由它们推 sessionInterrupt）
    expect(vi.getTimerCount()).toBe(2);
  });

  it('投递侧拒绝（找不到 pane 等 409）→ 原样透传', async () => {
    interrupt.mockResolvedValue({ ok: false, status: 409, error: '找不到会话所在的终端窗口' });
    const hit = await call();
    expect(hit.status).toBe(409);
    expect(hit.body).toMatchObject({ error: '找不到会话所在的终端窗口' });
    expect(interrupt).toHaveBeenCalledTimes(1);
  });
});
