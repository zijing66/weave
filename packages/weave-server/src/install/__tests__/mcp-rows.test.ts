import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readMcpRows } from '../mcp-rows.js';
import { setCodexConfigFileOverride } from '../codex-toml.js';

let fakeHome: string;
let projectDir: string;
let origHome: string | undefined;
let origProfile: string | undefined;

beforeAll(() => {
  origHome = process.env.HOME;
  origProfile = process.env.USERPROFILE;
  fakeHome = mkdtempSync(join(tmpdir(), 'weave-mcprows-home-'));
  projectDir = mkdtempSync(join(tmpdir(), 'weave-mcprows-proj-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  writeFileSync(
    join(projectDir, '.mcp.json'),
    JSON.stringify({ mcpServers: { alpha: { command: 'npx' }, denied: { command: 'node' } } }),
  );
  mkdirSync(join(projectDir, '.claude'), { recursive: true });
  writeFileSync(
    join(projectDir, '.claude', 'settings.json'),
    JSON.stringify({ disabledMcpjsonServers: ['denied'] }),
  );
  mkdirSync(join(fakeHome, '.codex'), { recursive: true });
  writeFileSync(
    join(fakeHome, '.codex', 'config.toml'),
    '# rows\n[mcp_servers.zeta]\ncommand = "uvx"\n',
  );
  setCodexConfigFileOverride(join(fakeHome, '.codex', 'config.toml'));
});

afterAll(() => {
  setCodexConfigFileOverride(null);
  process.env.HOME = origHome;
  process.env.USERPROFILE = origProfile;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe('readMcpRows — 工具行装配（模型协议 ToolStateRow）', () => {
  it('sanity: homedir 隔离生效（user 面文件都落 fakeHome）', () => {
    expect(homedir()).toBe(fakeHome);
  });

  it('三个 (harness, scope) 面各出一行，installScopes 随行携带', async () => {
    const rows = await readMcpRows(projectDir);
    const pick = (harness: string, key: string) => rows.find((r) => r.harness === harness && r.key === key);

    // claude 项目面：.mcp.json
    const alpha = pick('claude', 'alpha');
    expect(alpha?.scope).toBe('project');
    expect(alpha?.installScopes).toEqual(['project', 'user']);
    expect(alpha?.detail).toEqual({ command: 'npx' });

    // claude user 面：~/.claude.json（此环境无该文件 → 空，不炸）
    expect(rows.filter((r) => r.harness === 'claude' && r.scope === 'user')).toEqual([]);

    // codex user 面：config.toml
    const zeta = pick('codex', 'zeta');
    expect(zeta?.scope).toBe('user');
    expect(zeta?.installScopes).toEqual(['user']);
    expect(zeta?.detail).toEqual({ command: 'uvx' });
  });

  it('启停链：override 优先，inherit 跟随 enableAll（未放行 = false）', async () => {
    const rows = await readMcpRows(projectDir);
    const pick = (key: string) => rows.find((r) => r.harness === 'claude' && r.key === key)!;

    // alpha：无覆盖 → inherit，effective = enableAll = false
    expect(pick('alpha').enable).toBe('inherit');
    expect(pick('alpha').effective).toBe(false);
    // denied：显式 disabled → off / false
    expect(pick('denied').enable).toBe('off');
    expect(pick('denied').effective).toBe(false);
  });

  it('user 面行无启停语义（enable = null，effective 恒 true）', async () => {
    const rows = await readMcpRows(projectDir);
    const zeta = rows.find((r) => r.harness === 'codex')!;
    expect(zeta.enable).toBeNull();
    expect(zeta.effective).toBe(true);
  });
});
