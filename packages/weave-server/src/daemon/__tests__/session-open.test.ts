import { describe, expect, it } from 'vitest';
import { duplicateInstanceError } from '../session-open.js';

describe('open-terminal 防双开判据', () => {
  it('没有活实例 = 放行', () => {
    expect(duplicateInstanceError([])).toBeNull();
  });

  it('已有活实例（Web PTY 或外部终端）= 409，错误里带 pid 让人找得到', () => {
    const one = duplicateInstanceError([4242]);
    expect(one).toMatchObject({ ok: false, status: 409 });
    expect(one?.error).toContain('4242');

    const two = duplicateInstanceError([4242, 5151]);
    expect(two?.status).toBe(409);
    expect(two?.error).toContain('4242');
    expect(two?.error).toContain('5151');
  });
});
