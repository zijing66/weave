import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { ClaudeCodeAdapter } from '../adapter.js';
import { sweepProjectSpools, SPOOL_FILE, SPOOL_CLAIM } from '../spool.js';

/** spool 一行 = HookReport JSONL（与 hook-handler.cjs 写入格式一致）。 */
function spoolLine(eventType: string, sessionId = 'sw-sess'): string {
  return JSON.stringify({
    source: 'claude',
    eventType,
    sessionId,
    cwd: '/proj',
    payload: JSON.stringify({ hook_event_name: eventType, session_id: sessionId }),
  });
}

describe('hooks spool sweep（daemon 启动回灌）', () => {
  let db: DatabaseSync;
  let projects: ProjectRepository;
  let hookEvents: HookEventRepository;
  let projectDir: string;
  let projectId: number;
  let spoolPath: string;
  let claimPath: string;

  beforeAll(() => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'weave-spool-'));
    db = openDatabase(':memory:');
    projects = new ProjectRepository(db);
    projectId = projects.register({
      path: projectDir,
      name: 'spool',
      token: 'stoken',
      source: 'init',
    }).id;
    hookEvents = new HookEventRepository(db);
    mkdirSync(path.join(projectDir, '.weave'), { recursive: true });
    spoolPath = path.join(projectDir, '.weave', SPOOL_FILE);
    claimPath = path.join(projectDir, '.weave', SPOOL_CLAIM);
  });

  afterAll(() => {
    db.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  const sweep = (): number =>
    sweepProjectSpools({
      projects,
      hookEvents,
      eventSources: [new ClaudeCodeAdapter()],
    });

  it('积压文件回灌入库并删除；坏行跳过', () => {
    writeFileSync(
      spoolPath,
      [spoolLine('PostToolUse'), '{ not json', '', spoolLine('Stop', 'sw-sess-2'), ''].join('\n'),
    );
    const flushed = sweep();
    expect(flushed).toBe(2);
    const rows = hookEvents.listByProject(projectId);
    expect(rows.map((r) => r.eventType).sort()).toEqual(['PostToolUse', 'Stop']);
    expect(existsSync(spoolPath)).toBe(false);
    expect(existsSync(claimPath)).toBe(false);
  });

  it('残留 claim（上次 flush 崩了一半）先消费，再认领 spool', () => {
    writeFileSync(claimPath, spoolLine('UserPromptSubmit', 'sw-claim') + '\n');
    writeFileSync(spoolPath, spoolLine('SessionStart', 'sw-spool') + '\n');
    const flushed = sweep();
    expect(flushed).toBe(2);
    const rows = hookEvents.listByProject(projectId);
    expect(rows.map((r) => r.eventType).sort()).toEqual([
      'PostToolUse',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
    expect(existsSync(spoolPath)).toBe(false);
    expect(existsSync(claimPath)).toBe(false);
  });

  it('入库抛错时 claim 原样留在盘上（下次 sweep 重试），spool 不被认领', () => {
    writeFileSync(claimPath, spoolLine('Notification') + '\n');
    writeFileSync(spoolPath, spoolLine('SubagentStop') + '\n');
    const broken = {
      insertMany: () => {
        throw new Error('db down');
      },
    } as unknown as HookEventRepository;
    const flushed = sweepProjectSpools({
      projects,
      hookEvents: broken,
      eventSources: [new ClaudeCodeAdapter()],
    });
    expect(flushed).toBe(0);
    expect(readFileSync(claimPath, 'utf8')).toContain('Notification');
    expect(readFileSync(spoolPath, 'utf8')).toContain('SubagentStop');

    // 库恢复后再扫：claim + spool 全部回灌，文件清空。
    const recovered = sweep();
    expect(recovered).toBe(2);
    expect(hookEvents.listByProject(projectId).map((r) => r.eventType)).toContain('Notification');
    expect(existsSync(spoolPath)).toBe(false);
    expect(existsSync(claimPath)).toBe(false);
  });
});
