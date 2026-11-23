import { describe, expect, it } from 'vitest';
import { displacedWebInstances, duplicateInstanceVerdict } from '../session-open.js';

describe('open-terminal 防双开判据（pid 时间序挤掉）', () => {
  it('没有活实例 = 放行', () => {
    expect(duplicateInstanceVerdict([], [])).toEqual({ ok: true, displacedIds: [] });
  });

  it('旧实例里有 web PTY（daemon 可杀）= 挤掉全部 web 实例放行（新挤旧）', () => {
    expect(duplicateInstanceVerdict([4242], ['wvi-abc'])).toEqual({
      ok: true,
      displacedIds: ['wvi-abc'],
    });
    expect(duplicateInstanceVerdict([4242, 5151], ['wvi-abc', 'wvi-def'])).toEqual({
      ok: true,
      displacedIds: ['wvi-abc', 'wvi-def'],
    });
  });

  it('旧实例全在外部终端（daemon 杀不了）= 409，错误里带 pid 让人找得到', () => {
    const one = duplicateInstanceVerdict([4242], []);
    expect(one).toMatchObject({ ok: false, status: 409 });
    expect(one.ok === false && one.error).toContain('4242');

    const two = duplicateInstanceVerdict([4242, 5151], []);
    expect(two.ok === false && two.error).toContain('4242');
    expect(two.ok === false && two.error).toContain('5151');
  });
});

describe('外部终端抢进来 → web 实例让位', () => {
  it('web 实例 + 一个陌生 pid = 外部在场 → 让位', () => {
    expect(displacedWebInstances([4242, 5151], [{ id: 'wvi-abc', osPid: 4242 }])).toEqual([
      'wvi-abc',
    ]);
  });

  it('只有 web 实例自己的 pid（单开）= 不动', () => {
    expect(displacedWebInstances([4242], [{ id: 'wvi-abc', osPid: 4242 }])).toEqual([]);
  });

  it('web 实例 osPid 还没对账回来（认不出自己的 pid）= 不动，绝不误杀', () => {
    expect(displacedWebInstances([4242, 5151], [{ id: 'wvi-abc' }])).toEqual([]);
  });

  it('没有 web 实例（全在外部终端）= 无事可做', () => {
    expect(displacedWebInstances([4242, 5151], [])).toEqual([]);
  });

  it('最新的是 web 自己（外部更老、杀不了）= 不动，留双开告警', () => {
    expect(displacedWebInstances([5151, 4242], [{ id: 'wvi-abc', osPid: 4242 }])).toEqual([]);
  });

  it('多个 web 实例都让位（同一会话双 web + 外部）', () => {
    expect(
      displacedWebInstances([1, 2, 3], [
        { id: 'wvi-a', osPid: 1 },
        { id: 'wvi-b', osPid: 2 },
      ]),
    ).toEqual(['wvi-a', 'wvi-b']);
  });
});
