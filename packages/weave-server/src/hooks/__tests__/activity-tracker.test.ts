import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { ActivityTracker, type ActivityEventInput } from '../activity-tracker.js';
import type { NormalizedHookPayload } from '../types.js';

const SESSION = 'sess-a';

/** NormalizedHookPayload 的窄构造（tracker 只读这几个字段）。 */
const payload = (partial: Partial<NormalizedHookPayload>): NormalizedHookPayload => ({
  eventType: 'PostToolUse',
  toolName: null,
  toolInput: null,
  toolResponse: null,
  cwd: null,
  transcriptPath: null,
  raw: null,
  ...partial,
});

describe('ActivityTracker 状态机', () => {
  let db: ReturnType<typeof openDatabase>;
  let tracker: ActivityTracker;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const projectId = projects.register({
      path: '/a-proj',
      name: 'a',
      token: 'atoken',
      source: 'init',
    }).id;
    const sessions = new SessionRepository(db);
    const events = new HookEventRepository(db);
    sessions.touch(SESSION, projectId);
    tracker = new ActivityTracker({ sessions, hookEvents: events });
  });

  afterEach(() => {
    db.close();
  });

  const feed = (input: Partial<ActivityEventInput> & { payload: NormalizedHookPayload | null }): void =>
    tracker.onEvent({ sessionId: SESSION, ...input });

  it('PostToolUse(Agent, isAsync) → 子 agent 出生 running', () => {
    feed({
      payload: payload({
        toolName: 'Agent',
        toolResponse: { isAsync: true, agentId: 'ag1', description: 'scan repo' },
      }),
    });
    const row = tracker.agentsOf(SESSION).get('ag1')!;
    expect(row.status).toBe('running');
    expect(row.description).toBe('scan repo');
  });

  it('SubagentStart 的 agent_id → 子 agent 出生 running（前台 agent 没有 isAsync 回执）', () => {
    feed({
      payload: payload({ eventType: 'SubagentStart', raw: { agent_id: 'ag0', agent_type: 'Explore' } }),
    });
    expect(tracker.agentsOf(SESSION).get('ag0')).toMatchObject({
      status: 'running',
      agentType: 'Explore',
    });
  });

  it('SubagentStart → Stop 的完整一轮：running 起、SubagentStop 落 completed', () => {
    feed({ payload: payload({ eventType: 'SubagentStart', raw: { agent_id: 'ag9' } }) });
    expect(tracker.agentsOf(SESSION).get('ag9')?.status).toBe('running');
    feed({ payload: payload({ eventType: 'SubagentStop', raw: { agent_id: 'ag9' } }) });
    expect(tracker.agentsOf(SESSION).get('ag9')?.status).toBe('completed');
  });

  it('SubagentStop 的 agent_id → completed（账上没有也记一条 completed）', () => {
    feed({
      payload: payload({ eventType: 'SubagentStop', raw: { agent_id: 'ag2', agent_type: 'Explore' } }),
    });
    expect(tracker.agentsOf(SESSION).get('ag2')).toMatchObject({
      status: 'completed',
      agentType: 'Explore',
    });
  });

  it('PostToolUse(Bash) + bgShell → 后台 shell 出生，command 取 toolInput', () => {
    feed({
      payload: payload({ toolName: 'Bash', toolInput: { command: 'npm test' } }),
      bgShell: { taskId: 'sh1' },
    });
    expect(tracker.shellsOf(SESSION).get('sh1')).toMatchObject({
      taskId: 'sh1',
      status: 'running',
      command: 'npm test',
    });
  });

  it('background_tasks 整集对账：subagent 翻 completed、shell 更新 status', () => {
    feed({
      payload: payload({ toolName: 'Agent', toolResponse: { isAsync: true, agentId: 'ag1' } }),
    });
    feed({
      payload: payload({ toolName: 'Bash', toolInput: { command: 'sleep 9' } }),
      bgShell: { taskId: 'sh1' },
    });
    feed({
      payload: payload({ eventType: 'Stop', raw: {} }),
      backgroundTasks: [
        { id: 'ag1', status: 'completed', type: 'subagent' },
        { id: 'sh1', status: 'completed', type: 'shell', command: 'sleep 9' },
      ],
    });
    expect(tracker.agentsOf(SESSION).get('ag1')!.status).toBe('completed');
    expect(tracker.shellsOf(SESSION).get('sh1')!.status).toBe('completed');
  });

  it('壳不在 background_tasks 快照里 → 翻 completed 留账（不删，交给前端收纳）', () => {
    feed({
      payload: payload({ toolName: 'Bash', toolInput: { command: 'a' } }),
      bgShell: { taskId: 'sh1' },
    });
    feed({
      payload: payload({ toolName: 'Bash', toolInput: { command: 'b' } }),
      bgShell: { taskId: 'sh2' },
    });
    feed({
      payload: payload({ eventType: 'Stop', raw: {} }),
      backgroundTasks: [{ id: 'sh1', status: 'running', type: 'shell', command: 'a' }],
    });
    expect(tracker.shellsOf(SESSION).get('sh1')!.status).toBe('running');
    expect(tracker.shellsOf(SESSION).get('sh2')!.status).toBe('completed');
    expect([...tracker.shellsOf(SESSION).keys()]).toEqual(['sh1', 'sh2']);
  });

  it('seedFromDb：从库里重放 background_tasks 快照', () => {
    const events = new HookEventRepository(db);
    const stop = JSON.stringify(
      payload({
        eventType: 'Stop',
        raw: {
          background_tasks: [
            { id: 'ag9', status: 'completed', type: 'subagent', description: 'done thing' },
            { id: 'sh9', status: 'running', type: 'shell', command: 'npm run dev' },
          ],
        },
      }),
    );
    events.insert({ projectId: 1, source: 'claude', eventType: 'Stop', sessionId: SESSION, payload: stop });

    const fresh = new ActivityTracker({ sessions: new SessionRepository(db), hookEvents: events });
    fresh.seedFromDb();
    expect(fresh.agentsOf(SESSION).get('ag9')).toMatchObject({ status: 'completed', description: 'done thing' });
    expect(fresh.shellsOf(SESSION).get('sh9')).toMatchObject({ status: 'running', command: 'npm run dev' });
  });

  it('forgetSession 清两账', () => {
    feed({
      payload: payload({ toolName: 'Agent', toolResponse: { isAsync: true, agentId: 'ag1' } }),
    });
    feed({
      payload: payload({ toolName: 'Bash', toolInput: { command: 'a' } }),
      bgShell: { taskId: 'sh1' },
    });
    tracker.forgetSession(SESSION);
    expect(tracker.agentsOf(SESSION).size).toBe(0);
    expect(tracker.shellsOf(SESSION).size).toBe(0);
  });
});
