import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CodexEventSource, CodexLogSource } from '@weavecode/harness';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { pollLogsOnce } from '../inbox-worker.js';

/**
 * 拉取式采集（`logs` 槽）的落库全链：白名单 → 归一 → 入库（真实时刻）→ 会话 touch。
 * 这里用 codex 当唯一日志源——它是今天唯一的实现，别处没有第二份可代替。
 */

const line = (o: unknown): string => JSON.stringify(o) + '\n';

let home: string;
let logsDir: string;
let projectDir: string;
let db: DatabaseSync;
let projects: ProjectRepository;
let hookEvents: HookEventRepository;
let hookSessions: SessionRepository;

const rollout = (cwd: string, sessionId = 'th-1'): string =>
  line({ timestamp: '2026-11-01T00:00:00.000Z', ordinal: 1, type: 'session_meta', payload: { session_id: sessionId, cwd } }) +
  line({
    timestamp: '2026-11-01T00:00:10.000Z',
    ordinal: 2,
    type: 'event_msg',
    payload: { type: 'user_message', message: '跑测试' },
  }) +
  line({
    timestamp: '2026-11-01T00:00:30.000Z',
    ordinal: 3,
    type: 'event_msg',
    payload: { type: 'task_complete', last_agent_message: null },
  });

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'weave-logpoll-home-'));
  logsDir = await mkdtemp(path.join(tmpdir(), 'weave-logpoll-logs-'));
  projectDir = await mkdtemp(path.join(tmpdir(), 'weave-logpoll-proj-'));
  process.env.CODEX_HOME = home;
  db = openDatabase(':memory:');
  projects = new ProjectRepository(db);
  hookEvents = new HookEventRepository(db);
  hookSessions = new SessionRepository(db);
  await mkdir(path.join(home, 'sessions', '2026', '11', '01'), { recursive: true });
});

afterEach(async () => {
  delete process.env.CODEX_HOME;
  db.close();
  await rm(home, { recursive: true, force: true });
  await rm(logsDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

/** 项目接入 codex（`weave init` 的选择结果）。 */
async function initForCodex(): Promise<number> {
  await mkdir(path.join(projectDir, '.weave'), { recursive: true });
  await writeFile(path.join(projectDir, '.weave', 'config.yaml'), 'harnesses: ["codex"]\n');
  return projects.register({ path: projectDir, name: 'p', token: 'tk', source: 'init' }).id;
}

const poll = () =>
  pollLogsOnce({
    projects,
    hookEvents,
    hookSessions,
    adapters: [new CodexEventSource()],
    logsDir,
    sources: [new CodexLogSource()],
  });

describe('pollLogsOnce', () => {
  it('接入 codex 的项目：rollout 事件按真实时刻入库、会话行随首个事件即建', async () => {
    const projectId = await initForCodex();
    const cwd = projects.getById(projectId)!.path;
    await writeFile(path.join(home, 'sessions', '2026', '11', '01', 'rollout-a.jsonl'), rollout(cwd));

    const records = await poll();
    expect(records.map((r) => r.input.eventType)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
    expect(records.every((r) => r.input.source === 'codex')).toBe(true);
    // 历史回填不印成插入时刻
    expect(records[2]!.input.createdAt).toBe('2026-11-01T00:00:30.000Z');

    const rows = hookEvents.listBySession('th-1');
    expect(rows.map((r) => r.eventType)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
    expect(rows[2]!.createdAt).toBe('2026-11-01T00:00:30.000Z');

    const session = hookSessions.getBySessionId('th-1')!;
    expect(session.projectId).toBe(projectId);
    // last_seen_at 只增不减：批内取最晚那条，不让后插入的旧事件往回拨
    expect(session.lastSeenAt).toBe('2026-11-01T00:00:30.000Z');
  });

  it('没接入 codex 的项目不采（回落默认 harness 不算接入）', async () => {
    await projects.register({ path: projectDir, name: 'p', token: 'tk', source: 'init' });
    const cwd = projects.list()[0]!.path;
    await writeFile(path.join(home, 'sessions', '2026', '11', '01', 'rollout-a.jsonl'), rollout(cwd));
    expect(await poll()).toEqual([]);
    expect(hookEvents.listByProject(projects.list()[0]!.id)).toEqual([]);
  });

  it('白名单外的 cwd（别的目录里跑的 codex）一条都不进', async () => {
    await initForCodex();
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'weave-logpoll-other-'));
    try {
      await writeFile(path.join(home, 'sessions', '2026', '11', '01', 'rollout-a.jsonl'), rollout(elsewhere));
      expect(await poll()).toEqual([]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('归档项目不采（归档即焚，与 inbox 同口径）', async () => {
    const projectId = await initForCodex();
    const cwd = projects.getById(projectId)!.path;
    projects.setArchived(projectId, true);
    await writeFile(path.join(home, 'sessions', '2026', '11', '01', 'rollout-a.jsonl'), rollout(cwd));
    expect(await poll()).toEqual([]);
  });

  it('游标落 `<logsDir>/<harness>/cursors.json`：第二轮不重复上报', async () => {
    const projectId = await initForCodex();
    const cwd = projects.getById(projectId)!.path;
    await writeFile(path.join(home, 'sessions', '2026', '11', '01', 'rollout-a.jsonl'), rollout(cwd));
    expect((await poll()).length).toBe(3);
    expect(await poll()).toEqual([]);
  });

  it('没有日志源时直接空转（不碰 projects / 文件系统）', async () => {
    expect(
      await pollLogsOnce({
        projects,
        hookEvents,
        hookSessions,
        adapters: [],
        logsDir,
        sources: [],
      }),
    ).toEqual([]);
  });
});
