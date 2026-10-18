import { describe, expect, it } from 'vitest';
import { parseRoute, routeToPath } from '../route';

describe('parseRoute', () => {
  it('空与未知路径 = 未选项目', () => {
    expect(parseRoute('/')).toEqual({ kind: 'none' });
    expect(parseRoute('/whatever')).toEqual({ kind: 'none' });
    expect(parseRoute('/p')).toEqual({ kind: 'none' });
    expect(parseRoute('/p/abc/tasks')).toEqual({ kind: 'none' });
    expect(parseRoute('/p/0/tasks')).toEqual({ kind: 'none' });
  });

  it('项目 + 卡片', () => {
    expect(parseRoute('/p/7/files')).toEqual({
      kind: 'project',
      projectId: 7,
      category: 'files',
      sessionId: null,
    });
  });

  it('项目 + 卡片 + 会话', () => {
    expect(parseRoute('/p/7/tasks/abc-123')).toEqual({
      kind: 'project',
      projectId: 7,
      category: 'tasks',
      sessionId: 'abc-123',
    });
  });

  it('未知分类回落默认卡', () => {
    expect(parseRoute('/p/7/nope')).toMatchObject({ category: 'tasks' });
    expect(parseRoute('/p/7')).toMatchObject({ category: 'tasks' });
    expect(parseRoute('/g/nope')).toEqual({ kind: 'global', category: 'tasks' });
  });

  it('全局模式', () => {
    expect(parseRoute('/g')).toEqual({ kind: 'global', category: 'tasks' });
    expect(parseRoute('/g/personalization')).toEqual({
      kind: 'global',
      category: 'personalization',
    });
  });
});

describe('routeToPath', () => {
  it('三种形态各自拼得回去', () => {
    expect(routeToPath({ kind: 'none' })).toBe('/');
    expect(routeToPath({ kind: 'global', category: 'tasks' })).toBe('/g/tasks');
    expect(
      routeToPath({ kind: 'project', projectId: 3, category: 'weave', sessionId: null }),
    ).toBe('/p/3/weave');
    expect(
      routeToPath({ kind: 'project', projectId: 3, category: 'tasks', sessionId: 'a b' }),
    ).toBe('/p/3/tasks/a%20b');
  });

  it('往返不丢信息', () => {
    for (const path of ['/', '/g/files', '/p/1/tasks', '/p/1/tasks/s-1', '/p/42/orchestrate']) {
      expect(routeToPath(parseRoute(path))).toBe(path);
    }
  });
});
