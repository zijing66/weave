import { describe, expect, it, vi } from 'vitest';
import { createAwaitGate } from '../await-gate';

describe('await-gate', () => {
  it('条件当场成立就直接兑现（不挂等待者）', async () => {
    const gate = createAwaitGate(1000);
    let done = false;
    void gate.wait('a', () => true).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it('poke 只放行这一拍命中的人，其余照等', async () => {
    const gate = createAwaitGate(1000);
    let hit = false;
    const released: string[] = [];
    void gate.wait('a', () => hit).then(() => released.push('a'));
    void gate.wait('b', () => false).then(() => released.push('b'));
    gate.poke();
    await Promise.resolve();
    expect(released).toEqual([]);
    hit = true;
    gate.poke();
    await Promise.resolve();
    expect(released).toEqual(['a']);
  });

  it('到点未命中照样放行，且不留等待者（下一次可能同名）', async () => {
    vi.useFakeTimers();
    try {
      const gate = createAwaitGate(500);
      let done = false;
      void gate.wait('a', () => false).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(done).toBe(true);
      // 超时后的同名等待是全新的一次（旧的没把槽位占住）
      let again = false;
      void gate.wait('a', () => true).then(() => {
        again = true;
      });
      await Promise.resolve();
      expect(again).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releaseAll 把挂着的全放行（卸载时用）', async () => {
    const gate = createAwaitGate(1000);
    const released: string[] = [];
    void gate.wait('a', () => false).then(() => released.push('a'));
    void gate.wait('b', () => false).then(() => released.push('b'));
    gate.releaseAll();
    await Promise.resolve();
    expect(released.sort()).toEqual(['a', 'b']);
  });
});
