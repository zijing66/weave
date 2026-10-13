import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPluginRows } from '../plugin-rows.js';

let fakeHome: string;
let projectDir: string;
let origHome: string | undefined;
let origProfile: string | undefined;

beforeAll(() => {
  origHome = process.env.HOME;
  origProfile = process.env.USERPROFILE;
  fakeHome = mkdtempSync(join(tmpdir(), 'weave-plugrows-home-'));
  projectDir = mkdtempSync(join(tmpdir(), 'weave-plugrows-proj-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  // user 档覆写（~/.claude/settings.json）+ 安装记录（installed_plugins.json）
  mkdirSync(join(fakeHome, '.claude', 'plugins'), { recursive: true });
  writeFileSync(
    join(fakeHome, '.claude', 'settings.json'),
    JSON.stringify({
      enabledPlugins: { 'a@weave': true, 'gone@weave': false, 'c@weave': true },
    }),
  );
  writeFileSync(
    join(fakeHome, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'a@weave': [
          { scope: 'user', version: '1.0.0' },
          { scope: 'local', version: '1.0.0' },
        ],
        'b@weave': [{ scope: 'project', version: '1.0.0' }],
      },
    }),
  );
  // 项目档覆写（settings.json）+ local 档覆写（settings.local.json）
  mkdirSync(join(projectDir, '.claude'), { recursive: true });
  writeFileSync(
    join(projectDir, '.claude', 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'b@weave': false } }),
  );
  writeFileSync(
    join(projectDir, '.claude', 'settings.local.json'),
    JSON.stringify({ enabledPlugins: { 'a@weave': false } }),
  );
  // codex 仅启用面：~/.codex/config.toml
  mkdirSync(join(fakeHome, '.codex'), { recursive: true });
  writeFileSync(
    join(fakeHome, '.codex', 'config.toml'),
    '[plugins."cx@weave"]\nenabled = true\n',
  );
});

afterAll(() => {
  process.env.HOME = origHome;
  process.env.USERPROFILE = origProfile;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

const pick = (rows: Awaited<ReturnType<typeof readPluginRows>>, key: string, scope: string) =>
  rows.find((r) => r.key === key && r.scope === scope)!;

describe('readPluginRows — 插件工具行装配（模型协议 ToolStateRow）', () => {
  it('键 × 档成行：install 逐记录分桶、enable 逐档覆写、effective 链解析', async () => {
    const rows = await readPluginRows(projectDir);

    // a@weave：user 记录 + local 记录；local off 压过 user on（链 local > project > user）
    expect(pick(rows, 'a@weave', 'user')).toMatchObject({
      harness: 'claude', category: 'plugin', install: 'installed', enable: 'on', effective: false,
    });
    expect(pick(rows, 'a@weave', 'project')).toMatchObject({
      install: 'absent', enable: 'inherit', effective: false,
    });
    expect(pick(rows, 'a@weave', 'local')).toMatchObject({
      install: 'installed', enable: 'off', effective: false,
    });

    // b@weave：仅 project 记录；project off、user 未覆写（inherit ≠ false）
    expect(pick(rows, 'b@weave', 'user')).toMatchObject({
      install: 'absent', enable: 'inherit', effective: false,
    });
    expect(pick(rows, 'b@weave', 'project')).toMatchObject({
      install: 'installed', enable: 'off', effective: false,
    });

    // c@weave：仅 user 覆写 true，无安装记录——覆写残留行如实报
    expect(pick(rows, 'c@weave', 'user')).toMatchObject({
      install: 'absent', enable: 'on', effective: true,
    });
    expect(rows.filter((r) => r.key === 'c@weave')).toHaveLength(3);

    // gone@weave：无记录仅 user off
    expect(pick(rows, 'gone@weave', 'user')).toMatchObject({
      install: 'absent', enable: 'off', effective: false,
    });
  });

  it('行行携带 installScopes（claude 三档）', async () => {
    const rows = await readPluginRows(projectDir);
    expect(rows.filter((r) => r.harness === 'claude')).not.toHaveLength(0);
    for (const r of rows.filter((r) => r.harness === 'claude')) {
      expect(r.installScopes).toEqual(['user', 'project', 'local']);
    }
  });

  it('仅启用面 harness（codex）：user 单行、无安装语义', async () => {
    const rows = await readPluginRows(projectDir);
    const cx = rows.find((r) => r.harness === 'codex' && r.key === 'cx@weave');
    expect(cx).toMatchObject({
      scope: 'user', installScopes: [], enable: 'on', effective: true, category: 'plugin',
    });
    expect(cx?.install).toBeUndefined();
  });

  it('全链无覆写回落 false（未声明 = 不加载，CC 三阶段模型）', async () => {
    const rows = await readPluginRows(projectDir);
    expect(pick(rows, 'b@weave', 'local')).toMatchObject({
      enable: 'inherit', effective: false,
    });
  });
});
