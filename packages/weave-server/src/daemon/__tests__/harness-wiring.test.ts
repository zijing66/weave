import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { HarnessRegistry, registerRuntimeDrivers, ClaudeEventSource } from '@weave/harness';
import { HARNESS_EVENTS } from '@weave/core';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { ClaudeCodeAdapter } from '../../hooks/adapter.js';
import type { HookReport } from '../../hooks/types.js';
import { createWeaveServer } from '../server.js';

/**
 * 批 4b 装配等价用例（硬闸）：
 * ① `byCapability('events')` 派生 == 旧 `[new ClaudeCodeAdapter()]`；
 * ② server.ts 分派查找结果与旧 `deps.adapters.find` 一致；
 * ③ 仅注入 harnesses（不传 adapters）时 POST /hooks 行为不变。
 */

const DAEMON_TOKEN = 'daemon-token';
const PROJECT_TOKEN = 'ptoken';

const SAMPLE_REPORTS: HookReport[] = [
  {
    source: 'claude',
    eventType: 'PostToolUse',
    sessionId: 's1',
    cwd: '/proj',
    payload: JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'sess-1',
      tool_name: 'Edit',
      tool_input: { file: 'a.ts' },
      tool_response: { ok: true },
      cwd: '/proj',
      transcript_path: '/proj/t.jsonl',
    }),
  },
  { source: 'claude', eventType: '', payload: JSON.stringify({ hook_event_name: 'PreToolUse' }) },
  { source: 'claude', eventType: 'PostToolUse', payload: 'not-json' },
  { source: 'claude', eventType: 'SessionStart', sessionId: 'from-report', payload: '{}' },
];

describe('批 4b：registry 派生 adapters 与旧构造等价', () => {
  const harnesses = new HarnessRegistry();
  registerRuntimeDrivers(harnesses);
  const derived = harnesses.byCapability('events').flatMap((d) => d.events ?? []);
  const legacy = [new ClaudeCodeAdapter()];

  it("byCapability('events') 派生列表 == [ClaudeEventSource]（旧 [ClaudeCodeAdapter()]）", () => {
    expect(derived).toHaveLength(legacy.length);
    expect(derived).toHaveLength(1);
    expect(derived[0]).toBeInstanceOf(ClaudeEventSource);
    expect(derived[0]!.source).toBe(legacy[0]!.source);
    expect(derived[0]!.source).toBe('claude');
    // 事件表来自批 1 下沉 core 的 HARNESS_EVENTS.claude（旧 HookAdapter 无此字段）
    expect(derived[0]!.events).toEqual(HARNESS_EVENTS.claude);
  });

  it('normalize 输出逐字段一致（含畸形 / 空 eventType payload）', () => {
    for (const report of SAMPLE_REPORTS) {
      expect(derived[0]!.normalize(report, 42)).toEqual(legacy[0]!.normalize(report, 42));
    }
  });

  it('server.ts 分派查找结果与旧 deps.adapters.find 一致', () => {
    const findNew = (report: HookReport) =>
      derived.find((a) => a.source === report.source)?.normalize(report, 1);
    const findLegacy = (report: HookReport) =>
      legacy.find((a) => a.source === report.source)?.normalize(report, 1);

    // claude 命中：两侧找到同一规格的 adapter，归一化结果一致
    expect(findNew(SAMPLE_REPORTS[0]!)).toEqual(findLegacy(SAMPLE_REPORTS[0]!));
    // 未知 source：两侧同样找不到
    const codexReport: HookReport = { source: 'codex', eventType: 'X', payload: '{}' };
    expect(findNew(codexReport)).toBeUndefined();
    expect(findLegacy(codexReport)).toBeUndefined();
  });
});

describe('批 4b：仅注入 harnesses 的 POST /hooks（分派走 registry 派生）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let hookEvents: HookEventRepository;
  let projectId: number;

  beforeAll(async () => {
    const harnesses = new HarnessRegistry();
    registerRuntimeDrivers(harnesses);
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projectId = projects.register({
      path: '/proj',
      name: 'test',
      token: PROJECT_TOKEN,
      source: 'init',
    }).id;
    hookEvents = new HookEventRepository(db);
    server = createWeaveServer({
      projects,
      daemonToken: DAEMON_TOKEN,
      port: 0,
      hookEvents,
      harnesses,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    db.close();
  });

  it('claude 事件 201 且入库（与旧 adapters 注入的响应体同构）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PROJECT_TOKEN}` },
      body: JSON.stringify(SAMPLE_REPORTS[0]),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      id: number;
      projectId: number;
      source: string;
      eventType: string;
    };
    expect(data.projectId).toBe(projectId);
    expect(data.source).toBe('claude');
    expect(data.eventType).toBe('PostToolUse');
    expect(typeof data.id).toBe('number');

    const rows = hookEvents.listByProject(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventType).toBe('PostToolUse');
    expect(rows[0]!.sessionId).toBe('s1');
  });

  it('未知 source 400（与旧 deps.adapters.find 未命中一致）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PROJECT_TOKEN}` },
      body: JSON.stringify({ source: 'codex', eventType: 'X', payload: '{}' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown hook source: codex' });
  });
});
