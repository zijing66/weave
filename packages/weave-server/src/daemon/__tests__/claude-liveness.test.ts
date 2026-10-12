import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_REG_GRACE_MS,
  claudeLivenessById,
  parseClaudeSessionReg,
  pidAlive,
  pidAliveOf,
} from '../claude-liveness.js';

/** 拿一个「刚才确定死过」的 pid：spawn 后立刻等它退出。 */
async function deadPid(): Promise<number> {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise((resolve) => child.on('exit', resolve));
  return pid;
}

describe('parseClaudeSessionReg', () => {
  it('正常登记', () => {
    expect(parseClaudeSessionReg('{"pid":1234,"sessionId":"abc-1","status":"busy"}')).toEqual({
      pid: 1234,
      sessionId: 'abc-1',
    });
  });

  it('坏输入一律 null：坏 json、缺字段、pid 非整数/负数', () => {
    expect(parseClaudeSessionReg('not json')).toBeNull();
    expect(parseClaudeSessionReg('{}')).toBeNull();
    expect(parseClaudeSessionReg('{"pid":"1234","sessionId":"a"}')).toBeNull();
    expect(parseClaudeSessionReg('{"pid":1.5,"sessionId":"a"}')).toBeNull();
    expect(parseClaudeSessionReg('{"pid":-3,"sessionId":"a"}')).toBeNull();
    expect(parseClaudeSessionReg('{"pid":1,"sessionId":""}')).toBeNull();
    expect(parseClaudeSessionReg('{"pid":1}')).toBeNull();
  });
});

describe('pidAlive', () => {
  it('当前进程活着', () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  it('刚退出的进程死了', async () => {
    expect(pidAlive(await deadPid())).toBe(false);
  });
});

describe('claudeLivenessById', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-liveness-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const reg = (pid: number, sessionId: string) => JSON.stringify({ pid, sessionId });

  it('活/死按 pid 探活区分；非登记文件与坏 json 跳过', async () => {
    const dead = await deadPid();
    writeFileSync(join(dir, `${process.pid}.json`), reg(process.pid, 'alive-1'));
    writeFileSync(join(dir, `${dead}.json`), reg(dead, 'dead-1'));
    writeFileSync(join(dir, `${process.pid}.key`), 'not-json-should-be-skipped');
    writeFileSync(join(dir, 'broken.json'), '{oops');
    const map = claudeLivenessById(dir);
    expect(map.get('alive-1')).toBe(true);
    expect(map.get('dead-1')).toBe(false);
    expect(map.size).toBe(2);
  });

  it('目录不存在 → 空图（查不到登记不判死）', () => {
    expect(claudeLivenessById(join(dir, 'nope')).size).toBe(0);
  });
});

describe('pidAliveOf（三态合成）', () => {
  const NOW = 1_700_000_000_000;
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const row = (
    over: Partial<{
      sessionId: string;
      harness: string | null;
      lastSeenAt: string;
      lastEventType: string | null;
      eventCount: number;
    }>,
  ) => ({
    sessionId: 's1',
    harness: 'claude' as string | null,
    lastSeenAt: ago(10 * 60_000),
    ...over,
  });

  it('登记命中直接是探活结果', () => {
    const live = new Map([['s1', true]]);
    const dead = new Map([['s1', false]]);
    expect(pidAliveOf(row({}), live, NOW)).toBe(true);
    expect(pidAliveOf(row({}), dead, NOW)).toBe(false);
    // 命中优先于 harness——登记在案的最可信
    expect(pidAliveOf(row({ harness: 'codex' }), live, NOW)).toBe(true);
  });

  it('查无登记 + claude + 过豁免窗 → false（进程已死文件已清）', () => {
    expect(pidAliveOf(row({}), new Map(), NOW)).toBe(false);
  });

  it('查无登记但新鲜（启动竞态）→ null 不猜', () => {
    expect(pidAliveOf(row({ lastSeenAt: ago(CLAUDE_REG_GRACE_MS - 1) }), new Map(), NOW)).toBeNull();
    expect(pidAliveOf(row({ lastSeenAt: ago(CLAUDE_REG_GRACE_MS + 1) }), new Map(), NOW)).toBe(
      false,
    );
  });

  it('仅剩一条 SessionStart 的空壳行（/continue、compact 幽灵）→ null 不判死', () => {
    expect(
      pidAliveOf(row({ lastEventType: 'SessionStart', eventCount: 1 }), new Map(), NOW),
    ).toBeNull();
    // 有后续事件的正经会话不受豁免
    expect(
      pidAliveOf(row({ lastEventType: 'SessionStart', eventCount: 3 }), new Map(), NOW),
    ).toBe(false);
    expect(
      pidAliveOf(row({ lastEventType: 'PostToolUse', eventCount: 8 }), new Map(), NOW),
    ).toBe(false);
  });

  it('查无登记且非 claude → null（codex/未知 harness 不猜）', () => {
    expect(pidAliveOf(row({ harness: 'codex' }), new Map(), NOW)).toBeNull();
    expect(pidAliveOf(row({ harness: null }), new Map(), NOW)).toBeNull();
  });
});
