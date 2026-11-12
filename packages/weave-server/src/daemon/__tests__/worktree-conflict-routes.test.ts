import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { handleHooksRoutes } from '../hooks-routes.js';
import type { WeaveServerDeps } from '../server.js';
import {
  createSessionWorktree,
  readWorktreeRegistry,
  upsertWorktreeEntry,
  defaultWorktreeGitExec,
} from '../worktree.js';
import { MergeLadderRepository } from '../../rpg/merge-ladder.js';
import { mergeSessionWorktreeViaLadder } from '../../rpg/expedition-session.js';

/**
 * B5 并回冲突闭环的两枚 AI 通道按钮的服务端（G6 前置小批；2026-11-10 裁决
 * 「冲突闭环恒走 AI」）：重试 = 放回 active 再扫一轮合并梯；修补 = 在 worktree
 * 原地 resume 该会话（ensureOpen 带 cwd 覆盖）+ 投递带冲突现场的修补 prompt。
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

const write = (root: string, rel: string, body: string): void => {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body);
};

describe('worktree 冲突闭环路由（重试 / 改派修补）', () => {
  let root: string;
  let hooksDir: string;
  let db: ReturnType<typeof openDatabase>;
  let deps: WeaveServerDeps;
  let projectId: number;
  let ensureOpenCalls: Array<[string, unknown]>;
  let sentTexts: string[];

  const SESSION = 'sess-conf-1';

  const call = async (suffix: string): Promise<{ status: number; body: any }> => {
    const req = Readable.from([]) as unknown as IncomingMessage;
    req.method = 'POST';
    let body: any = null;
    const res = {
      statusCode: 0,
      setHeader: () => {},
      end: (chunk?: unknown) => {
        body = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
      },
    };
    const url = new URL(`/sessions/${SESSION}${suffix}`, 'http://x');
    const hit = await handleHooksRoutes(req, res as unknown as ServerResponse, deps, url.pathname, url);
    if (!hit && res.statusCode === 0) throw new Error('route not handled');
    return { status: res.statusCode, body };
  };

  /** 起 worktree + 会话行（claude，最后一条事件 = SessionEnd）+ 登记落指定态。 */
  const seed = async (status: 'conflict' | 'error' | 'active'): Promise<{ path: string; branch: string }> => {
    const created = await createSessionWorktree(root, SESSION);
    if (!created.ok || !created.path || !created.branch) throw new Error('create failed');
    db.prepare('delete from hook_events').run();
    const events = new HookEventRepository(db);
    for (const eventType of ['SessionStart', 'UserPromptSubmit', 'SessionEnd']) {
      events.insert({ projectId, source: 'claude', eventType, sessionId: SESSION, payload: '{}' });
    }
    new SessionRepository(db).touch(SESSION, projectId);
    upsertWorktreeEntry(hooksDir, {
      sessionId: SESSION,
      projectId,
      path: created.path,
      branch: created.branch,
      status,
      at: new Date().toISOString(),
      ...(status !== 'active' ? { message: 'conflict in a.txt' } : {}),
    });
    return { path: created.path, branch: created.branch };
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'weave-wtcr-'));
    hooksDir = mkdtempSync(path.join(tmpdir(), 'weave-wtcr-hooks-'));
    git(['init', '-b', 'main'], root);
    git(['config', 'user.email', 'test@example.invalid'], root);
    git(['config', 'user.name', 'weave-test'], root);
    write(root, 'a.txt', 'base\n');
    git(['add', '-A'], root);
    git(['commit', '-qm', 'init'], root);
    db = openDatabase(':memory:');
    projectId = new ProjectRepository(db).register({
      path: root,
      name: 'p',
      token: 't',
      source: 'init',
    }).id;
    ensureOpenCalls = [];
    sentTexts = [];
    deps = {
      hookSessions: new SessionRepository(db),
      hookEvents: new HookEventRepository(db),
      projects: new ProjectRepository(db),
      hooksDir,
      worktreeGitExec: defaultWorktreeGitExec,
      mergeViaLadder: (projectPath, entry) =>
        mergeSessionWorktreeViaLadder(
          { exec: defaultWorktreeGitExec, ladder: new MergeLadderRepository(db) },
          projectPath,
          entry,
        ),
      ensureOpen: (async (id: string, opts?: { cwd?: string }) => {
        ensureOpenCalls.push([id, opts ?? {}]);
        return { ok: true, ack: 'session-start' };
      }) as WeaveServerDeps['ensureOpen'],
      messageDeliverer: {
        send: (async (input: { text: string }) => {
          sentTexts.push(input.text);
          return { ok: true, messageId: 'm1', status: 'queued', message: { id: 'm1' } };
        }) as WeaveServerDeps['messageDeliverer'],
      } as unknown as WeaveServerDeps['messageDeliverer'],
    } as unknown as WeaveServerDeps;
  });

  afterEach(() => {
    db.close();
    try {
      git(['worktree', 'prune'], root);
    } catch {
      /* root 已在（个别用例删过） */
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(hooksDir, { recursive: true, force: true });
  });

  it.skipIf(!hasGit)('重试 · 无冲突积欠：扫一轮梯直接并回，登记清账', async () => {
    const wt = await seed('conflict');
    // 会话侧产出（主干无改动 → 重试即干净并回）
    write(wt.path, 'b.txt', 'ok\n');
    git(['add', '-A'], wt.path);
    git(['commit', '-qm', 'wt ok'], wt.path);
    const hit = await call('/worktree/merge-retry');
    expect(hit.status).toBe(200);
    expect(hit.body).toMatchObject({ ok: true, merged: true });
    expect(readWorktreeRegistry(hooksDir)[SESSION]).toBeUndefined();
    expect(git(['log', '--oneline'], root)).toContain('wt ok');
  });

  it.skipIf(!hasGit)('重试 · 仍冲突：如实带状态与消息回落，worktree 现场保留', async () => {
    const wt = await seed('conflict');
    write(root, 'a.txt', 'main side\n');
    git(['add', '-A'], root);
    git(['commit', '-qm', 'main change'], root);
    write(wt.path, 'a.txt', 'wt side\n');
    git(['add', '-A'], wt.path);
    git(['commit', '-qm', 'wt change'], wt.path);
    const hit = await call('/worktree/merge-retry');
    expect(hit.status).toBe(200);
    expect(hit.body).toMatchObject({ ok: false, merged: false, status: 'conflict' });
    const after = readWorktreeRegistry(hooksDir)[SESSION]!;
    expect(after.status).toBe('conflict');
    expect(existsSync(wt.path)).toBe(true);
    // 主干无残留
    expect(git(['status', '--porcelain'], root)).toBe('');
  });

  it.skipIf(!hasGit)('重试 · 只有冲突/失败态可重试（active 409）', async () => {
    await seed('active');
    const hit = await call('/worktree/merge-retry');
    expect(hit.status).toBe(409);
  });

  it.skipIf(!hasGit)('重试 · 无登记 404', async () => {
    const hit = await call('/worktree/merge-retry');
    expect(hit.status).toBe(404);
  });

  it.skipIf(!hasGit)('修补 · 在 worktree 原地 resume（ensureOpen 带 cwd 覆盖）+ prompt 带冲突现场', async () => {
    const wt = await seed('conflict');
    const hit = await call('/worktree/repair');
    expect(hit.status).toBe(200);
    expect(hit.body).toMatchObject({ ok: true, repaired: true });
    // 拉起：同一会话、落点 = worktree 原地（转录按 cwd 落 slug，换目录 resume 认不到）
    expect(ensureOpenCalls).toEqual([[SESSION, { cwd: wt.path }]]);
    // 投递：手动面同口径 prompt 通道 + forceTerminal；正文带分支/主支与冲突摘要
    expect(sentTexts).toHaveLength(1);
    expect(sentTexts[0]).toContain(wt.branch);
    expect(sentTexts[0]).toContain('main');
    expect(sentTexts[0]).toContain('git merge main');
    // 登记放回 active：修补会话再退出时 sweeper 自动接续并回
    expect(readWorktreeRegistry(hooksDir)[SESSION]!.status).toBe('active');
  });

  it.skipIf(!hasGit)('修补 · 只有冲突态可修补（error 409）', async () => {
    await seed('error');
    const hit = await call('/worktree/repair');
    expect(hit.status).toBe(409);
  });

  it.skipIf(!hasGit)('修补 · worktree 目录没了：409 不瞎投', async () => {
    const wt = await seed('conflict');
    git(['worktree', 'remove', '--force', wt.path], root);
    const hit = await call('/worktree/repair');
    expect(hit.status).toBe(409);
    expect(ensureOpenCalls).toHaveLength(0);
  });
});
