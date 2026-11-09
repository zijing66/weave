/**
 * 大屏可插拔展示位（D1 裁定：卡注册表 kind → 派生数据源）。卡只摆有数据的
 * ——派生函数返回 null = 该卡这一拍不渲染（绝不空壳）。场景卡族：办公区摆
 * coordinationFlow（编排运行流）+ decisionQueue（挂起待答）；会议室摆
 * reviewBoard（可批阅会话——改动汇总弹窗的入口）+ replay（run 日志回放）+
 * metrics（事件速率，数据 = dashboard.* 帧域）。
 */

import type { OrchestrationRunRow, PendingQuestionEntry, SessionRow } from '@/lib/api';
import type { RunGameStatus } from './status-map';
import { runGameStatusOf } from './status-map';

export type BigScreenCardTitleKey =
  | 'rpg.cardCoordination'
  | 'rpg.cardDecisionQueue'
  | 'rpg.cardReview'
  | 'rpg.cardReplay'
  | 'rpg.cardMetrics';

export type BigScreenCardEmptyKey =
  | 'rpg.flowEmpty'
  | 'rpg.decisionsEmpty'
  | 'rpg.reviewEmpty'
  | 'rpg.replayEmpty'
  | 'rpg.metricsEmpty';

export interface BigScreenCard<T> {
  kind: string;
  titleKey: BigScreenCardTitleKey;
  emptyKey: BigScreenCardEmptyKey;
  derive: (input: BigScreenInput) => T[] | null;
}

export interface BigScreenInput {
  runs: OrchestrationRunRow[] | null;
  questions: Map<string, PendingQuestionEntry>;
  /** 会话清单（最新在前）——review 入口与 replay 的定位键。 */
  sessions: SessionRow[] | null;
  /** 事件速率（最近 1 分钟计数，dashboard 速率面同源）；null = 还没数据。 */
  rate: number | null;
  /** 速率图窗（最近 1 小时逐 10s 桶，旧→新）；null = 还没数据。 */
  rateSeries: number[] | null;
}

export interface FlowEntryView {
  runId: number;
  orchName: string;
  gameStatus: RunGameStatus;
}

export interface DecisionEntryView {
  sessionId: string;
  at: string;
  title: string | null;
}

/** 会议室批阅卡行：可打开既有改动汇总弹窗的会话。 */
export interface ReviewEntryView {
  sessionId: string;
  projectId: number | null;
  title: string | null;
}

/** 会议室复盘卡行：一次 run 的回放（展开 = RunEvent 时间线）。 */
export interface ReplayEntryView {
  runId: number;
  orchName: string;
  gameStatus: RunGameStatus;
  deliveries: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** 会议室指标卡：速率数字 + 图窗。数值全 null = 无数据不摆。 */
export interface MetricsView {
  rate: number | null;
  series: number[] | null;
  events: number | null;
}

export function cardByKey(kind: string): BigScreenCard<unknown> | undefined {
  return BIG_SCREEN_CARDS.find((c) => c.kind === kind);
}

export const BIG_SCREEN_CARDS: readonly BigScreenCard<FlowEntryView | DecisionEntryView | ReviewEntryView | ReplayEntryView | MetricsView>[] = [
  {
    kind: 'coordinationFlow',
    titleKey: 'rpg.cardCoordination',
    emptyKey: 'rpg.flowEmpty',
    derive: ({ runs }) => {
      if (!runs || runs.length === 0) return null;
      return runs.slice(0, 8).map((r) => ({
        runId: r.id,
        orchName: r.orchestrationName,
        gameStatus: runGameStatusOf(r.status),
      }));
    },
  },
  {
    kind: 'decisionQueue',
    titleKey: 'rpg.cardDecisionQueue',
    emptyKey: 'rpg.decisionsEmpty',
    derive: ({ questions }) => {
      if (questions.size === 0) return null;
      return [...questions.values()].slice(0, 8).map((q) => ({
        sessionId: q.sessionId,
        at: q.at,
        title: q.questions[0]?.question ?? null,
      }));
    },
  },
  {
    kind: 'reviewBoard',
    titleKey: 'rpg.cardReview',
    emptyKey: 'rpg.reviewEmpty',
    derive: ({ sessions }) => {
      if (!sessions || sessions.length === 0) return null;
      // 有过对话的会话才可能有改动可批（按活动序，新在前）。
      const rows = sessions.filter((s) => s.projectId != null).slice(0, 8);
      if (rows.length === 0) return null;
      return rows.map((s) => ({
        sessionId: s.sessionId,
        projectId: s.projectId,
        title: s.title,
      }));
    },
  },
  {
    kind: 'replay',
    titleKey: 'rpg.cardReplay',
    emptyKey: 'rpg.replayEmpty',
    derive: ({ runs }) => {
      if (!runs || runs.length === 0) return null;
      return runs.slice(0, 8).map((r) => ({
        runId: r.id,
        orchName: r.orchestrationName,
        gameStatus: runGameStatusOf(r.status),
        deliveries: r.deliveries,
        error: r.error,
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
      }));
    },
  },
  {
    kind: 'metrics',
    titleKey: 'rpg.cardMetrics',
    emptyKey: 'rpg.metricsEmpty',
    derive: ({ rate, rateSeries }) => {
      const series = rateSeries ?? null;
      if (rate == null && (series == null || series.length === 0)) return null;
      return [{ rate, series, events: null }];
    },
  },
];
