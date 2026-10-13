import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  openDatabase,
  ProjectRepository,
  HookEventRepository,
  SessionRepository,
  ClaudeCodeAdapter,
  drainInboxOnce,
  WEAVE_VERSION,
} from '@weavecode/server';
import { generateHookHandler } from '@weavecode/harness';

vi.setConfig({ testTimeout: 20000 });

/**
 * Run the generated hook-handler.cjs as a child process, feeding it a stdin
 * payload — no daemon involved (the file pipeline is the whole transport).
 */
function runHandler(handlerPath: string, stdin: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [handlerPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.on('error', () => {}); // child may exit before stdin drains
    child.stdin.write(stdin);
    child.stdin.end();
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', () => resolve());
  });
}

/**
 * End-to-end：真 `hook-handler.cjs` 作为子进程跑，把事件追加到全局
 * `<configDir>/weave/hooks/inbox/`（daemon 全程缺席）；再由消费侧
 * `drainInboxOnce` 认领入库 —— 覆盖「server 没启动不影响 hook 采集」与
 * 「server 起来后积压被消费」两段。
 */
describe('hook-handler.cjs → inbox → 消费线程 end-to-end', () => {
  let db: DatabaseSync;
  let hookEvents: HookEventRepository;
  let hookSessions: SessionRepository;
  let projects: ProjectRepository;
  let projectId: number;
  let projectDir: string;
  let configRoot: string;
  let handlerPath: string;
  let savedAppdata: string | undefined;
  let savedXdg: string | undefined;

  const hooksDir = () => path.join(configRoot, 'weave', 'hooks');
  const drain = () =>
    drainInboxOnce({
      hooksDir: hooksDir(),
      projects,
      hookEvents,
      hookSessions,
      adapters: [new ClaudeCodeAdapter()],
    });

  beforeAll(() => {
    // Isolate the global data dir so hook-handler.cjs writes under our temp root.
    configRoot = mkdtempSync(path.join(tmpdir(), 'weave-e2e-cfg-'));
    if (process.platform === 'win32') {
      savedAppdata = process.env.APPDATA;
      process.env.APPDATA = configRoot;
    } else {
      savedXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = configRoot;
    }

    projectDir = mkdtempSync(path.join(tmpdir(), 'weave-e2e-proj-'));
    db = openDatabase(path.join(projectDir, 'weave.db'));
    projects = new ProjectRepository(db);
    projectId = projects.register({
      path: projectDir,
      name: 'e2e',
      token: 'e2e-token',
      source: 'init',
    }).id;
    hookEvents = new HookEventRepository(db);
    hookSessions = new SessionRepository(db);

    // Project token read by hook-handler.cjs (CLAUDE_PROJECT_DIR/.weave/token).
    mkdirSync(path.join(projectDir, '.weave'), { recursive: true });
    writeFileSync(path.join(projectDir, '.weave', 'token'), 'e2e-token');

    // Generate the real hook handler into the project helpers dir.
    const helpersDir = path.join(projectDir, '.claude', 'helpers');
    mkdirSync(helpersDir, { recursive: true });
    handlerPath = path.join(helpersDir, 'hook-handler.cjs');
    writeFileSync(handlerPath, generateHookHandler(WEAVE_VERSION));
  });

  afterAll(() => {
    db.close();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
    if (process.platform === 'win32') {
      if (savedAppdata === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = savedAppdata;
    } else {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
    }
  });

  it('采集：daemon 缺席也把事件写进全局 inbox（零 HTTP），消费后入库', async () => {
    await runHandler(
      handlerPath,
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: 'e2e-sess',
        tool_name: 'Edit',
        tool_input: { file: 'a.ts' },
        tool_response: { ok: true },
        cwd: projectDir,
        transcript_path: path.join(projectDir, 't.jsonl'),
      }),
      { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    );

    // 落盘即采集完成（消费侧还没跑）——进程退出后文件仍在
    expect(hookEvents.listByProject(projectId)).toHaveLength(0);
    const records = drain();
    expect(records).toHaveLength(1);

    const rows = hookEvents.listByProject(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('claude');
    expect(rows[0].eventType).toBe('PostToolUse');
    expect(rows[0].sessionId).toBe('e2e-sess');
    const norm = JSON.parse(rows[0].payload);
    expect(norm.toolName).toBe('Edit');
    expect(norm.toolInput).toEqual({ file: 'a.ts' });
    // 即删：认领文件消费后不留残迹
    expect(existsSync(path.join(hooksDir(), 'inbox'))).toBe(true);
  });

  it('server 未启动期间的积压：多次 hook 落盘，daemon 起来后一次消费完', async () => {
    for (const [event, session] of [
      ['SessionStart', 's-a'],
      ['UserPromptSubmit', 's-a'],
      ['Stop', 's-a'],
    ] as const) {
      await runHandler(
        handlerPath,
        JSON.stringify({ hook_event_name: event, session_id: session, cwd: projectDir }),
        { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      );
    }
    // 积压全在盘上（采集不丢），一次 drain 全部入库 + 会话 touch
    const records = drain();
    expect(records.map((r) => r.input.eventType)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
    // listByProject 按 id 降序返回，比对集合即可
    expect(hookEvents.listByProject(projectId).map((r) => r.eventType).sort()).toEqual([
      'PostToolUse',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
    expect(hookSessions.getBySessionId('s-a')?.projectId).toBe(projectId);
    // 再 drain 无新记录（文件已清）
    expect(drain()).toHaveLength(0);
  });

  it('未注册项目（无 token）静默退出：既不写 inbox 也不影响退出码', async () => {
    const otherDir = mkdtempSync(path.join(tmpdir(), 'weave-e2e-unreg-'));
    try {
      await expect(
        runHandler(handlerPath, JSON.stringify({ hook_event_name: 'Stop' }), {
          ...process.env,
          CLAUDE_PROJECT_DIR: otherDir,
        }),
      ).resolves.toBeUndefined();
      expect(hookEvents.listByProject(projectId)).toHaveLength(4);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('写入的行形是 {v, token, report}，shard 名 = sha256(token) 前 16 位', async () => {
    await runHandler(
      handlerPath,
      JSON.stringify({ hook_event_name: 'Notification', session_id: 's-line', cwd: projectDir }),
      { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    );
    const shard = createHash('sha256').update('e2e-token').digest('hex').slice(0, 16);
    const file = path.join(hooksDir(), 'inbox', `${shard}.jsonl`);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!) as { v: number; token: string; report: { eventType: string; sessionId: string } };
    expect(line.v).toBe(1);
    expect(line.token).toBe('e2e-token');
    expect(line.report.eventType).toBe('Notification');
    expect(line.report.sessionId).toBe('s-line');
    // 消费侧按 token 归因 → 同样的适配器能归一化它
    expect(drain()).toHaveLength(1);
    expect(hookEvents.listByProject(projectId)).toHaveLength(5);
  });

  it('改名交付回执：mirror 的 pendingTitle 随工具事件下发，回执随采集行回传', async () => {
    mkdirSync(path.join(hooksDir(), 'mirror'), { recursive: true });
    const shard = createHash('sha256').update('e2e-token').digest('hex').slice(0, 16);
    writeFileSync(
      path.join(hooksDir(), 'mirror', `${shard}.json`),
      JSON.stringify({ version: 1, project: 'e2e', pendingTitles: { 's-rename': '回执名' }, rules: [] }),
    );
    await runHandler(
      handlerPath,
      JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's-rename', cwd: projectDir }),
      { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    );
    const records = drain();
    expect(records).toHaveLength(1);
    expect(records[0]!.deliveredTitle).toBe('回执名');
  });
});
