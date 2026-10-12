import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  HarnessRegistry,
  registerRuntimeDrivers,
  createRuntimeRegistry,
  ClaudeEventSource,
} from '@weavecode/harness';
import { HARNESS_EVENTS } from '@weavecode/core';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { ClaudeCodeAdapter } from '../../hooks/adapter.js';
import { drainInboxOnce } from '../../hooks/inbox-worker.js';
import type { HookReport } from '../../hooks/types.js';

/**
 * 批 4b 装配等价用例（硬闸）：
 * ① `byCapability('events')` 派生 == 旧 `[new ClaudeCodeAdapter()]`；
 * ② normalize 输出逐字段一致；
 * ③ inbox 消费线程自持 registry 派生同一份适配器（hook 文件化后无 HTTP 分派）。
 */

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

describe('批 4b：inbox 消费侧的适配器派生（worker 自持 registry）', () => {
  let db: DatabaseSync;
  let hooksDir: string;
  let hookEvents: HookEventRepository;
  let hookSessions: SessionRepository;
  let projects: ProjectRepository;
  let projectId: number;

  const inboxLine = (report: HookReport): string =>
    JSON.stringify({ v: 1, token: PROJECT_TOKEN, report }) + '\n';

  beforeAll(async () => {
    db = openDatabase(':memory:');
    projects = new ProjectRepository(db);
    projectId = projects.register({
      path: '/proj',
      name: 'test',
      token: PROJECT_TOKEN,
      source: 'init',
    }).id;
    hookEvents = new HookEventRepository(db);
    hookSessions = new SessionRepository(db);
    hooksDir = await mkdtemp(path.join(tmpdir(), 'weave-wiring-'));
    mkdirSync(path.join(hooksDir, 'inbox'), { recursive: true });
  });

  afterAll(async () => {
    db.close();
    await rm(hooksDir, { recursive: true, force: true });
  });

  it('worker 侧派生 == runtime registry 的 events 能力槽（与旧 [ClaudeCodeAdapter()] 同源）', () => {
    const harnesses = new HarnessRegistry();
    registerRuntimeDrivers(harnesses);
    const derived = harnesses.byCapability('events').flatMap((d) => d.events ?? []);
    const legacy = [new ClaudeCodeAdapter()];
    expect(derived[0]).toBeInstanceOf(ClaudeEventSource);
    expect(derived[0]!.source).toBe(legacy[0]!.source);
  });

  it('claude 事件入库；未知 source 行直接丢（与旧 400 同语义）', () => {
    const derived = createRuntimeRegistry().byCapability('events').flatMap((d) => d.events ?? []);
    writeFileSync(
      path.join(hooksDir, 'inbox', 'wiring.jsonl'),
      inboxLine(SAMPLE_REPORTS[0]!) + inboxLine({ source: 'codex', eventType: 'X', payload: '{}' }),
    );

    const records = drainInboxOnce({
      hooksDir,
      projects,
      hookEvents,
      hookSessions,
      adapters: derived,
    });
    expect(records).toHaveLength(1);
    const rows = hookEvents.listByProject(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventType).toBe('PostToolUse');
    expect(rows[0]!.sessionId).toBe('s1');
  });
});
