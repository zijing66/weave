import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import type { SpawnOptions } from 'node:child_process';
import type { HookDispatchStatus } from '@weavecode/core';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { HookRuleRepository } from '../../repositories/hook-rules.js';
import { HookDispatchRepository } from '../../repositories/hook-dispatches.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { HookEventBus, type HookBusMessage } from '../bus.js';
import { ResumeRunner, type ResumeRunnerDeps, type SpawnLike } from '../resume-runner.js';

const PROJECT_PATH = resolve('/resume-proj');
const SESSION_ID = 'sess-resume';

/** 结构上满足 SpawnChild.stdin 的假管道：记录 prompt 写入。 */
class FakeStdin extends EventEmitter {
  readonly writes: string[] = [];
  write(chunk: string): void {
    this.writes.push(chunk);
  }
  end(): void {}
}

/** 结构上满足 SpawnChild 的假子进程：测试手动触发 exit/error/data 事件。 */
class FakeChild extends EventEmitter {
  readonly pid = 4242;
  readonly stdin = new FakeStdin();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

interface SpawnCall {
  cmd: string;
  args: readonly string[];
  options: SpawnOptions;
}

/** 注入 ResumeRunner 的假 spawn：记录调用参数并返回可手动驱动的子进程。 */
function createFakeSpawn() {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawnImpl: SpawnLike = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { calls, children, spawnImpl };
}

describe('ResumeRunner', () => {
  let db: ReturnType<typeof openDatabase>;
  let projects: ProjectRepository;
  let dispatches: HookDispatchRepository;
  let sessions: SessionRepository;
  let bus: HookEventBus;
  let busEvents: HookBusMessage[];
  let ruleId: string;
  let seq = 0;

  const insertDispatch = (
    status: HookDispatchStatus = 'pending',
    sessionId: string = SESSION_ID,
  ) =>
    dispatches.insert({
      ruleId,
      sessionId,
      prompt: `指令 ${++seq}`,
      status,
      mode: 'manual',
    });

  const makeRunner = (spawnImpl: SpawnLike, extra: Partial<ResumeRunnerDeps> = {}) =>
    new ResumeRunner({
      dispatches,
      sessions,
      projects,
      bus,
      spawnImpl,
      claudeBin: 'fake-claude',
      ...extra,
    });

  beforeEach(() => {
    db = openDatabase(':memory:');
    projects = new ProjectRepository(db);
    const project = projects.register({
      path: PROJECT_PATH,
      name: 'resume',
      token: 'rtoken',
      source: 'init',
    });
    dispatches = new HookDispatchRepository(db);
    sessions = new SessionRepository(db);
    bus = new HookEventBus();
    busEvents = [];
    bus.subscribe((m) => busEvents.push(m));
    ruleId = new HookRuleRepository(db).create({
      name: 'resume 规则',
      projectId: null,
      source: { kind: 'claude-event', event: 'PostToolUse' },
      handler: { type: 'manual', template: '执行 {event}' },
    }).id;
    sessions.touch(SESSION_ID, project.id);
    seq = 0;
  });

  afterEach(() => {
    db.close();
  });

  it('成功：spawn 参数正确，退出 0 落 succeeded + output + started/finished 事件', async () => {
    const fake = createFakeSpawn();
    const runner = makeRunner(fake.spawnImpl);
    const dispatch = insertDispatch();

    // 模拟 daemon 启于 Claude Code 会话内：环境带 child-session 标记
    const hadMarker = 'CLAUDE_CODE_CHILD_SESSION' in process.env;
    process.env['CLAUDE_CODE_CHILD_SESSION'] = '1';
    try {
      const result = await runner.run(dispatch.id, SESSION_ID);
      expect(result).toEqual({ ok: true, dispatchId: dispatch.id });
    } finally {
      if (hadMarker) process.env['CLAUDE_CODE_CHILD_SESSION'] = '1';
      else delete process.env['CLAUDE_CODE_CHILD_SESSION'];
    }

    // run() 返回时应已置 running 且 spawn 参数符合规格
    expect(dispatches.getById(dispatch.id)?.status).toBe('running');
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    // CLAUDE_RESUME.promptStdin：prompt 不上命令行、经 stdin 传递。win32 裸名
    // bin 走 shell（joined 单串、免 detached），其余平台 bin+args 直接 spawn。
    const onWin = process.platform === 'win32';
    expect(call.cmd).toBe(onWin ? `fake-claude --resume ${SESSION_ID} -p` : 'fake-claude');
    expect(call.args).toEqual(onWin ? [] : ['--resume', SESSION_ID, '-p']);
    expect(call.options.cwd).toBe(PROJECT_PATH);
    expect(call.options.detached).toBe(!onWin);
    expect(call.options.windowsHide).toBe(true);
    expect(call.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(call.options.shell).toBe(onWin ? true : undefined);
    expect(fake.children[0]!.stdin.writes).toEqual([dispatch.prompt]);
    expect(call.options.env?.WEAVE_HOOK_DISPATCH).toBe('1');
    // resume 出的是正常会话：child-session 标记必须被剥离（否则 transcript 不落盘）
    expect(call.options.env?.['CLAUDE_CODE_CHILD_SESSION']).toBeUndefined();
    expect(busEvents).toContainEqual(
      expect.objectContaining({ kind: 'dispatch.started', dispatchId: dispatch.id, sessionId: SESSION_ID }),
    );

    fake.children[0]!.stdout.emit('data', Buffer.from('claude 输出'));
    fake.children[0]!.emit('exit', 0, null);

    const row = dispatches.getById(dispatch.id)!;
    expect(row.status).toBe('succeeded');
    expect(row.output).toContain('claude 输出');
    expect(row.finishedAt).not.toBeNull();
    expect(busEvents).toContainEqual(
      expect.objectContaining({ kind: 'dispatch.finished', dispatchId: dispatch.id, status: 'succeeded' }),
    );
  });

  it('非 0 退出 → failed，error 含 exit code 与 stderr 尾部', async () => {
    const fake = createFakeSpawn();
    const runner = makeRunner(fake.spawnImpl);
    const dispatch = insertDispatch();
    await runner.run(dispatch.id, SESSION_ID);

    fake.children[0]!.stderr.emit('data', Buffer.from('stderr 尾巴'));
    fake.children[0]!.emit('exit', 7, null);

    const row = dispatches.getById(dispatch.id)!;
    expect(row.status).toBe('failed');
    expect(row.error).toContain('exit 7');
    expect(row.error).toContain('stderr 尾巴');
    expect(row.finishedAt).not.toBeNull();
    expect(busEvents).toContainEqual(
      expect.objectContaining({ kind: 'dispatch.finished', dispatchId: dispatch.id, status: 'failed' }),
    );
  });

  it('超时：killImpl 被调、落 timeout + finished 事件', async () => {
    const fake = createFakeSpawn();
    const killImpl = vi.fn();
    const runner = makeRunner(fake.spawnImpl, { timeoutMs: 30, killImpl });
    const dispatch = insertDispatch();

    expect(await runner.run(dispatch.id, SESSION_ID)).toEqual({
      ok: true,
      dispatchId: dispatch.id,
    });
    // fake 不发 exit，等超时定时器落定
    await vi.waitFor(
      () => expect(dispatches.getById(dispatch.id)?.status).toBe('timeout'),
      { timeout: 2000, interval: 10 },
    );
    expect(killImpl).toHaveBeenCalledWith(4242);
    expect(dispatches.getById(dispatch.id)?.finishedAt).not.toBeNull();
    expect(busEvents).toContainEqual(
      expect.objectContaining({ kind: 'dispatch.finished', dispatchId: dispatch.id, status: 'timeout' }),
    );
  });

  it('校验链：dispatch 404 / 已 running 409 / session 404 / 无 project 400，且均不 spawn', async () => {
    const fake = createFakeSpawn();
    const runner = makeRunner(fake.spawnImpl);

    expect(await runner.run(99_999, SESSION_ID)).toMatchObject({ ok: false, status: 404 });

    const runningDispatch = insertDispatch('running');
    expect(await runner.run(runningDispatch.id, SESSION_ID)).toMatchObject({ ok: false, status: 409 });

    const pending = insertDispatch('pending');
    expect(await runner.run(pending.id, 'sess-unknown')).toMatchObject({ ok: false, status: 404 });

    sessions.touch('sess-noproject', null);
    const orphan = insertDispatch('pending', 'sess-noproject');
    expect(await runner.run(orphan.id, 'sess-noproject')).toMatchObject({ ok: false, status: 400 });

    expect(fake.calls).toHaveLength(0);
    expect(dispatches.getById(pending.id)?.status).toBe('pending');
    expect(dispatches.getById(orphan.id)?.status).toBe('pending');
  });

  it('同 session 并发闸：退出前第二条 409，退出后放行', async () => {
    const fake = createFakeSpawn();
    const runner = makeRunner(fake.spawnImpl);
    const first = insertDispatch();
    const second = insertDispatch();

    expect(await runner.run(first.id, SESSION_ID)).toEqual({ ok: true, dispatchId: first.id });
    expect(await runner.run(second.id, SESSION_ID)).toMatchObject({ ok: false, status: 409 });
    expect(fake.calls).toHaveLength(1);

    // 第一条退出 → 闸打开，第二条可执行
    fake.children[0]!.emit('exit', 0, null);
    expect(dispatches.getById(first.id)?.status).toBe('succeeded');
    expect(await runner.run(second.id, SESSION_ID)).toEqual({ ok: true, dispatchId: second.id });
    expect(fake.calls).toHaveLength(2);

    fake.children[1]!.emit('exit', 0, null);
    expect(dispatches.getById(second.id)?.status).toBe('succeeded');
  });

  it('spawn error（如 ENOENT）→ failed', async () => {
    const fake = createFakeSpawn();
    const runner = makeRunner(fake.spawnImpl);
    const dispatch = insertDispatch();
    await runner.run(dispatch.id, SESSION_ID);

    fake.children[0]!.emit('error', new Error('spawn ENOENT'));

    const row = dispatches.getById(dispatch.id)!;
    expect(row.status).toBe('failed');
    expect(row.error).toContain('ENOENT');
    expect(row.finishedAt).not.toBeNull();
    expect(busEvents).toContainEqual(
      expect.objectContaining({ kind: 'dispatch.finished', dispatchId: dispatch.id, status: 'failed' }),
    );
  });
});
