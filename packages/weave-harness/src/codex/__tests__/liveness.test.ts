import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexLivenessById, codexThreadLockDir, CODEX_LOCK_GRACE_MS } from '../liveness.js';

/**
 * 集成式测法：临时 CODEX_HOME 摆真锁文件、真跑平台探针（win32 = PowerShell
 * 一枪；其他平台探针回空集）。断言只锁「不误判死」与宽限窗三态——探针本身
 * 的 HELD 判定已由实机冒烟覆盖（活会话 HELD → true）。
 */

describe('codexLivenessById（锁探针 + 宽限窗）', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'weave-codex-liveness-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const lockDir = () => join(home, '.codex', 'thread-writer-locks');

  const writeLock = (id: string, mtime?: Date) => {
    mkdirSync(lockDir(), { recursive: true });
    const p = join(lockDir(), `${id}.lock`);
    writeFileSync(p, '');
    if (mtime) utimesSync(p, mtime, mtime);
  };

  it('目录不存在 → 空图（不误判死）', async () => {
    expect((await codexLivenessById(home)).size).toBe(0);
  });

  it('非 UUID 命名（.coordination.lock）跳过', async () => {
    writeLock('.coordination');
    expect((await codexLivenessById(home)).size).toBe(0);
  });

  it('探针结果只可能输出 true 或不输出——绝不无据判死', async () => {
    writeLock('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    writeLock('11111111-2222-3333-4444-555555555555');
    const map = await codexLivenessById(home);
    for (const v of map.values()) expect(v).toBe(true);
  });

  it('FREE 锁过宽限窗（mtime 老）→ false', async () => {
    const old = new Date(Date.now() - CODEX_LOCK_GRACE_MS * 2);
    writeLock('99999999-8888-7777-6666-555555555555', old);
    const map = await codexLivenessById(home);
    expect(map.get('99999999-8888-7777-6666-555555555555')).toBe(false);
  });

  it('codexThreadLockDir 落在注入 home 的 .codex 下', () => {
    expect(codexThreadLockDir(home)).toBe(join(home, '.codex', 'thread-writer-locks'));
  });
});
