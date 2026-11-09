/**
 * 大屏可插拔展示位（D1 裁定：卡注册表 kind → 派生数据源）。卡只摆有数据的
 * ——派生函数返回 null = 该卡这一拍不渲染（绝不空壳）。v1 两卡：
 * coordinationFlow（编排运行流，数据 = 既有 runs 派生）与 decisionQueue
 * （挂起待答，数据 = useSessionStatus 的 questions）。
 */

import type { OrchestrationRunRow } from '@/lib/api';
import type { PendingQuestionEntry } from '@/lib/api';
import type { RunGameStatus } from './status-map';
import { runGameStatusOf } from './status-map';

export interface BigScreenCard<T> {
  kind: string;
  titleKey: 'rpg.cardCoordination' | 'rpg.cardDecisionQueue';
  emptyKey: 'rpg.flowEmpty' | 'rpg.decisionsEmpty';
  derive: (input: BigScreenInput) => T[] | null;
}

export interface BigScreenInput {
  runs: OrchestrationRunRow[] | null;
  questions: Map<string, PendingQuestionEntry>;
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

export const BIG_SCREEN_CARDS: readonly BigScreenCard<FlowEntryView | DecisionEntryView>[] = [
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
];
