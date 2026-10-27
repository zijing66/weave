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
const paths = vi.hoisted(() => ({ root: '', home: '' }));
vi.mock('../../db/paths.js', () => ({
  getHarnessConfigDir: () => paths.root,
}));
// codex user 档落 <homedir>/.codex——homedir 也得隔离，否则跑一次测试就把真
// ~/.codex/config.toml 覆盖成测试配置（已发生过：备份目录里一串 88B 现场）
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => paths.home,
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
    // codex 的 user 档落 <homedir>/.codex——homedir 隔离到临时目录，别碰真 ~/.codex
    paths.home = join(root, 'home');
    mkdirSync(paths.home, { recursive: true });
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

  it('表单写：整份草稿落盘、未知键保留、留一份备份', async () => {
    const hit = await call('/harness-config/values', 'PUT', {
      harness: 'claude',
      file: 'project',
      projectId,
      values: { model: 'sonnet', env: { FOO: '1' } },
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

  it('漂移：外部改文件后 GET 报 drifted，acceptDrift 用文件覆盖库（原快照先进备份）', async () => {
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
    // 覆盖前原快照（opus）留了一份进备份——误点后能找回
    const backups = accepted.body['backups'] as string[];
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it('恢复备份：先要确认（带两侧文本）→ 确认后覆盖文件与激活快照', async () => {
    const created = await call('/harness-config/profile', 'POST', {
      harness: 'claude',
      file: 'project',
      projectId,
      action: 'create',
      name: '基线',
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

    // 表单写制造一次备份（sonnet 落盘前的 opus 进备份）
    await call('/harness-config/values', 'PUT', {
      harness: 'claude',
      file: 'project',
      projectId,
      values: { model: 'sonnet' },
    });
    expect(readSettings()['model']).toBe('sonnet');

    const view = await call(`/harness-config?harness=claude&file=project&projectId=${projectId}`, 'GET');
    const backupId = (view.body['backups'] as string[])[0];

    const ask = await call('/harness-config/profile', 'POST', {
      harness: 'claude',
      file: 'project',
      projectId,
      action: 'restoreBackup',
      backupId,
    });
    expect(ask.body['requiresConfirm']).toBe(true);
    expect(ask.body['liveText']).toContain('sonnet');
    expect(ask.body['backupText']).toContain('opus');
    expect(readSettings()['model']).toBe('sonnet'); // 此拍不落盘

    const done = await call('/harness-config/profile', 'POST', {
      harness: 'claude',
      file: 'project',
      projectId,
      action: 'restoreBackup',
      backupId,
      confirm: true,
    });
    expect(done.status).toBe(200);
    expect(readSettings()['model']).toBe('opus');
    expect(done.body['activeText']).toContain('opus');
    expect(done.body['drifted']).toBe(false);
  });

  it('preview：草稿 vs 磁盘回两侧原文，不落盘不留备份', async () => {
    const hit = await call('/harness-config/preview', 'POST', {
      harness: 'claude',
      file: 'project',
      projectId,
      values: { model: 'sonnet', env: { FOO: '1' } },
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
    });
    expect(bad.status).toBe(400);
  });

  it('自动基线：project 档（无快照）首次查看立基线，外部改动报漂移，restoreBaseline 恢复', async () => {
    // 首次 GET：立基线，不漂移
    const first = await call(`/harness-config?harness=claude&file=project&projectId=${projectId}`, 'GET');
    expect(first.body['drifted']).toBe(false);

    // 外部改文件 → 漂移可见（这就是 project 档此前丢失的 diff 入口）
    writeFileSync(settingsFile(), JSON.stringify({ model: 'haiku', customKey: { keep: true } }), 'utf8');
    const drifted = await call(`/harness-config?harness=claude&file=project&projectId=${projectId}`, 'GET');
    expect(drifted.body['drifted']).toBe(true);
    expect(drifted.body['activeText']).toContain('opus');

    // restoreBaseline 两拍：先回两侧文本，确认后把基线写回文件
    const ask = await call('/harness-config/profile', 'POST', {
      harness: 'claude',
      file: 'project',
      projectId,
      action: 'restoreBaseline',
    });
    expect(ask.body['requiresConfirm']).toBe(true);
    expect(ask.body['liveText']).toContain('haiku');
    expect(ask.body['baselineText']).toContain('opus');
    expect(readSettings()['model']).toBe('haiku'); // 此拍不落盘

    const done = await call('/harness-config/profile', 'POST', {
      harness: 'claude',
      file: 'project',
      projectId,
      action: 'restoreBaseline',
      confirm: true,
    });
    expect(done.status).toBe(200);
    expect(readSettings()['model']).toBe('opus');
    expect(done.body['drifted']).toBe(false);
  });

  it('自动基线：表单写同步 _lastseen，删掉活跃快照后基线不复活旧值', async () => {
    // 表单写一次（基线跟着走到 sonnet）
    await call('/harness-config/values', 'PUT', {
      harness: 'claude',
      file: 'project',
      projectId,
      values: { model: 'sonnet' },
    });
    const after = await call(`/harness-config?harness=claude&file=project&projectId=${projectId}`, 'GET');
    expect(after.body['drifted']).toBe(false);

    // 建快照并激活，再删掉——基线不应回到更早的 opus
    const created = await call('/harness-config/profile', 'POST', {
      harness: 'claude',
      file: 'project',
      projectId,
      action: 'create',
      name: '临时',
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
    await call('/harness-config/profile', 'POST', {
      harness: 'claude',
      file: 'project',
      projectId,
      action: 'remove',
      id,
    });
    const final = await call(`/harness-config?harness=claude&file=project&projectId=${projectId}`, 'GET');
    expect(final.body['drifted']).toBe(false);
    expect(final.body['activeText']).toContain('sonnet');
  });

  it('compare：profile/backup/live 三种目标都回原文', async () => {
    const created = await call('/harness-config/profile', 'POST', {
      harness: 'claude',
      file: 'project',
      projectId,
      action: 'create',
      name: '基线',
      values: { model: 'haiku' },
    });
    const id = (created.body['profile'] as { id: string }).id;

    const prof = await call('/harness-config/profile', 'POST', {
      harness: 'claude',
      file: 'project',
      projectId,
      action: 'compare',
      target: 'profile',
      id,
    });
    expect(prof.status).toBe(200);
    expect(prof.body['text']).toContain('haiku');

    const live = await call('/harness-config/profile', 'POST', {
      harness: 'claude',
      file: 'project',
      projectId,
      action: 'compare',
      target: 'live',
    });
    expect(live.status).toBe(200);
    expect(live.body['text']).toContain('opus');

    const missing = await call('/harness-config/profile', 'POST', {
      harness: 'claude',
      file: 'project',
      projectId,
      action: 'compare',
      target: 'backup',
      backupId: 'nope',
    });
    expect(missing.status).toBe(404);
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
