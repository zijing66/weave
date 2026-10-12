import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { HookRuleRepository } from '../../repositories/hook-rules.js';
import { HookDispatchRepository } from '../../repositories/hook-dispatches.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { ClaudeEventSource } from '@weavecode/harness';
import { HookRuleRegistry } from '../registry.js';
import { HookEventBus, type HookBusMessage } from '../bus.js';
import { HookDispatcher } from '../dispatcher.js';
import { setDaemonSettingsDb, writeDaemonSettings } from '../../daemon/settings.js';
import {
  INBOX_CLAIM_SUFFIX,
  INBOX_FAILED_SUFFIX,
  drainInboxOnce,
  handleIngestedRecords,
  type InboxDrainDeps,
} from '../inbox-worker.js';
import { hookShardId, outboxPathOf } from '../mirror.js';

const TOKEN = 'tok-inbox';

function inboxLine(token: string, eventType: string, sessionId = 's1'): string {
  return (
    JSON.stringify({
      v: 1,
      token,
      report: {
        source: 'claude',
        eventType,
        sessionId,
        cwd: '/proj',
        payload: JSON.stringify({ hook_event_name: eventType, session_id: sessionId, cwd: '/proj' }),
      },
    }) + '\n'
  );
}

describe('drainInboxOnce：inbox 认领 → 入库 → 即删', () => {
  let db: DatabaseSync;
  let hooksDir: string;
  let projects: ProjectRepository;
  let hookEvents: HookEventRepository;
  let hookSessions: SessionRepository;
  let projectId: number;

  const inbox = () => path.join(hooksDir, 'inbox');
  const deps = (over: Partial<InboxDrainDeps> = {}): InboxDrainDeps => ({
    hooksDir,
    projects,
    hookEvents,
    hookSessions,
    adapters: [new ClaudeEventSource()],
    ...over,
  });

  beforeEach(async () => {
    db = openDatabase(':memory:');
    projects = new ProjectRepository(db);
    projectId = projects.register({ path: '/proj', name: 'p', token: TOKEN, source: 'init' }).id;
    hookEvents = new HookEventRepository(db);
    hookSessions = new SessionRepository(db);
    hooksDir = await mkdtemp(path.join(tmpdir(), 'weave-inbox-'));
    mkdirSync(inbox(), { recursive: true });
  });

  afterEach(async () => {
    db.close();
    await rm(hooksDir, { recursive: true, force: true });
  });

  it('同一 shard 的整批入库，文件（含 claim）即删，返回与 inputs 对齐的记录', () => {
    const file = path.join(inbox(), `${hookShardId(TOKEN)}.jsonl`);
    writeFileSync(file, inboxLine(TOKEN, 'PostToolUse') + inboxLine(TOKEN, 'Stop', 's2'));

    const records = drainInboxOnce(deps());
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.projectId === projectId)).toBe(true);
    expect(records.map((r) => r.input.eventType)).toEqual(['PostToolUse', 'Stop']);

    const rows = hookEvents.listByProject(projectId);
    expect(rows.map((r) => r.eventType).sort()).toEqual(['PostToolUse', 'Stop']);
    // 会话 touch：两条不同会话各建一行
    expect(hookSessions.list(projectId)).toHaveLength(2);

    expect(existsSync(file)).toBe(false);
    expect(existsSync(file.replace('.jsonl', INBOX_CLAIM_SUFFIX))).toBe(false);
  });

  it('坏行/未知 token 行直接丢，不拖垮同文件的好行', () => {
    const file = path.join(inbox(), `${hookShardId(TOKEN)}.jsonl`);
    writeFileSync(
      file,
      'not-json\n' +
        JSON.stringify({ v: 1, report: { source: 'claude', eventType: 'Stop' } }) + '\n' +
        inboxLine('unknown-token', 'Stop', 's9') +
        inboxLine(TOKEN, 'SessionStart') +
        JSON.stringify({ v: 1, token: TOKEN, report: { source: 'codex', eventType: 'X' } }) + '\n',
    );

    const records = drainInboxOnce(deps());
    expect(records).toHaveLength(1);
    expect(hookEvents.listByProject(projectId).map((r) => r.eventType)).toEqual(['SessionStart']);
    expect(existsSync(file)).toBe(false);
  });

  it('崩在半途的残留 claim 先被消费（顺序在前），活文件随后认领', () => {
    const shard = hookShardId(TOKEN);
    const claim = path.join(inbox(), `${shard}${INBOX_CLAIM_SUFFIX}`);
    const live = path.join(inbox(), `${shard}.jsonl`);
    writeFileSync(claim, inboxLine(TOKEN, 'Stop', 'crash'));
    writeFileSync(live, inboxLine(TOKEN, 'SessionStart', 'later'));

    const records = drainInboxOnce(deps());
    expect(records.map((r) => r.input.sessionId)).toEqual(['crash', 'later']);
    expect(existsSync(claim)).toBe(false);
    expect(existsSync(live)).toBe(false);
  });

  it('入库失败留盘重试；连续失败达上限 parked 为 .failed.jsonl（不再热循环）', () => {
    const failing = {
      insertMany: () => {
        throw new Error('db down');
      },
    } as unknown as HookEventRepository;
    const file = path.join(inbox(), `${hookShardId(TOKEN)}.jsonl`);
    writeFileSync(file, inboxLine(TOKEN, 'Stop'));
    const attempts = new Map<string, number>();

    for (let i = 0; i < 4; i++) drainInboxOnce(deps({ hookEvents: failing }), attempts);
    const claim = file.replace('.jsonl', INBOX_CLAIM_SUFFIX);
    expect(existsSync(claim)).toBe(true); // 仍留盘等重试

    drainInboxOnce(deps({ hookEvents: failing }), attempts);
    expect(existsSync(claim)).toBe(false);
    const parked = file.replace('.jsonl', INBOX_FAILED_SUFFIX);
    expect(existsSync(parked)).toBe(true); // 停放保数据、不再每 tick 重试
    expect(readFileSync(parked, 'utf8').trim()).not.toBe('');
  });

  it('token 轮换：同一文件里的两个 token 各自归因，互不牵连', () => {
    const other = projects.register({ path: '/other', name: 'o', token: 'tok-other', source: 'init' });
    const file = path.join(inbox(), 'mixed.jsonl');
    writeFileSync(file, inboxLine(TOKEN, 'Stop') + inboxLine('tok-other', 'Stop', 'so'));

    const records = drainInboxOnce(deps());
    expect(records.map((r) => r.projectId).sort()).toEqual([projectId, other.id].sort());
    expect(hookEvents.listByProject(other.id)).toHaveLength(1);
    expect(existsSync(file)).toBe(false);
  });

  it('仅 SessionStart 的新会话：事件照收，但不建会话行（空会话不入库）', () => {
    const file = path.join(inbox(), `${hookShardId(TOKEN)}.jsonl`);
    writeFileSync(file, inboxLine(TOKEN, 'SessionStart', 's-empty'));

    const records = drainInboxOnce(deps());
    expect(records).toHaveLength(1); // 事件照收（采集日志完整）
    expect(hookEvents.listByProject(projectId).map((r) => r.eventType)).toEqual(['SessionStart']);
    // 核心判据：空会话不建档 → 会话列表永不被它污染
    expect(hookSessions.list(projectId)).toHaveLength(0);
    expect(existsSync(file)).toBe(false);
  });

  it('带真实事件的那批才建档；早先漏记的 SessionStart 经 session_id 归队', () => {
    const file = path.join(inbox(), `${hookShardId(TOKEN)}.jsonl`);
    writeFileSync(file, inboxLine(TOKEN, 'SessionStart', 's-late'));
    drainInboxOnce(deps());
    expect(hookSessions.list(projectId)).toHaveLength(0);

    writeFileSync(file, inboxLine(TOKEN, 'UserPromptSubmit', 's-late'));
    const records = drainInboxOnce(deps());
    expect(records).toHaveLength(1);
    expect(hookSessions.list(projectId).map((s) => s.sessionId)).toEqual(['s-late']);
    // 归队：事件计数把早先漏记的 SessionStart 一并算进（链语义不破）
    const row = hookSessions.listWithCounts(projectId).find((s) => s.sessionId === 's-late');
    expect(row?.eventCount).toBe(2);
    expect(row?.lastEventType).toBe('UserPromptSubmit');
  });

  it('已有会话行照常 touch（resume 的 SessionStart 放行）', () => {
    hookSessions.touch('s-res', projectId);
    const file = path.join(inbox(), `${hookShardId(TOKEN)}.jsonl`);
    writeFileSync(file, inboxLine(TOKEN, 'SessionStart', 's-res'));

    drainInboxOnce(deps());
    const rows = hookSessions.list(projectId);
    expect(rows.map((r) => r.sessionId)).toEqual(['s-res']);
  });
});

describe('handleIngestedRecords：SSE + 规则分发 + outbox 顺延', () => {
  let db: DatabaseSync;
  let hooksDir: string;
  let bus: HookEventBus;
  let messages: HookBusMessage[];

  beforeEach(async () => {
    hooksDir = await mkdtemp(path.join(tmpdir(), 'weave-inbox-'));
    db = openDatabase(':memory:');
    setDaemonSettingsDb(openDatabase(':memory:'));
    await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
    });
    bus = new HookEventBus();
    messages = [];
    bus.subscribe((m) => messages.push(m));
  });

  afterEach(async () => {
    setDaemonSettingsDb(null);
    db.close();
    await rm(hooksDir, { recursive: true, force: true });
  });

  it('每条记录补发 event.ingested 帧（worker 无 bus，SSE 归主线程）', () => {
    const projects = new ProjectRepository(db);
    const project = projects.register({ path: '/proj', name: 'p', token: TOKEN, source: 'init' });
    const hookEvents = new HookEventRepository(db);
    const id = hookEvents.insert({
      projectId: project.id,
      source: 'claude',
      eventType: 'Stop',
      sessionId: 's1',
      payload: JSON.stringify({ eventType: 'Stop', raw: {} }),
    });

    handleIngestedRecords(
      { projects, hooksDir, bus },
      [
        {
          eventId: id,
          projectId: project.id,
          input: {
            projectId: project.id,
            source: 'claude',
            eventType: 'Stop',
            sessionId: 's1',
            payload: JSON.stringify({ eventType: 'Stop', raw: {} }),
          },
        },
      ],
    );

    const frames = messages.filter((m) => m.kind === 'event.ingested');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ eventId: id, projectId: project.id, eventType: 'Stop' });
  });

  it('dispatcher 的 deferred（未镜像规则/插件产出）写进 outbox 顺延给下一次事件', async () => {
    const projects = new ProjectRepository(db);
    const project = projects.register({ path: '/proj', name: 'p', token: TOKEN, source: 'init' });
    projects.register({ path: '/other', name: 'o', token: 'tok-other', source: 'init' });
    const hookEvents = new HookEventRepository(db);
    const registry = new HookRuleRegistry(new HookRuleRepository(db));
    registry.create({
      name: 'cross',
      projectId: null,
      source: { kind: 'claude-event', event: 'PostToolUse' },
      filter: { crossProjectOnly: true },
      handler: { type: 'inject', template: 'cross {file}' },
    });
    const dispatcher = new HookDispatcher({
      registry,
      dispatches: new HookDispatchRepository(db),
      bus,
      projects,
      sessions: new SessionRepository(db),
    });
    const input = {
      projectId: project.id,
      source: 'claude' as const,
      eventType: 'PostToolUse',
      sessionId: 's1',
      payload: JSON.stringify({
        eventType: 'PostToolUse',
        toolName: 'Edit',
        toolInput: { file_path: '/other/README.md' },
        cwd: '/proj',
        raw: {},
      }),
    };
    const id = hookEvents.insert(input);

    handleIngestedRecords(
      { projects, hooksDir, bus, dispatcher },
      [{ eventId: id, projectId: project.id, input }],
    );

    // dispatcher 异步落 outbox：轮询等待
    const outbox = outboxPathOf(hooksDir, hookShardId(TOKEN));
    const deadline = Date.now() + 2000;
    while (!existsSync(outbox) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const lines = readFileSync(outbox, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ sessionId: 's1' });
    expect(JSON.parse(lines[0]!).text).toContain('cross');
  });
});
