import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { handleConfigRoutes } from '../config-routes.js';
import type { WeaveServerDeps } from '../server.js';

// profile/备份落 local/，测试里指到临时目录，别碰真数据目录
const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../../db/paths.js', () => ({
  getHarnessConfigDir: () => paths.root,
}));

/**
 * 配置面路由：词表按 harness 派生（claude=JSON / codex=TOML，rawFormat 随行）、
 * 表单写只动词表内的键、profile 切换先给 diff 再覆盖、外部改文件报漂移。
 */
describe('harness 配置路由', () => {
  let db: ReturnType<typeof openDatabase>;
  let root: string;
  let projectPath: string;
  let deps: WeaveServerDeps;
  let projectId: number;

  const call = async (
    path: string,
    method: 'GET' | 'PUT' | 'POST',
    body?: unknown,
  ): Promise<{ handled: boolean; status: number; body: Record<string, unknown> }> => {
    const req = Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body))]) as unknown as IncomingMessage;
    req.method = method;
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
    const url = new URL(path, 'http://x');
    const handled = await handleConfigRoutes(req, res as unknown as ServerResponse, deps, url.pathname, url);
    return { handled, status: res.statusCode, body: out as Record<string, unknown> };
  };

  const settingsFile = (): string => join(projectPath, '.claude', 'settings.json');
  const readSettings = (): Record<string, unknown> =>
    JSON.parse(readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>;

  beforeEach(() => {
    db = openDatabase(':memory:');
    root = mkdtempSync(join(tmpdir(), 'weave-config-routes-'));
    paths.root = join(root, 'harness-config');
    projectPath = join(root, 'proj');
    mkdirSync(join(projectPath, '.claude'), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ model: 'opus', customKey: { keep: true } }), 'utf8');
    deps = { projects: new ProjectRepository(db) } as unknown as WeaveServerDeps;
    projectId = new ProjectRepository(db).register({
      path: projectPath,
      name: 'p',
      token: 'tok',
      source: 'init',
    }).id;
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('词表：claude（JSON）与 codex（TOML）各有面，rawFormat 随行', async () => {
    const claude = await call('/harness-config/catalog?harness=claude&file=project', 'GET');
    expect(claude.status).toBe(200);
    expect(claude.body['supported']).toBe(true);
    expect(claude.body['rawFormat']).toBe('json');
    expect((claude.body['keys'] as unknown[]).length).toBeGreaterThan(100);
    expect(claude.body['files']).toEqual([
      { id: 'user', profiles: true },
      { id: 'project', profiles: false },
      { id: 'projectLocal', profiles: false },
      { id: 'global', profiles: true },
    ]);

    const codex = await call('/harness-config/catalog?harness=codex&file=user', 'GET');
    expect(codex.status).toBe(200);
    expect(codex.body['supported']).toBe(true);
    expect(codex.body['rawFormat']).toBe('toml');
    expect((codex.body['keys'] as unknown[]).length).toBeGreaterThan(300);
    expect(codex.body['files']).toEqual([
      { id: 'user', profiles: true },
      { id: 'project', profiles: false },
    ]);
  });

  it('读：给路径/值与托管键；project 档缺 projectId 一律拒', async () => {
    const hit = await call(`/harness-config?harness=claude&file=project&projectId=${projectId}`, 'GET');
    expect(hit.status).toBe(200);
    expect(hit.body['path']).toBe(settingsFile());
    // 词表外的键不展示（写回时原样保留，见下一条）
    expect(hit.body['values']).toEqual({ model: 'opus' });
    expect(hit.body['managedKeys']).toEqual([]);
    expect(hit.body['drifted']).toBe(false);

    const missing = await call('/harness-config?harness=claude&file=project', 'GET');
    expect(missing.status).toBe(400);
  });

  it('表单写：落值进文件、未知键保留、留一份备份', async () => {
    const hit = await call('/harness-config/values', 'PUT', {
      harness: 'claude',
      file: 'project',
      projectId,
      updates: [{ path: 'model', value: 'sonnet' }, { path: 'env.FOO', value: '1' }],
    });
    expect(hit.status).toBe(200);
    expect(readSettings()).toEqual({ model: 'sonnet', customKey: { keep: true }, env: { FOO: '1' } });
    expect((hit.body['backups'] as unknown[]).length).toBe(1);
  });

  it('原样写：非法 JSON 400；合法则整份按词表落', async () => {
    const bad = await call('/harness-config/raw', 'PUT', {
      harness: 'claude',
      file: 'project',
      projectId,
      text: '{oops',
    });
    expect(bad.status).toBe(400);

    const ok = await call('/harness-config/raw', 'PUT', {
      harness: 'claude',
      file: 'project',
      projectId,
      text: JSON.stringify({ model: 'haiku' }),
    });
    expect(ok.status).toBe(200);
    expect(readSettings()).toEqual({ model: 'haiku', customKey: { keep: true } });
  });

  it('profile：创建 → 切换先要确认（带两侧文本）→ 确认后整体覆盖并置激活', async () => {
    const created = await call('/harness-config/profile', 'POST', {
      harness: 'claude',
      file: 'project',
      projectId,
      action: 'create',
      name: '基线',
    });
    expect(created.status).toBe(200);
    const id = (created.body['profile'] as { id: string }).id;

    writeFileSync(settingsFile(), JSON.stringify({ model: 'sonnet', customKey: { keep: true } }), 'utf8');
    const ask = await call('/harness-config/profile', 'POST', {
      harness: 'claude',
      file: 'project',
      projectId,
      action: 'activate',
      id,
    });
    expect(ask.body['requiresConfirm']).toBe(true);
    expect(ask.body['liveText']).toContain('sonnet');
    expect(ask.body['profileText']).toContain('opus');
    expect(readSettings()).toEqual({ model: 'sonnet', customKey: { keep: true } });

    const done = await call('/harness-config/profile', 'POST', {
      harness: 'claude',
      file: 'project',
      projectId,
      action: 'activate',
      id,
      confirm: true,
    });
    expect(done.status).toBe(200);
    expect(done.body['activeId']).toBe(id);
    expect(readSettings()).toEqual({ model: 'opus', customKey: { keep: true } });
  });

  it('漂移：外部改文件后 GET 报 drifted，acceptDrift 用文件覆盖库', async () => {
    const created = await call('/harness-config/profile', 'POST', {
      harness: 'claude',
      file: 'project',
      projectId,
      action: 'create',
      name: '库里的',
    });
    const id = (created.body['profile'] as { id: string }).id;
    await call('/harness-config/profile', 'POST', {
      harness: 'claude',
      file: 'project',
      projectId,
      action: 'activate',
      id,
      confirm: true,
    });

    writeFileSync(settingsFile(), JSON.stringify({ model: 'haiku', customKey: { keep: true } }), 'utf8');
    const drifted = await call(`/harness-config?harness=claude&file=project&projectId=${projectId}`, 'GET');
    expect(drifted.body['drifted']).toBe(true);

    const accepted = await call('/harness-config/profile', 'POST', {
      harness: 'claude',
      file: 'project',
      projectId,
      action: 'acceptDrift',
      id,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body['drifted']).toBe(false);
    expect(accepted.body['activeText']).toContain('haiku');
  });

  it('preview：updates 应用在活配置上回前后原文，不落盘不留备份', async () => {
    const hit = await call('/harness-config/preview', 'POST', {
      harness: 'claude',
      file: 'project',
      projectId,
      updates: [{ path: 'model', value: 'sonnet' }, { path: 'env.FOO', value: '1' }],
    });
    expect(hit.status).toBe(200);
    expect(hit.body['before']).toContain('"model": "opus"');
    expect(hit.body['after']).toContain('"model": "sonnet"');
    expect(hit.body['after']).toContain('"FOO": "1"');
    // 不落盘：文件原样、无备份
    expect(readSettings()['model']).toBe('opus');
    const view = await call(`/harness-config?harness=claude&file=project&projectId=${projectId}`, 'GET');
    expect((view.body['backups'] as unknown[]).length).toBe(0);

    const bad = await call('/harness-config/preview', 'POST', {
      harness: 'claude',
      file: 'project',
      updates: [],
    });
    expect(bad.status).toBe(400);
  });

  it('codex：TOML 原样写 → 读回 values；坏 TOML 400', async () => {
    const ok = await call('/harness-config/raw', 'PUT', {
      harness: 'codex',
      file: 'user',
      text: 'model = "gpt-5.2"\n\n[sandbox_workspace_write]\nnetwork_access = true\n',
    });
    expect(ok.status).toBe(200);
    expect(ok.body['values']).toEqual({
      model: 'gpt-5.2',
      sandbox_workspace_write: { network_access: true },
    });
    expect(ok.body['liveText']).toContain('model = "gpt-5.2"');

    const bad = await call('/harness-config/raw', 'PUT', {
      harness: 'codex',
      file: 'user',
      text: 'model = [unclosed\n',
    });
    expect(bad.status).toBe(400);
    expect(String(bad.body['error'])).toContain('TOML');
  });
});
