import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { SessionRepository, PROMPTLESS_GRACE_MS } from '../../repositories/sessions.js';
import { ClaudeEventSource } from '@weavecode/harness';
import { HookRuleRegistry } from '../registry.js';
import { HookEventBus, type HookBusMessage } from '../bus.js';
import { HookDispatcher } from '../dispatcher.js';
import {
  setDaemonSettingsDb,
  writeDaemonSettings,
  DEFAULT_SESSION_IDLE_DAYS,
} from '../../daemon/settings.js';
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
    setDaemonSettingsDb(openDatabase(':memory:'));
    projects = new ProjectRepository(db);
    projectId = projects.register({ path: '/proj', name: 'p', token: TOKEN, source: 'init' }).id;
    hookEvents = new HookEventRepository(db);
    hookSessions = new SessionRepository(db);
    hooksDir = await mkdtemp(path.join(tmpdir(), 'weave-inbox-'));
    mkdirSync(inbox(), { recursive: true });
  });

  afterEach(async () => {
    setDaemonSettingsDb(null);
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

  it('terminal 定位 env 逐行解析：同批两会话各拿自己的 pane，不取整组最后一个', () => {
    const locator = (pane: string) => ({
      terminal: { WEZTERM_PANE: pane, WEZTERM_UNIX_SOCKET: 'D:/sock/gui-sock-1' },
    });
    const withEnv = (token: string, eventType: string, sessionId: string, pane: string): string =>
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
        ...locator(pane),
      }) + '\n';
    const file = path.join(inbox(), `${hookShardId(TOKEN)}.jsonl`);
    writeFileSync(
      file,
      withEnv(TOKEN, 'Stop', 's1', '0') +
        inboxLine(TOKEN, 'Stop', 's2') +
        withEnv(TOKEN, 'Stop', 's3', '6'),
    );

    const bySession = new Map(drainInboxOnce(deps()).map((r) => [r.input.sessionId, r.terminalEnv]));
    expect(bySession.get('s1')).toEqual({
      WEZTERM_PANE: '0',
      WEZTERM_UNIX_SOCKET: 'D:/sock/gui-sock-1',
    });
    expect(bySession.get('s3')).toEqual({
      WEZTERM_PANE: '6',
      WEZTERM_UNIX_SOCKET: 'D:/sock/gui-sock-1',
    });
    // 没上报的行 = null（不是拿邻行的值）
    expect(bySession.get('s2')).toBeNull();
  });

  it('inbox 直投凭据逐行解析：同批两会话各拿自己的 socket，不取整组最后一个', () => {
    const withSock = (eventType: string, sessionId: string, socket: string | null): string =>
      JSON.stringify({
        v: 1,
        token: TOKEN,
        report: {
          source: 'claude',
          eventType,
          sessionId,
          cwd: '/proj',
          payload: JSON.stringify({ hook_event_name: eventType, session_id: sessionId, cwd: '/proj' }),
        },
        ...(socket ? { messaging: { socket, token: `${sessionId}-tok` } } : {}),
      }) + '\n';
    const file = path.join(inbox(), `${hookShardId(TOKEN)}.jsonl`);
    writeFileSync(
      file,
      withSock('Stop', 's1', 'D:/sock/s1.sock') +
        withSock('Stop', 's2', null) +
        withSock('Stop', 's3', 'D:/sock/s3.sock'),
    );

    const bySession = new Map(drainInboxOnce(deps()).map((r) => [r.input.sessionId, r.messaging]));
    expect(bySession.get('s1')).toEqual({ socket: 'D:/sock/s1.sock', token: 's1-tok' });
    expect(bySession.get('s3')).toEqual({ socket: 'D:/sock/s3.sock', token: 's3-tok' });
    // 没上报的行 = null（拿邻行的 socket 会把消息直投进别的会话）
    expect(bySession.get('s2')).toBeNull();
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

  it('仅 SessionStart 的新会话：照建档（新建会话要马上出现在列表），并带 1 小时快过期期限', () => {
    const file = path.join(inbox(), `${hookShardId(TOKEN)}.jsonl`);
    writeFileSync(file, inboxLine(TOKEN, 'SessionStart', 's-new'));

    const records = drainInboxOnce(deps());
    expect(records).toHaveLength(1);
    expect(hookEvents.listByProject(projectId).map((r) => r.eventType)).toEqual(['SessionStart']);
    // 核心判据：首现 sessionId 即建档，不等第一条 prompt
    const rows = hookSessions.listWithCounts(projectId);
    expect(rows.map((s) => s.sessionId)).toEqual(['s-new']);
    expect(rows[0]?.eventCount).toBe(1);
    // 有期限且是快过期档（没等到 prompt 的新会话不占 n 天窗口），不是永久行
    expect(rows[0]?.autoDeleteAt).toBeTruthy();
    expect(
      Date.parse(rows[0]!.autoDeleteAt!) - Date.parse(rows[0]!.lastSeenAt),
    ).toBe(PROMPTLESS_GRACE_MS);
    expect(existsSync(file)).toBe(false);
  });

  it('SessionStart 先建档，后续事件进同一行；收到 prompt 换到 n 天闲置档', () => {
    const file = path.join(inbox(), `${hookShardId(TOKEN)}.jsonl`);
    writeFileSync(file, inboxLine(TOKEN, 'SessionStart', 's-late'));
    drainInboxOnce(deps());
    expect(hookSessions.listWithCounts(projectId).map((s) => s.sessionId)).toEqual(['s-late']);
    const before = hookSessions.listWithCounts(projectId)[0]?.autoDeleteAt;
    expect(before).toBeTruthy();

    writeFileSync(file, inboxLine(TOKEN, 'UserPromptSubmit', 's-late'));
    const records = drainInboxOnce(deps());
    expect(records).toHaveLength(1);
    expect(hookSessions.list(projectId).map((s) => s.sessionId)).toEqual(['s-late']);
    const row = hookSessions.listWithCounts(projectId).find((s) => s.sessionId === 's-late');
    expect(row?.eventCount).toBe(2);
    expect(row?.lastEventType).toBe('UserPromptSubmit');
    // 收到 prompt 即换档：快过期（1 小时）→ 无操作 n 天闲置窗
    expect(row?.autoDeleteAt).toBeTruthy();
    expect(Date.parse(row!.autoDeleteAt!) - Date.parse(row!.lastSeenAt)).toBe(
      DEFAULT_SESSION_IDLE_DAYS * 86_400_000,
    );
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

  it('SessionEnd 到达即会话退出（谁是退出事件查生命周期表）；codex / 其他事件不动', () => {
    const projects = new ProjectRepository(db);
    const project = projects.register({ path: '/proj', name: 'p', token: TOKEN, source: 'init' });
    const hookEvents = new HookEventRepository(db);
    const exited: string[] = [];
    const deps = {
      projects,
      hooksDir,
      bus,
      messagePipe: {
        hasQueued: () => false,
        flushSession: async () => {},
        sessionExited: (sessionId: string) => exited.push(sessionId),
      },
    };

    const record = (eventType: string, source: 'claude' | 'codex', sessionId: string) => {
      const payload = JSON.stringify({ eventType, raw: {} });
      return {
        eventId: hookEvents.insert({ projectId: project.id, source, eventType, sessionId, payload }),
        projectId: project.id,
        input: { projectId: project.id, source, eventType, sessionId, payload },
      };
    };

    handleIngestedRecords(deps, [record('SessionEnd', 'claude', 's-exit')]);
    handleIngestedRecords(deps, [record('Stop', 'claude', 's-exit')]);
    // codex 没有退出事件（表里 null）——即便事件名撞上也不动
    handleIngestedRecords(deps, [record('SessionEnd', 'codex', 's-codex')]);
    expect(exited).toEqual(['s-exit']);
  });

  it('PostModelSwitch 的 to_model 交给会话探测（切完标签立刻变，不等下一轮）', () => {
    const projects = new ProjectRepository(db);
    const project = projects.register({ path: '/proj', name: 'p', token: TOKEN, source: 'init' });
    const hookEvents = new HookEventRepository(db);
    const noted: Array<[string, string]> = [];
    const deps = {
      projects,
      hooksDir,
      bus,
      sessionProbe: {
        noteTranscript: () => {},
        noteModel: (sessionId: string, model: string) => noted.push([sessionId, model]),
        sessionStarted: () => {},
      },
    };

    const record = (eventType: string, raw: Record<string, unknown>) => {
      const payload = JSON.stringify({ eventType, raw });
      return {
        eventId: hookEvents.insert({ projectId: project.id, source: 'claude', eventType, sessionId: 's1', payload }),
        projectId: project.id,
        input: { projectId: project.id, source: 'claude', eventType, sessionId: 's1', payload },
      };
    };

    handleIngestedRecords(deps, [record('PreModelSwitch', { from_model: 'ftm', to_model: 'deepseek-flash' })]);
    // Pre 只是「对话框要弹」，此时还没换——不是落定笔
    expect(noted).toEqual([]);
    handleIngestedRecords(deps, [record('PostModelSwitch', { from_model: 'ftm', to_model: 'deepseek-flash' })]);
    expect(noted).toEqual([['s1', 'deepseek-flash']]);
  });

  it('每条事件自带的 permission_mode 交给会话探测（切模式不落转录，笔迹只在事件里）', () => {
    const projects = new ProjectRepository(db);
    const project = projects.register({ path: '/proj', name: 'p', token: TOKEN, source: 'init' });
    const hookEvents = new HookEventRepository(db);
    const modes: Array<[string, string]> = [];
    const deps = {
      projects,
      hooksDir,
      bus,
      sessionProbe: {
        noteTranscript: () => {},
        noteModel: () => {},
        sessionStarted: () => {},
        noteMode: (sessionId: string, mode: string) => modes.push([sessionId, mode]),
      },
    };

    const record = (eventType: string, raw: Record<string, unknown>) => {
      const payload = JSON.stringify({ eventType, raw });
      return {
        eventId: hookEvents.insert({
          projectId: project.id,
          source: 'claude',
          eventType,
          sessionId: 's1',
          payload,
        }),
        projectId: project.id,
        input: { projectId: project.id, source: 'claude', eventType, sessionId: 's1', payload },
      };
    };

    handleIngestedRecords(deps, [record('PreToolUse', { permission_mode: 'plan' })]);
    expect(modes).toEqual([['s1', 'plan']]);
    // 缺键的事件不动「最后已知」（保持上次闩住的值）
    handleIngestedRecords(deps, [record('PostToolUse', {})]);
    expect(modes).toEqual([['s1', 'plan']]);
  });

  it('旁路回答认领收到解析后的载荷与事件 id（帧域不带 raw，判据只能挂在 ingest 上）', () => {
    const projects = new ProjectRepository(db);
    const project = projects.register({ path: '/proj', name: 'p', token: TOKEN, source: 'init' });
    const hookEvents = new HookEventRepository(db);
    const seen: Array<Record<string, unknown>> = [];
    const deps = { projects, hooksDir, bus, sideQuestions: { onEvent: (e) => seen.push(e) } };

    const raw = { agent_transcript_path: '/nowhere.jsonl', last_assistant_message: '旁路答案' };
    const payload = JSON.stringify({ eventType: 'SubagentStop', raw });
    const eventId = hookEvents.insert({
      projectId: project.id,
      source: 'claude',
      eventType: 'SubagentStop',
      sessionId: 's1',
      payload,
    });
    handleIngestedRecords(deps, [
      {
        eventId,
        projectId: project.id,
        input: { projectId: project.id, source: 'claude', eventType: 'SubagentStop', sessionId: 's1', payload },
      },
    ]);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sessionId: 's1', source: 'claude', eventType: 'SubagentStop', eventId });
    expect((seen[0]!.payload as { raw: unknown }).raw).toEqual(raw);
  });

  it('SessionStart 交给会话探测：带 model 就报真名，resume 不带也要说一声（旧答案作废重读）', () => {
    const projects = new ProjectRepository(db);
    const project = projects.register({ path: '/proj', name: 'p', token: TOKEN, source: 'init' });
    const hookEvents = new HookEventRepository(db);
    const started: Array<[string, string | null]> = [];
    const deps = {
      projects,
      hooksDir,
      bus,
      sessionProbe: {
        noteTranscript: () => {},
        noteModel: () => {},
        sessionStarted: (sessionId: string, model: string | null) => started.push([sessionId, model]),
      },
    };

    const record = (raw: Record<string, unknown>) => {
      const eventType = 'SessionStart';
      const payload = JSON.stringify({ eventType, raw });
      return {
        eventId: hookEvents.insert({ projectId: project.id, source: 'claude', eventType, sessionId: 's1', payload }),
        projectId: project.id,
        input: { projectId: project.id, source: 'claude', eventType, sessionId: 's1', payload },
      };
    };

    handleIngestedRecords(deps, [record({ source: 'startup', model: 'ftm' })]);
    handleIngestedRecords(deps, [record({ source: 'resume' })]);
    expect(started).toEqual([
      ['s1', 'ftm'],
      ['s1', null],
    ]);
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
        toolInput: { file_path: path.resolve('/other/README.md') },
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

  it('deliveredTitle 回执随记录透传 dispatcher：同值落定 pending，不同值不动', async () => {
    const projects = new ProjectRepository(db);
    const project = projects.register({ path: '/proj', name: 'p', token: TOKEN, source: 'init' });
    const hookEvents = new HookEventRepository(db);
    const sessions = new SessionRepository(db);
    sessions.touch('s1', project.id);
    sessions.setPendingTitle('s1', '生效名');
    const dispatcher = new HookDispatcher({
      registry: new HookRuleRegistry(new HookRuleRepository(db)),
      dispatches: new HookDispatchRepository(db),
      bus,
      projects,
      sessions,
    });
    const mkInput = () => ({
      projectId: project.id,
      source: 'claude' as const,
      eventType: 'UserPromptSubmit',
      sessionId: 's1',
      payload: JSON.stringify({ eventType: 'UserPromptSubmit', toolName: null, toolInput: null, raw: {} }),
    });
    const input = mkInput();

    // 回执与 pending 同值 → 落定（徽标清除的信号源）
    handleIngestedRecords(
      { projects, hooksDir, bus, dispatcher },
      [{ eventId: hookEvents.insert(input), projectId: project.id, input, deliveredTitle: '生效名' }],
    );
    await vi.waitFor(() => {
      expect(sessions.getBySessionId('s1')?.pendingTitle).toBeNull();
    });

    // 回执与 pending 不同值 → 旧回执作废，pending 原样
    sessions.setPendingTitle('s1', '又一次');
    handleIngestedRecords(
      { projects, hooksDir, bus, dispatcher },
      [{ eventId: hookEvents.insert(mkInput()), projectId: project.id, input: mkInput(), deliveredTitle: '生效名' }],
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(sessions.getBySessionId('s1')?.pendingTitle).toBe('又一次');
  });
});
