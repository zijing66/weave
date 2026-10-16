import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { DataBus, type DataFrame } from '../daemon/data-bus.js';
import { createWeaveServer } from '../daemon/server.js';
import { WEAVE_VERSION } from '../version.js';

/**
 * 路由面：GET/PUT /capture（§6-2d user 档采集）。HOME/USERPROFILE 隔离
 * user 档文件；已注册项目带旧 weave 采集组，验证安装时的项目档去重。
 */
let db: DatabaseSync;
let server: Server;
let port: number;
let projectId: number;
let projectDir: string;
let fakeHome: string;
let origHome: string | undefined;
let origProfile: string | undefined;
const frames: DataFrame[] = [];

const PROJECT_USER_GROUP = {
  matcher: 'Write',
  hooks: [{ type: 'command', command: 'node /user/audit.cjs' }],
};

beforeAll(async () => {
  origHome = process.env.HOME;
  origProfile = process.env.USERPROFILE;
  fakeHome = mkdtempSync(join(tmpdir(), 'weave-capture-home-'));
  projectDir = mkdtempSync(join(tmpdir(), 'weave-capture-proj-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  // user settings：既有用户内容 + 用户 hook 组（安装只动 weave 组）
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  writeFileSync(
    join(fakeHome, '.claude', 'settings.json'),
    JSON.stringify({ model: 'opus', hooks: { PreToolUse: [PROJECT_USER_GROUP] } }),
  );
  // 项目 settings：旧 weave 采集组 + 用户组（PUT enabled 后 weave 组应被清）
  mkdirSync(join(projectDir, '.claude'), { recursive: true });
  writeFileSync(
    join(projectDir, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: `node "${join(projectDir, '.claude', 'helpers')}/hook-handler.cjs"`,
              },
            ],
          },
          PROJECT_USER_GROUP,
        ],
      },
    }),
  );

  db = openDatabase(':memory:');
  const projects = new ProjectRepository(db);
  const row = projects.register({ path: projectDir, name: 'p', token: 't', source: 'init' });
  projectId = row.id;
  const dataBus = new DataBus();
  dataBus.subscribe((frame) => frames.push(frame));
  server = createWeaveServer({ projects, port: 0, dataBus });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server.close();
  db.close();
  process.env.HOME = origHome;
  process.env.USERPROFILE = origProfile;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

const url = (p: string): string => `http://127.0.0.1:${port}/api${p}`;

const put = (body: unknown): Promise<Response> =>
  fetch(url('/capture'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('daemon /capture', () => {
  it('GET：初始未安装（installed/helperPresent 全 false）', async () => {
    const res = await fetch(url('/capture'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      rows: Array<{ harness: string; installed: boolean; helperPresent: boolean }>;
    };
    // 只有 claude 声明了 capture 槽；codex 无该能力不出现（不写白名单）
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({ harness: 'claude', installed: false, helperPresent: false });
  });

  it('PUT 安装：user settings 落组+脚本，项目档旧 weave 组清光、用户组保留', async () => {
    const res = await put({ harness: 'claude', enabled: true });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { installed: boolean; helperPresent: boolean };
    expect(data).toMatchObject({ installed: true, helperPresent: true });

    const user = JSON.parse(await readFile(join(fakeHome, '.claude', 'settings.json'), 'utf8')) as {
      model: string;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(user.model).toBe('opus'); // 用户其余键不动
    expect(Object.keys(user.hooks).sort()).toEqual([
      'Notification',
      'PostToolUse',
      'PreCompact',
      'PreToolUse',
      'SessionStart',
      'Stop',
      'SubagentStop',
      'UserPromptSubmit',
    ]);
    // 用户组在前 + weave 组并入（双注册共存时用户组永不被碰）
    expect(user.hooks.PreToolUse[0]).toEqual(PROJECT_USER_GROUP);
    expect(user.hooks.PreToolUse[1]!.hooks[0]!.command).toContain('hook-handler.cjs');

    const script = await readFile(join(fakeHome, '.claude', 'helpers', 'hook-handler.cjs'), 'utf8');
    expect(script).toContain(`@version weave@${WEAVE_VERSION}`);

    const project = JSON.parse(
      await readFile(join(projectDir, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: Record<string, unknown> };
    // 项目档去重：weave 组清光、用户组保留
    expect(project.hooks.PreToolUse).toEqual([PROJECT_USER_GROUP]);

    expect(frames).toContainEqual({ key: 'capture' });
  });

  it('PUT 停用：user settings weave 组清光（用户组与键保留）、脚本移除', async () => {
    const res = await put({ harness: 'claude', enabled: false });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { installed: boolean; helperPresent: boolean };
    expect(data).toMatchObject({ installed: false, helperPresent: false });

    const user = JSON.parse(await readFile(join(fakeHome, '.claude', 'settings.json'), 'utf8')) as {
      model: string;
      hooks: Record<string, unknown>;
    };
    expect(user.model).toBe('opus');
    expect(user.hooks.PreToolUse).toEqual([PROJECT_USER_GROUP]);

    expect(existsSync(join(fakeHome, '.claude', 'helpers', 'hook-handler.cjs'))).toBe(false);
  });

  it('PUT 参数校验：非法 harness / 非布尔 enabled → 400', async () => {
    expect((await put({ harness: 'gemini', enabled: true })).status).toBe(400);
    expect((await put({ harness: 'claude', enabled: 'on' })).status).toBe(400);
    expect((await fetch(url('/capture'), { method: 'POST' })).status).toBe(405);
  });
});
