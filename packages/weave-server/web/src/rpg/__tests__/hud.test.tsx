import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { I18nProvider } from '@/i18n/I18nProvider';
import { headBarsOf, SpriteHeadBars, alertsOf, ClockWidget, nextSelectedRoleId, xpRatioOf } from '../hud';
import { wandererSpot } from '../RpgView';
import type { RpgRoleView, SessionRow, OrchestrationRunRow } from '@/lib/api';

/**
 * HUD 三件套派生防守（G2.5）：格按「有数据才摆」——派生不出 = null = 不渲染；
 * 警报按红先黄后；在野锚位出界截断。
 */

const NOW = 1_700_000_000_000;

function role(id: number, projectId: number): RpgRoleView {
  return {
    id,
    projectId,
    name: `role-${id}`,
    archetype: 'warrior',
    persona: null,
    hexagon: null,
    createdAt: new Date(NOW - 60_000).toISOString(),
    project: null,
  };
}

function session(sessionId: string, projectId: number, patch: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId,
    projectId,
    title: null,
    pendingTitle: null,
    lastSeenAt: new Date(NOW - 30_000).toISOString(),
    createdAt: new Date(NOW - 60_000).toISOString(),
    ...patch,
  } as SessionRow;
}

function run(id: number, status: string, error: string | null = null): OrchestrationRunRow {
  return {
    id,
    orchestrationId: 1,
    orchestrationName: `orch-${id}`,
    projectId: 1,
    trigger: 'manual',
    status,
    deliveries: 0,
    error,
    createdAt: new Date(NOW - 60_000).toISOString(),
    finishedAt: null,
    updatedAt: new Date(NOW - 60_000).toISOString(),
    pendingCounts: {},
  } as OrchestrationRunRow;
}

describe('headBarsOf', () => {
  const sessionById = new Map([
    ['s1', session('s1', 1, { contextTokens: 100_000, model: 'claude-ftm' })],
    ['s2', session('s2', 2)],
  ]);
  const statuses = new Map([
    ['s1', 'running' as const],
    ['s2', 'open' as const],
  ]);

  it('有据 = 三格都有值；绿按 1 - contextTokens/200k 窗口', () => {
    const bars = headBarsOf(role(1, 1), { sessionById, statuses, runs: [] }, NOW);
    expect(bars.hp).toBeCloseTo(0.5, 5);
    expect(bars.progress).toBeGreaterThan(0);
    expect(bars.health).toBeNull();
  });

  it('无 contextTokens = 绿格不摆（null，不摆空壳）；闲着 = 黄格不摆', () => {
    const bars = headBarsOf(role(2, 2), { sessionById, statuses, runs: [] }, NOW);
    expect(bars.hp).toBeNull();
    expect(bars.progress).toBeNull();
  });

  it('failed run → 红格热度（封顶 1）；零失败不摆', () => {
    const one = headBarsOf(role(1, 1), { sessionById, statuses, runs: [run(9, 'failed')] }, NOW);
    expect(one.health).toBeCloseTo(0.2, 5);
    const five = headBarsOf(role(1, 1), { sessionById, statuses, runs: [run(1, 'failed'), run(2, 'failed'), run(3, 'failed'), run(4, 'failed'), run(5, 'failed'), run(6, 'failed')] }, NOW);
    expect(five.health).toBe(1);
  });
});

describe('SpriteHeadBars', () => {
  it('全 null = 常驻纯绿「正常」条（G2.6 规格 §4.3：状态条是常驻器官不是装饰）', () => {
    const html = renderToString(<SpriteHeadBars bars={{ hp: null, progress: null, health: null }} />);
    expect(html).toContain('#3fbf5f');
    expect(html).toContain('pointer-events-none');
  });

  it('有据 = 渲染分段条', () => {
    const html = renderToString(<SpriteHeadBars bars={{ hp: 0.8, progress: null, health: 0.5 }} />);
    expect(html).toContain('pointer-events-none');
  });
});

describe('alertsOf', () => {
  it('挂起待答 = 红、失败 run 带 error = 红、不带 error = 黄；红排前', () => {
    const questions = new Map([['s1', { sessionId: 's1', kind: 'question' }]]);
    const alerts = alertsOf({
      questions: questions as never,
      runs: [run(2, 'failed'), run(3, 'failed', 'boom')],
      sessionById: new Map([['s1', session('s1', 1)]]),
      routingPending: 0,
    });
    expect(alerts.map((a) => a.severity)).toEqual(['red', 'red', 'yellow']);
  });

  it('级2 待批 = 红且排最前（G6 决策信箱）；零待批不摆', () => {
    const alerts = alertsOf({
      questions: new Map([['s1', { sessionId: 's1', kind: 'question' }]]) as never,
      runs: [run(3, 'failed', 'boom')],
      sessionById: new Map(),
      routingPending: 2,
    });
    expect(alerts[0]).toMatchObject({ key: 'routing-pending', severity: 'red', routing: true, label: '2' });
    expect(alerts.filter((a) => a.key === 'routing-pending')).toHaveLength(1);
  });

  it('无警报 = 空表（带子不出现由调用方判）', () => {
    expect(alertsOf({ questions: new Map(), runs: [], sessionById: new Map(), routingPending: 0 })).toEqual([]);
  });
});

describe('wandererSpot', () => {
  it('路南草带一排（54 宽图，x=22 起间隔 4）、出界截断', () => {
    expect(wandererSpot(0)).toEqual({ x: 22, y: 12 });
    expect(wandererSpot(1)).toEqual({ x: 26, y: 12 });
    expect(wandererSpot(-1)).toBeNull();
    expect(wandererSpot(8)).toBeNull();
  });
});

describe('G2.6 交互与详情条派生', () => {
  it('nextSelectedRoleId：无角色 null；无选中取首个；循环切换（尾→首）', () => {
    const roles = [{ id: 7 }, { id: 3 }, { id: 5 }];
    expect(nextSelectedRoleId([], null)).toBeNull();
    expect(nextSelectedRoleId(roles, null)).toBe(7);
    expect(nextSelectedRoleId(roles, 7)).toBe(3);
    expect(nextSelectedRoleId(roles, 5)).toBe(7);
    expect(nextSelectedRoleId(roles, 99)).toBe(7);
  });

  it('xpRatioOf：nextAt/remaining 派生进度，异常档位回落 null（不摆空壳条）', () => {
    expect(xpRatioOf({ total: 40, breakdown: { quest: 0, turns: 0, cultivation: 0, collaboration: 0 }, level: 2, nextAt: 100, remaining: 60, realm: '炼气' })).toBeCloseTo(0.4, 5);
    expect(xpRatioOf({ total: 40, breakdown: { quest: 0, turns: 0, cultivation: 0, collaboration: 0 }, level: 2, nextAt: 0, remaining: 0, realm: '炼气' })).toBeNull();
    expect(xpRatioOf({ total: 40, breakdown: { quest: 0, turns: 0, cultivation: 0, collaboration: 0 }, level: 2, nextAt: 50, remaining: 100, realm: '炼气' })).toBeNull();
  });
});

describe('ClockWidget', () => {
  it('rate 与 runningCount 都 null = 不摆', () => {
    const html = renderToString(
      <I18nProvider>
        <ClockWidget rate={null} runningCount={null} />
      </I18nProvider>,
    );
    expect(html).toBe('');
  });

  it('有速率 = 摆时钟位', () => {
    const html = renderToString(
      <I18nProvider>
        <ClockWidget rate={5} runningCount={0} />
      </I18nProvider>,
    );
    expect(html).toContain('rpg-hud-anchor');
  });
});
