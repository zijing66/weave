import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { setDaemonSettingsDb } from '../settings.js';
import { handleSettingsRoutes } from '../routes/settings-statusline.js';
import type { WeaveServerDeps } from '../server.js';

// readAiKey/readDecisionKey 缺省路径走真数据目录——mock 掉 db/paths 隔离到临时目录
const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../../db/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/paths.js')>()),
  getAiKeyPath: () => join(paths.root, 'ai.json'),
  getDecisionKeyPath: () => join(paths.root, 'decision.json'),
}));

/** GET /settings 的「关于」展示面：version/repoUrl 随行下发（设置页只读）。 */
describe('GET /settings — 关于字段', () => {
  let db: ReturnType<typeof openDatabase>;
  let root: string;
  let deps: WeaveServerDeps;

  const call = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
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
    const url = new URL('/settings', 'http://x');
    await handleSettingsRoutes(req, res as unknown as ServerResponse, deps, url.pathname, url);
    return { status: res.statusCode, body: out as Record<string, unknown> };
  };

  beforeEach(() => {
    db = openDatabase(':memory:');
    setDaemonSettingsDb(db);
    root = mkdtempSync(join(tmpdir(), 'weave-settings-routes-'));
    paths.root = root;
    deps = {
      port: 6420,
      aiKeyPath: join(root, 'ai.json'),
      decisionKeyPath: join(root, 'decision.json'),
    } as unknown as WeaveServerDeps;
  });

  afterEach(() => {
    setDaemonSettingsDb(null);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('version 与 repoUrl 随 GET /settings 下发', async () => {
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(typeof body.version).toBe('string');
    expect((body.version as string).length).toBeGreaterThan(0);
    expect(body.repoUrl).toBe('https://github.com/zijing66/weave');
    // settings/presets/platform 既有字段不因新增而缺席
    expect(body.settings).toBeTruthy();
    expect(Array.isArray(body.presets)).toBe(true);
    expect(typeof body.platform).toBe('string');
  });
});
