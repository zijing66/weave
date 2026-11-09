import { describe, expect, it } from 'vitest';
import { visibleProjectsOf } from '../ProjectList';
import { shuttleVisibleProjects } from '../tasks/SessionShuttlePicker';
import type { ProjectRow } from '@/lib/api';

const project = (over: Partial<ProjectRow>): ProjectRow => ({
  id: 1,
  path: 'D:/p/demo',
  name: 'demo',
  token: 't',
  source: 'init',
  registeredAt: '2026-11-08T00:00:00Z',
  lastSeenAt: null,
  meta: null,
  ...over,
});

describe('hidden 项目过滤（E4 验收⑤：只发生在渲染层）', () => {
  it('侧栏滤 hidden 行，普通行照旧', () => {
    const rows = [
      project({ id: 1, name: 'a' }),
      project({ id: 2, name: 'rpg-keeper', hidden: true }),
      project({ id: 3, name: 'b' }),
    ];
    expect(visibleProjectsOf(rows).map((p) => p.id)).toEqual([1, 3]);
  });

  it('# 选择器同判据：hidden 项目行与会话都不进候选', () => {
    const rows = [
      project({ id: 1, name: 'a' }),
      project({ id: 9, name: 'coordinator', hidden: true }),
    ];
    expect(shuttleVisibleProjects(rows).map((p) => p.id)).toEqual([1]);
  });

  it('hidden 缺省（undefined = 旧响应/未标记）不滤', () => {
    const rows = [project({ hidden: undefined })];
    expect(visibleProjectsOf(rows)).toHaveLength(1);
    expect(shuttleVisibleProjects(rows)).toHaveLength(1);
  });

  it('全 hidden = 侧栏与选择器都空（空态文案由各自组件管）', () => {
    const rows = [project({ id: 2, hidden: true })];
    expect(visibleProjectsOf(rows)).toHaveLength(0);
  });
});
