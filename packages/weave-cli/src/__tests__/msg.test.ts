import { describe, it, expect } from 'vitest';
import { resolveSessionRef, currentSessionId, pickReplyTarget } from '../commands/msg.js';

/** msg 命令纯函数回归：寻址（D4 模糊匹配）、会话内身份（sessionEnv 声明）、
 *  回复目标（from 即 to）。HTTP 面走 daemon 既有路由，不在单测覆盖。 */

const sessions = [
  { sessionId: 'aaaaaaaa-1111', title: 'frontend refactor' },
  { sessionId: 'aaaaaaaa-2222', title: null },
  { sessionId: 'bbbbbbbb-1111', title: 'Backend API' },
];

describe('resolveSessionRef', () => {
  it('精确 id 命中（大小写不敏感）', () => {
    expect(resolveSessionRef(sessions, 'AAAAAAAA-1111')).toEqual({ row: sessions[0] });
  });

  it('id 前缀唯一命中；跨行前缀歧义走标题', () => {
    expect(resolveSessionRef(sessions, 'bbbbbbbb')).toEqual({ row: sessions[2] });
  });

  it('标题模糊唯一命中（大小写不敏感）', () => {
    expect(resolveSessionRef(sessions, 'backend')).toEqual({ row: sessions[2] });
  });

  it('多命中 = ambiguous（带候选行）', () => {
    const r = resolveSessionRef(sessions, 'aaaaaaaa');
    expect(r.error).toBe('ambiguous');
    if (r.error === 'ambiguous') expect(r.rows).toHaveLength(2);
  });

  it('零命中 = not-found', () => {
    expect(resolveSessionRef(sessions, 'zzz').error).toBe('not-found');
  });
});

describe('currentSessionId', () => {
  it('按声明顺序取第一个非空 env', () => {
    expect(currentSessionId({ CLAUDE_CODE_SESSION_ID: 's1' }, ['CLAUDE_CODE_SESSION_ID'])).toBe('s1');
  });

  it('跳过未声明/空值；全空 → null', () => {
    expect(currentSessionId({ A: 'x' }, [undefined, 'B'])).toBeNull();
    expect(currentSessionId({ A: '' }, ['A'])).toBeNull();
    expect(currentSessionId({}, ['A'])).toBeNull();
  });
});

describe('pickReplyTarget', () => {
  const thread = [
    { toSessionId: 'me', fromSessionId: 'other-1' },
    { toSessionId: 'other-1', fromSessionId: 'me' },
    { toSessionId: 'me', fromSessionId: null },
    { toSessionId: 'me', fromSessionId: 'other-2' },
  ];

  it('最后一条带发起方的入站消息 = 回复目标', () => {
    expect(pickReplyTarget(thread, 'me')).toBe('other-2');
  });

  it('只看出站方向（fromSessionId=我）与 dashboard 来信不算', () => {
    expect(
      pickReplyTarget(
        [
          { toSessionId: 'me', fromSessionId: 'other-1' },
          { toSessionId: 'x', fromSessionId: 'me' },
          { toSessionId: 'me', fromSessionId: null },
        ],
        'me',
      ),
    ).toBe('other-1');
  });

  it('无线程 → null', () => {
    expect(pickReplyTarget([], 'me')).toBeNull();
  });
});
