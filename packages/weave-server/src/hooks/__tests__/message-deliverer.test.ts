import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import type { SpawnOptions } from 'node:child_process';
import type { MessagingSurface } from '@weavecode/harness';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { SessionMessageRepository } from '../../repositories/session-messages.js';
import { HookDispatchRepository } from '../../repositories/hook-dispatches.js';
import { HookRuleRepository } from '../../repositories/hook-rules.js';
import { HookEventBus, type HookBusMessage } from '../bus.js';
import { HeadlessRunner, type SpawnLike } from '../headless-runner.js';
import { MessageDeliverer, type MessageDelivererDeps, type SendResult } from '../message-deliverer.js';
import { ResumeRunner } from '../resume-runner.js';
import { hookShardId } from '../mirror.js';

const PROJECT_PATH = '/msg-proj';
const TOKEN = 'mtoken';
const SESSION_ID = 'sess-msg';
const CODEX_SESSION = 'sess-cdx';

class FakeChild extends EventEmitter {
  readonly pid = 7777;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

interface SpawnCall {
  cmd: string;
  args: readonly string[];
  options: SpawnOptions;
}

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

describe('MessageDeliverer 裁决表', () => {
  let db: ReturnType<typeof openDatabase>;
  let sessions: SessionRepository;
  let events: HookEventRepository;
  let messages: SessionMessageRepository;
  let bus: HookEventBus;
  let busEvents: HookBusMessage[];
  let projectId: number;
  let hooksDir: string;

  const pushEvent = (sessionId: string, eventType: string, source: 'claude' | 'codex' = 'claude') =>
    events.insert({ projectId, source, eventType, sessionId, payload: '{}' });

  const makeDeps = (extra: Partial<MessageDelivererDeps> = {}): MessageDelivererDeps => ({
    messages,
    sessions,
    projects: new ProjectRepository(db),
    hookEvents: events,
    bus,
    hooksDir,
    ...extra,
  });

  const send = (deliverer: MessageDeliverer, body: Record<string, unknown>) =>
    deliverer.send({
      toSessionId: SESSION_ID,
      text: 'hello',
      mode: 'auto',
      fromKind: 'dashboard',
      ...body,
    });

  beforeEach(() => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const project = projects.register({
      path: PROJECT_PATH,
      name: 'msg',
      token: TOKEN,
      source: 'init',
    });
    projectId = project.id;
    sessions = new SessionRepository(db);
    events = new HookEventRepository(db);
    messages = new SessionMessageRepository(db);
    bus = new HookEventBus();
    busEvents = [];
    bus.subscribe((m) => busEvents.push(m));
    sessions.touch(SESSION_ID, projectId);
    sessions.touch(CODEX_SESSION, projectId);
    hooksDir = mkdtempSync(join(tmpdir(), 'weave-msg-'));
  });

  afterEach(() => {
    db.close();
    rmSync(hooksDir, { recursive: true, force: true });
  });

  it('会话不存在 → 404，且不落行', async () => {
    const deliverer = new MessageDeliverer(makeDeps());
    const result = await send(deliverer, { toSessionId: 'sess-unknown' });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(messages.listBySession('sess-unknown')).toHaveLength(0);
  });

  it('harness 无法判定（零事件）→ 400', async () => {
    const deliverer = new MessageDeliverer(makeDeps());
    const result = await send(deliverer, { toSessionId: CODEX_SESSION });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it('codex 面：inject / headless / auto 任一模式均 409 + 面内原因', async () => {
    const deliverer = new MessageDeliverer(makeDeps());
    pushEvent(CODEX_SESSION, 'Stop', 'codex');
    const inject = await deliverer.send({
      toSessionId: CODEX_SESSION,
      text: 'hi',
      mode: 'inject',
      fromKind: 'dashboard',
    });
    expect(inject).toMatchObject({ ok: false, status: 409 });
    expect((inject as Extract<SendResult, { ok: false }>).error).toContain('Codex');

    const headless = await deliverer.send({
      toSessionId: CODEX_SESSION,
      text: 'hi',
      mode: 'headless',
      fromKind: 'dashboard',
    });
    expect(headless).toMatchObject({ ok: false, status: 409 });

    // auto 闲 → headless（null → 409）；忙 → inject（null → 409）：全通道 null 无路可走
    const autoIdle = await deliverer.send({
      toSessionId: CODEX_SESSION,
      text: 'hi',
      mode: 'auto',
      fromKind: 'dashboard',
    });
    expect(autoIdle).toMatchObject({ ok: false, status: 409 });
    expect(messages.listBySession(CODEX_SESSION)).toHaveLength(0);
  });

  it('inject 通道：信封落 outbox → injected + deliveredAt + created/delivered 帧', async () => {
    const deliverer = new MessageDeliverer(makeDeps());
    pushEvent(SESSION_ID, 'UserPromptSubmit');

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'hello body',
      mode: 'inject',
      fromKind: 'dashboard',
    });
    expect(result).toMatchObject({ ok: true, status: 'injected' });

    const lines = readFileSync(join(hooksDir, 'outbox', `${hookShardId(TOKEN)}.jsonl`), 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as { sessionId: string; text: string; at: string };
    expect(entry.sessionId).toBe(SESSION_ID);
    expect(entry.text).toContain('[weave message] from=dashboard');
    expect(entry.text).toContain('mode=inject');
    expect(entry.text.endsWith('hello body')).toBe(true);

    const row = messages.listBySession(SESSION_ID)[0]!;
    expect(row.status).toBe('injected');
    expect(row.deliveredAt).not.toBeNull();
    expect(row.mode).toBe('inject');
    expect(busEvents).toContainEqual(
      expect.objectContaining({ kind: 'message.created', sessionId: SESSION_ID }),
    );
    expect(busEvents).toContainEqual(
      expect.objectContaining({ kind: 'message.delivered', messageId: row.id }),
    );
  });

  it('headless 通道：spawn 参数带信封、running → 退出 0 落 succeeded + finished 帧', async () => {
    const fake = createFakeSpawn();
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, bin: 'fake-claude' }),
    );
    pushEvent(SESSION_ID, 'Stop');

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'run this',
      mode: 'headless',
      fromKind: 'dashboard',
    });
    expect(result).toMatchObject({ ok: true, status: 'running' });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.cmd).toBe('fake-claude');
    expect(fake.calls[0]!.args).toEqual(['--resume', SESSION_ID, '-p', expect.stringContaining('run this')]);
    expect(fake.calls[0]!.options.cwd).toBe(PROJECT_PATH);

    fake.children[0]!.stdout.emit('data', Buffer.from('answer'));
    fake.children[0]!.emit('exit', 0, null);

    const row = messages.listBySession(SESSION_ID)[0]!;
    expect(row.status).toBe('succeeded');
    expect(row.output).toContain('answer');
    expect(row.finishedAt).not.toBeNull();
    expect(busEvents).toContainEqual(
      expect.objectContaining({ kind: 'message.finished', messageId: row.id, status: 'succeeded' }),
    );
  });

  it('auto 忙（turnOpen）→ inject 落 outbox，绝不无头抢占', async () => {
    const deliverer = new MessageDeliverer(makeDeps());
    pushEvent(SESSION_ID, 'UserPromptSubmit');
    pushEvent(SESSION_ID, 'Stop');
    pushEvent(SESSION_ID, 'UserPromptSubmit'); // 回合开

    const result = await send(deliverer, {});
    expect(result).toMatchObject({ ok: true, status: 'injected' });
    expect(messages.listBySession(SESSION_ID)[0]!.mode).toBe('auto');
    expect(readFileSync(join(hooksDir, 'outbox', `${hookShardId(TOKEN)}.jsonl`), 'utf8')).toContain(
      'mode=inject',
    );
  });

  it('auto 闲 → headless 强制回合', async () => {
    const fake = createFakeSpawn();
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, bin: 'fake-claude' }),
    );
    pushEvent(SESSION_ID, 'UserPromptSubmit');
    pushEvent(SESSION_ID, 'Stop'); // 回合合

    const result = await send(deliverer, {});
    expect(result).toMatchObject({ ok: true, status: 'running' });
    expect(fake.calls).toHaveLength(1);
    expect(messages.listBySession(SESSION_ID)[0]!.mode).toBe('auto');
  });

  it('auto 忙 + 面无 inject 通道 → 409（不降级无头抢占）', async () => {
    const noInject: MessagingSurface = {
      harness: 'claude',
      discovery: true,
      inject: null,
      headless: {
        supported: true,
        bin: 'claude',
        args: (sessionId: string, prompt: string) => ['--resume', sessionId, '-p', prompt],
      },
      idleSignals: ['Stop'],
      unsupportedReasons: { inject: 'test harness has no inject channel' },
    };
    const deliverer = new MessageDeliverer(makeDeps({ surfaceFor: () => noInject }));
    pushEvent(SESSION_ID, 'UserPromptSubmit');

    const result = await send(deliverer, {});
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as Extract<SendResult, { ok: false }>).error).toContain('no inject channel');
    expect(messages.listBySession(SESSION_ID)).toHaveLength(0);
  });

  it('auto 闲 + 面无 headless 通道 → 409', async () => {
    const noHeadless: MessagingSurface = {
      harness: 'claude',
      discovery: true,
      inject: { rideEvents: ['UserPromptSubmit'] },
      headless: null,
      idleSignals: ['Stop'],
      unsupportedReasons: { headless: 'test harness has no headless channel' },
    };
    const deliverer = new MessageDeliverer(makeDeps({ surfaceFor: () => noHeadless }));
    pushEvent(SESSION_ID, 'Stop');

    const result = await send(deliverer, {});
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as Extract<SendResult, { ok: false }>).error).toContain('no headless channel');
  });

  it('无项目 → 400（两通道都需要项目）', async () => {
    sessions.touch('sess-orphan', null);
    pushEvent('sess-orphan', 'UserPromptSubmit');
    const deliverer = new MessageDeliverer(makeDeps());
    const result = await send(deliverer, { toSessionId: 'sess-orphan' });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it('headless 被占 → 409；与 ResumeRunner 共享并发闸（跨域）', async () => {
    const fake = createFakeSpawn();
    const headless = new HeadlessRunner({ spawnImpl: fake.spawnImpl });
    const projects = new ProjectRepository(db);
    const dispatches = new HookDispatchRepository(db);
    const ruleId = new HookRuleRepository(db)
      .create({
        name: '规则',
        projectId: null,
        source: { kind: 'claude-event', event: 'PostToolUse' },
        handler: { type: 'manual', template: 'x' },
      })
      .id;
    const dispatch = dispatches.insert({
      ruleId,
      sessionId: SESSION_ID,
      prompt: 'dispatch prompt',
      status: 'pending',
      mode: 'manual',
    });
    const resumeRunner = new ResumeRunner({
      dispatches,
      sessions,
      projects,
      bus,
      claudeBin: 'fake-claude',
      headless,
    });
    const deliverer = new MessageDeliverer(makeDeps({ headless }));
    pushEvent(SESSION_ID, 'Stop'); // 闲 → 双方都走 headless

    expect(await resumeRunner.run(dispatch.id, SESSION_ID)).toMatchObject({ ok: true });
    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'hello',
      mode: 'headless',
      fromKind: 'dashboard',
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(fake.calls).toHaveLength(1); // 只有 dispatch 的 spawn

    // dispatch 退出 → 闸开，消息可投
    fake.children[0]!.emit('exit', 0, null);
    const retry = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'hello',
      mode: 'headless',
      fromKind: 'dashboard',
    });
    expect(retry).toMatchObject({ ok: true, status: 'running' });
    expect(fake.calls).toHaveLength(2);
  });

  it('信封覆写：面 renderEnvelope 生效', async () => {
    const custom: MessagingSurface = {
      harness: 'claude',
      discovery: true,
      inject: { rideEvents: ['UserPromptSubmit'] },
      headless: null,
      idleSignals: ['Stop'],
      renderEnvelope: (text, meta) => `«${meta.fromLabel}|${meta.mode}» ${text}`,
    };
    const deliverer = new MessageDeliverer(makeDeps({ surfaceFor: () => custom }));
    pushEvent(SESSION_ID, 'UserPromptSubmit');

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'payload',
      mode: 'inject',
      fromKind: 'session',
      fromSessionId: 'sess-from',
    });
    expect(result).toMatchObject({ ok: true, status: 'injected' });
    const lines = readFileSync(join(hooksDir, 'outbox', `${hookShardId(TOKEN)}.jsonl`), 'utf8');
    expect(lines).toContain('«session sess-from|inject» payload');
  });

  it('headless 非 0 退出 → failed（error 含 stderr 尾部）', async () => {
    const fake = createFakeSpawn();
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, bin: 'fake-claude' }),
    );
    pushEvent(SESSION_ID, 'Stop');
    await send(deliverer, { mode: 'headless' });

    fake.children[0]!.stderr.emit('data', Buffer.from('boom'));
    fake.children[0]!.emit('exit', 3, null);

    const row = messages.listBySession(SESSION_ID)[0]!;
    expect(row.status).toBe('failed');
    expect(row.error).toContain('exit 3');
    expect(row.error).toContain('boom');
  });

  it('headless 超时 → timeout + kill', async () => {
    const fake = createFakeSpawn();
    const killImpl = vi.fn();
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, bin: 'fake-claude', timeoutMs: 30, killImpl }),
    );
    pushEvent(SESSION_ID, 'Stop');
    await send(deliverer, { mode: 'headless' });

    await vi.waitFor(() => expect(messages.listBySession(SESSION_ID)[0]!.status).toBe('timeout'), {
      timeout: 2000,
      interval: 10,
    });
    expect(killImpl).toHaveBeenCalledWith(7777);
  });

  it('线程双向：listBySession 圈收发两端', async () => {
    const deliverer = new MessageDeliverer(makeDeps());
    pushEvent(SESSION_ID, 'UserPromptSubmit');
    pushEvent('sess-other', 'UserPromptSubmit');
    sessions.touch('sess-other', projectId);

    await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'in',
      mode: 'inject',
      fromKind: 'session',
      fromSessionId: 'sess-other',
    });
    const thread = messages.listBySession('sess-other');
    expect(thread).toHaveLength(1);
    expect(thread[0]!.fromSessionId).toBe('sess-other');
    expect(thread[0]!.toSessionId).toBe(SESSION_ID);
  });
});
