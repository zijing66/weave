import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { WatchService } from '../watch/watch-service.js';
import { createWeaveServer } from '../daemon/server.js';
import { ApiLogger } from '../daemon/api-log.js';

vi.setConfig({ testTimeout: 20000 });

/**
 * 路由面：GET /installations（跨项目安装位置聚合）。HOME/USERPROFILE 隔离控
 * user 档文件（~/.claude.json 的 mcpServers、~/.claude/skills、~/.claude/commands），
 * 两个注册项目各 seed 项目档资产（真 WatchService 等初始扫描）。**不带 toolkit**
 * ——顺带验证可选依赖缺席时端点不 500（toolkit 轴为空、其余轴照常）。
 */

interface Row {
  kind: string;
  name: string;
  key?: string;
  projectId: number | null;
  projectName: string | null;
  scope: string;
  harness: string;
}

describe('daemon server — GET /installations', () => {
  let server: Server;
  let db: DatabaseSync;
  let port: number;
  let home: string;
  let projA: string;
  let projB: string;
  let watch: WatchService;
  // 接口日志写入是异步串行链：不注入就拿共享实例，清理时删不掉它的目录。
  let apiLog: ApiLogger;
  const envBak: Record<string, string | undefined> = {};
  let rows: Row[];

  beforeAll(async () => {
    for (const k of ['HOME', 'USERPROFILE', 'APPDATA', 'XDG_CONFIG_HOME', 'CODEX_HOME']) {
      envBak[k] = process.env[k];
    }
    home = mkdtempSync(join(tmpdir(), 'weave-inst-home-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.APPDATA = home;
    process.env.XDG_CONFIG_HOME = home;
    mkdirSync(join(home, '.codex'), { recursive: true });
    process.env.CODEX_HOME = join(home, '.codex');

    // 全局轴 seed：个人 skill + 机器级文件资产 + user 档 MCP
    mkdirSync(join(home, '.claude/skills/bar'), { recursive: true });
    writeFileSync(join(home, '.claude/skills/bar/SKILL.md'), '# Bar');
    mkdirSync(join(home, '.claude/commands'), { recursive: true });
    writeFileSync(join(home, '.claude/commands/x.md'), '# x');
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { usermcp: { command: 'npx' } } }, null, 2),
    );

    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const seed = (name: string): { id: number; dir: string } => {
      const dir = mkdtempSync(join(tmpdir(), `weave-inst-${name}-`));
      // 多文件 skill 目录：watch 按文件展开 AssetEntry，聚合须按 skill 名去重
      mkdirSync(join(dir, '.claude/skills/foo'), { recursive: true });
      writeFileSync(join(dir, '.claude/skills/foo/SKILL.md'), '# Foo');
      writeFileSync(join(dir, '.claude/skills/foo/reference.md'), '# ref');
      writeFileSync(
        join(dir, '.mcp.json'),
        JSON.stringify({ mcpServers: { alpha: { command: 'npx' } } }, null, 2),
      );
      const row = projects.register({ path: dir, name, token: `t-${name}`, source: 'init' });
      return { id: row.id, dir };
    };
    const a = seed('a');
    const b = seed('b');
    projA = a.dir;
    projB = b.dir;

    watch = new WatchService(projects, { debounceMs: 30, reconcileMs: 60_000 });
    watch.start();
    apiLog = new ApiLogger();
    server = createWeaveServer({ projects, port: 0, watch, apiLog });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;

    // 等初始扫描把两个项目的资产填进缓存再查
    await vi.waitFor(
      () => {
        expect(watch.getAssets(projA).length).toBeGreaterThanOrEqual(2);
        expect(watch.getAssets(projB).length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 5000 },
    );

    const res = await fetch(`http://127.0.0.1:${port}/api/installations`);
    expect(res.status).toBe(200);
    rows = ((await res.json()) as { installations: Row[] }).installations;
  });

  afterAll(async () => {
    watch.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await apiLog.onIdle();
    db.close();
    for (const [k, v] of Object.entries(envBak)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(projA, { recursive: true, force: true });
    rmSync(projB, { recursive: true, force: true });
  });

  it('项目档 skill 出现在两个项目行下（scope project）', () => {
    const foo = rows.filter((r) => r.kind === 'skill' && r.name === 'foo');
    expect(foo).toHaveLength(2);
    expect(new Set(foo.map((r) => r.projectName))).toEqual(new Set(['a', 'b']));
    expect(foo.every((r) => r.scope === 'project' && r.harness === 'claude')).toBe(true);
  });

  it('项目档 MCP 出现在两个项目行下', () => {
    const alpha = rows.filter((r) => r.kind === 'mcp' && r.name === 'alpha');
    expect(alpha).toHaveLength(2);
    expect(alpha.every((r) => r.scope === 'project')).toBe(true);
  });

  it('全局个人 skill 只出一条（projectId null, scope user）', () => {
    const bar = rows.filter((r) => r.kind === 'skill' && r.name === 'bar');
    expect(bar).toHaveLength(1);
    expect(bar[0]).toMatchObject({ projectId: null, scope: 'user', harness: 'claude' });
  });

  it('机器级文件资产出一条 user 行（file stem 为名）', () => {
    const x = rows.filter((r) => r.kind === 'command' && r.name === 'x');
    expect(x).toHaveLength(1);
    expect(x[0]).toMatchObject({ projectId: null, scope: 'user' });
  });

  it('user 档 MCP 跨项目去重：恰一条全局行', () => {
    const usermcp = rows.filter((r) => r.kind === 'mcp' && r.name === 'usermcp');
    expect(usermcp).toHaveLength(1);
    expect(usermcp[0]).toMatchObject({ projectId: null, scope: 'user', harness: 'claude' });
  });

  it('未装内置 MCP 的占位行不出现（不是安装事实）', () => {
    const builtin = rows.filter(
      (r) => r.kind === 'mcp' && r.name !== 'alpha' && r.name !== 'usermcp',
    );
    expect(builtin).toHaveLength(0);
  });

  it('POST 不允许', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/installations`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});
