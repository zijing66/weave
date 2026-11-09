import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntimeRegistry } from '@weavecode/harness';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { MessageDeliverer } from '../../hooks/message-deliverer.js';
import { createWeaveServer } from '../../daemon/server.js';
import { setDaemonSettingsDb, writeDaemonSettings } from '../../daemon/settings.js';
import { RpgRoleRepository, RpgGrowthRepository } from '../roles.js';
import { RpgExpeditionRepository } from '../expedition-repo.js';
import { MergeLadderRepository } from '../merge-ladder.js';
import { defaultWorktreeGitExec } from '../../daemon/worktree.js';
import type { ProjectOpener } from '../../daemon/opener.js';

/**
 * 出征会话路由接线 e2e（G3 段0 验收，真 git + REST）：POST
 * /rpg/roles/:id/expeditions（出征起手：worktree + 锚定 + kit + 落
 * rpg_expeditions 行）→ worktree 内产出 commit → POST /rpg/expeditions/:id/merge
 * （合并梯）→ rpg_merge_ladder 落行 + 出征行 status='merged'。悬空场景：锚分支被
 * 删 → 并回落 dangling。
 */
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'weave-test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'weave-test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });

describe('出征会话路由接线（真 git，REST 全链）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let rolesRoot: string;
  let projectRoot: string;
  let runDirs: string[];
  const tmpDirs: string[] = [];
  let roleProjectPath = '';

  const call = (method: string, url: string, body?: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    db = openDatabase(':memory:');
    setDaemonSettingsDb(db);
    await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
    });
    rolesRoot = mkdtempSync(path.join(tmpdir(), 'weave-g3-roles-'));
    tmpDirs.push(rolesRoot);
    const hooksTmp = mkdtempSync(path.join(tmpdir(), 'weave-g3-hooks-'));
    tmpDirs.push(hooksTmp);
    runDirs = [];
    const opener: ProjectOpener = {
      openExplorer: async () => {},
      openTerminal: async () => {},
      runInTerminal: async (dir) => {
        runDirs.push(dir);
      },
    };
    const projects = new ProjectRepository(db);
    server = createWeaveServer({
      projects,
      port: 0,
      harnesses: createRuntimeRegistry(),
      opener,
      hooksDir: hooksTmp,
      worktreeGitExec: defaultWorktreeGitExec,
      rpgRoles: new RpgRoleRepository(db),
      rpgGrowth: new RpgGrowthRepository(db),
      rpgRolesRoot: rolesRoot,
      messageDeliverer: new MessageDeliverer({
        sessions: new SessionRepository(db),
        projects,
        hookEvents: new HookEventRepository(db),
        hooksDir: hooksTmp,
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;

    // 目标项目：真 git 仓 + 注册（init 选择结果写 .weave/config.yaml，canStartSession 走注册表）
    projectRoot = mkdtempSync(path.join(tmpdir(), 'weave-g3-target-'));
    tmpDirs.push(projectRoot);
    git(['init', '-b', 'main'], projectRoot);
    git(['config', 'user.email', 'test@example.invalid'], projectRoot);
    git(['config', 'user.name', 'weave-test'], projectRoot);
    writeFileSync(path.join(projectRoot, 'base.txt'), 'base\n');
    git(['add', '-A'], projectRoot);
    git(['commit', '-qm', 'init'], projectRoot);
    mkdirSync(path.join(projectRoot, '.weave'), { recursive: true });
    writeFileSync(
      path.join(projectRoot, '.weave', 'config.yaml'),
      'harnesses: ["claude"]\n',
      'utf8',
    );
    projects.register({ path: projectRoot, name: 'target', token: 't-target', source: 'init' });
  });

  afterAll(async () => {
    server.close();
    db.close();
    setDaemonSettingsDb(null);
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('① 建角色（带 skill 声明 + 物化源目录）', async () => {
    const res = await call('POST', '/rpg/roles', { name: 'gardener', archetype: '创造' });
    expect(res.status).toBe(201);
    const role = (await res.json()) as { id: number; path: string };
    roleProjectPath = role.path;
    // 声明 + 物化一个 skill 源目录（kit 的输入）
    const skillDir = path.join(roleProjectPath, '.claude', 'skills', 'farming');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '# 种田\n', 'utf8');
    writeFileSync(
      path.join(roleProjectPath, '.weave', 'role.json'),
      JSON.stringify({ skills: ['farming'] }) + '\n',
      'utf8',
    );
  });

  it.runIf(hasGit)('② 出征起手：POST /rpg/roles/:id/expeditions → rpg_expeditions 落行 + kit 装进 worktree', async () => {
    const roles = (await (await call('GET', '/rpg/roles')).json()) as {
      roles: Array<{ id: number; projectId: number }>;
    };
    const role = roles.roles[0]!;
    // 目标项目行：按 path 反查 id
    const exps = await call('POST', `/rpg/roles/${role.id}/expeditions`, { projectId: 0 });
    expect(exps.status).toBe(404); // 非法项目先被拒
    const projectId = (await (await call('GET', '/projects')).json() as { projects: Array<{ id: number; path: string }> })
      .projects.find((p) => p.path === projectRoot)!.id;
    const res = await call('POST', `/rpg/roles/${role.id}/expeditions`, { projectId });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      expedition: { id: number; sessionKey: string; branch: string; anchorBranch: string; anchorSha: string; status: string };
      worktreePath: string;
      kitSkills: string[];
    };
    expect(body.expedition.status).toBe('active');
    expect(body.expedition.anchorBranch).toBe('main');
    expect(body.expedition.branch).toMatch(/^weave\/session-/);
    expect(body.expedition.sessionKey).toMatch(/^pending-/);
    expect(body.kitSkills).toEqual(['gardener-farming']);
    expect(runDirs).toEqual([body.worktreePath]);
    // kit 目录真在 worktree 里
    expect(require('node:fs').existsSync(path.join(body.worktreePath, '.claude', 'skills', 'gardener-farming', 'SKILL.md'))).toBe(true);
  });

  it.runIf(hasGit)('③ 并回走合并梯：POST /rpg/expeditions/:id/merge → rpg_merge_ladder 落行 + status=merged', async () => {
    const roles = (await (await call('GET', '/rpg/roles')).json()) as { roles: Array<{ id: number }> };
    const role = roles.roles[0]!;
    const projectId = (await (await call('GET', '/projects')).json() as { projects: Array<{ id: number; path: string }> })
      .projects.find((p) => p.path === projectRoot)!.id;
    const start = (await (await call('POST', `/rpg/roles/${role.id}/expeditions`, { projectId })).json()) as {
      expedition: { id: number };
      worktreePath: string;
    };
    // 角色在 worktree 里产出
    const wt = start.worktreePath;
    writeFileSync(path.join(wt, 'harvest.txt'), 'turnip\n', 'utf8');
    git(['add', '-A'], wt);
    git(['commit', '-qm', 'harvest'], wt);
    const res = await call('POST', `/rpg/expeditions/${start.expedition.id}/merge`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; layer: string; into: string };
    expect(body).toMatchObject({ ok: true, layer: 'mechanical', into: 'main' });
    // 账：rpg_merge_ladder 一行（expedition 外键随行）+ 出征行 merged
    const dbRepo = new MergeLadderRepository(db);
    const rows = dbRepo.listByProject(projectId);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.expedition).toBe(start.expedition.id);
    expect(rows[0]!.layer).toBe('mechanical');
    expect(rows[0]!.outcome).toBe('ok');
    const expeditions = new RpgExpeditionRepository(db);
    expect(expeditions.getById(start.expedition.id)!.status).toBe('merged');
    // 主干 main 引用已含角色产出
    const log = git(['log', '--oneline', 'main'], projectRoot);
    expect(log).toContain('harvest');
  });

  it.runIf(hasGit)('④ 悬空：锚分支被删 → 并回落 dangling、出征行落 dangling', async () => {
    const roles = (await (await call('GET', '/rpg/roles')).json()) as { roles: Array<{ id: number }> };
    const role = roles.roles[0]!;
    const projectId = (await (await call('GET', '/projects')).json() as { projects: Array<{ id: number; path: string }> })
      .projects.find((p) => p.path === projectRoot)!.id;
    const start = (await (await call('POST', `/rpg/roles/${role.id}/expeditions`, { projectId })).json()) as {
      expedition: { id: number; branch: string };
      worktreePath: string;
    };
    writeFileSync(path.join(start.worktreePath, 'orphan.txt'), 'x\n', 'utf8');
    git(['add', '-A'], start.worktreePath);
    git(['commit', '-qm', 'orphan'], start.worktreePath);
    // 用户切走并删掉锚分支 main
    git(['checkout', '-b', 'other'], projectRoot);
    git(['branch', '-D', 'main'], projectRoot);
    const res = await call('POST', `/rpg/expeditions/${start.expedition.id}/merge`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('dangling');
    expect(new RpgExpeditionRepository(db).getById(start.expedition.id)!.status).toBe('dangling');
    // 角色提交仍在对象库
    expect(git(['rev-parse', '--verify', `${start.expedition.branch}^{commit}`], projectRoot)).toBeTruthy();
    // 恢复 main 给后续用例
    git(['checkout', '-b', 'main'], projectRoot);
  });

  it.runIf(hasGit)('⑤ 冲突：合并梯打回 → 出征行 conflict + ladder returned 行', async () => {
    const roles = (await (await call('GET', '/rpg/roles')).json()) as { roles: Array<{ id: number }> };
    const role = roles.roles[0]!;
    const projectId = (await (await call('GET', '/projects')).json() as { projects: Array<{ id: number; path: string }> })
      .projects.find((p) => p.path === projectRoot)!.id;
    const start = (await (await call('POST', `/rpg/roles/${role.id}/expeditions`, { projectId })).json()) as {
      expedition: { id: number };
      worktreePath: string;
    };
    // 主干先改 base.txt
    writeFileSync(path.join(projectRoot, 'base.txt'), 'user changed\n', 'utf8');
    git(['add', '-A'], projectRoot);
    git(['commit', '-qm', 'user change'], projectRoot);
    // 角色也改 base.txt
    writeFileSync(path.join(start.worktreePath, 'base.txt'), 'role changed\n', 'utf8');
    git(['add', '-A'], start.worktreePath);
    git(['commit', '-qm', 'role change'], start.worktreePath);
    const res = await call('POST', `/rpg/expeditions/${start.expedition.id}/merge`);
    expect(res.status).toBe(409);
    const expeditions = new RpgExpeditionRepository(db);
    expect(expeditions.getById(start.expedition.id)!.status).toBe('conflict');
    const rows = new MergeLadderRepository(db).listByProject(projectId);
    expect(rows[0]!.outcome).toBe('returned');
    expect(rows[0]!.expedition).toBe(start.expedition.id);
    // 主干工作区干净（abort 还原了）
    expect(git(['status', '--porcelain'], projectRoot)).toBe('');
  });
});
