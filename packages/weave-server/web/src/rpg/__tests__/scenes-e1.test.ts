import { describe, expect, it } from 'vitest';
import { RPG_SCENES, sceneOf } from '../scenes';
import { BIG_SCREEN_CARDS, cardByKey } from '../bigscreen';
import { hexagonSum } from '../growth-derive';
import { runGameStatusOf } from '../status-map';
import type { OrchestrationRunRow, SessionRow } from '@/lib/api';

const runRow = (over: Partial<OrchestrationRunRow>): OrchestrationRunRow => ({
  id: 1,
  orchestrationId: 1,
  orchestrationName: 'demo',
  projectId: 1,
  trigger: 'manual',
  status: 'done',
  deliveries: 2,
  error: null,
  createdAt: '2026-11-07T00:00:00Z',
  finishedAt: '2026-11-07T00:01:00Z',
  updatedAt: '2026-11-07T00:01:00Z',
  pendingCounts: {},
  ...over,
});

const sessionRow = (over: Partial<SessionRow>): SessionRow => ({
  sessionId: 's1',
  projectId: 1,
  title: '一号会话',
  pendingTitle: null,
  lastSeenAt: '2026-11-07T00:00:00Z',
  createdAt: '2026-11-07T00:00:00Z',
  ...over,
});

describe('E1 场景注册表', () => {
  it('教室与会议室从 placeholder 换成实装 kind，路由键不变', () => {
    expect(sceneOf('classroom').kind).toBe('classroom');
    expect(sceneOf('meeting').kind).toBe('meeting');
    expect(sceneOf('office').kind).toBe('office');
    expect(sceneOf('unknown').key).toBe('office');
    expect(RPG_SCENES).toHaveLength(3);
  });
});

describe('E1 大屏卡注册表（会议室三卡）', () => {
  it('reviewBoard：有会话才摆，取项目会话', () => {
    const card = cardByKey('reviewBoard')!;
    expect(cardByKey('reviewBoard')).toBeDefined();
    expect(card.derive({ runs: null, questions: new Map(), sessions: null, rate: null, rateSeries: null })).toBeNull();
    const rows = card.derive({
      runs: null,
      questions: new Map(),
      sessions: [sessionRow({}), sessionRow({ sessionId: 's2', projectId: null })],
      rate: null,
      rateSeries: null,
    }) as Array<{ sessionId: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessionId).toBe('s1');
  });

  it('replay：runs 有数据才摆，行带 gameStatus 与起止', () => {
    const card = cardByKey('replay')!;
    expect(card.derive({ runs: [], questions: new Map(), sessions: null, rate: null, rateSeries: null })).toBeNull();
    const rows = card.derive({
      runs: [runRow({})],
      questions: new Map(),
      sessions: null,
      rate: null,
      rateSeries: null,
    }) as Array<{ runId: number; gameStatus: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runId).toBe(1);
    expect(rows[0]!.gameStatus).toBe('victory');
  });

  it('metrics：速率与图窗全空 = null；有一边就摆', () => {
    const card = cardByKey('metrics')!;
    expect(card.derive({ runs: null, questions: new Map(), sessions: null, rate: null, rateSeries: null })).toBeNull();
    const withRate = card.derive({
      runs: null,
      questions: new Map(),
      sessions: null,
      rate: 3,
      rateSeries: null,
    }) as Array<{ rate: number }>;
    expect(withRate[0]!.rate).toBe(3);
    const withSeries = card.derive({
      runs: null,
      questions: new Map(),
      sessions: null,
      rate: null,
      rateSeries: [0, 2, 5],
    }) as Array<{ series: number[] }>;
    expect(withSeries[0]!.series).toEqual([0, 2, 5]);
  });

  it('既有两卡不因扩表退化：coordinationFlow 与 decisionQueue 仍派生', () => {
    const flow = cardByKey('coordinationFlow')!.derive({
      runs: [runRow({ status: 'running' })],
      questions: new Map(),
      sessions: null,
      rate: null,
      rateSeries: null,
    }) as Array<{ gameStatus: string }>;
    expect(flow[0]!.gameStatus).toBe(runGameStatusOf('running'));
    const q = cardByKey('decisionQueue')!.derive({
      runs: null,
      questions: new Map([
        [
          's1',
          {
            sessionId: 's1',
            harness: 'claude',
            kind: 'question',
            questions: [{ key: 'k', question: 'q?', options: [], multiSelect: false }],
            at: '2026-11-07T00:00:00Z',
          },
        ],
      ]),
      sessions: null,
      rate: null,
      rateSeries: null,
    }) as Array<{ title: string }>;
    expect(q[0]!.title).toBe('q?');
    expect(BIG_SCREEN_CARDS).toHaveLength(5);
  });
});

describe('E1 成长榜读面（六维派生，E2 数值前占位）', () => {
  it('hexagonSum = 六维之和', () => {
    expect(hexagonSum({ 力量: 3, 智慧: 3, 敏捷: 3, 速度: 3, 内力: 3, 运气: 3 })).toBe(18);
  });
});
