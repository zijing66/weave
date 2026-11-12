import type { RpgRoutingDecisionRow } from './routing.js';
import type { RpgGoalRow } from './goals.js';
import type { RoutingProfileParams } from './profile.js';

/**
 * 复盘-提案（G6 进化闭环，G线设计 §六）：扫决策轨迹与 goal 账出信号，
 * 启发式生成调参草稿（零智能规则——决策模型缺席时进化仍产生，与任务分流
 * 三档瀑布同构）。**三红线之一：提案永不触碰级2 清单**——草稿只含策略参数
 * （RoutingProfileParams 词表封闭，profile.ts sanitize 双闸）。
 */

export interface RoutingReviewSignal {
  key: 'downgrade-misfire' | 'overturn-rate' | 'budget-tight';
  detail: string;
}

export interface RoutingProposalDraft {
  params: RoutingProfileParams;
  reason: string;
}

export interface RoutingReviewInput {
  decisions: readonly RpgRoutingDecisionRow[];
  goals: readonly Pick<RpgGoalRow, 'status' | 'stallStreak' | 'turnsUsed' | 'budgetTurns'>[];
  /** 当前生效参数（缺省展开后）——草稿从现状出发。 */
  current: { goalStallLimit: number; goalDriveCooldownMs: number };
}

export interface RoutingReviewResult {
  signals: RoutingReviewSignal[];
  proposal: RoutingProposalDraft | null;
}

/**
 * 复盘纯函数（读侧无副作用）：三路信号——
 * - downgrade-misfire：无进展熔断的降级呈批被上帝否得多（≥2 且过半）⇒ 熔断
 *   过敏，草稿 = stallLimit +2（封顶 9）；
 * - overturn-rate：翻案率 ≥ 20% 且样本 ≥ 5 ⇒ 如实报信号（无可调参——参数在
 *   级1 判据里，v1 不动，翻案位照用）；
 * - budget-tight：预算尽 goal 比达成的多且 ≥3 ⇒ 预算偏紧（立项时人放宽——
 *   不是全局参数，只报不提）。
 * 信号互斥出草稿：只有 stallLimit 有对应可调参，其余如实报告。
 */
export function reviewSignalsOf(input: RoutingReviewInput): RoutingReviewResult {
  const signals: RoutingReviewSignal[] = [];
  let proposal: RoutingProposalDraft | null = null;

  const downgrades = input.decisions.filter((d) => d.action === 'downgrade');
  const decided = downgrades.filter((d) => d.result === 'approved' || d.result === 'rejected');
  const rejected = downgrades.filter((d) => d.result === 'rejected');
  if (rejected.length >= 2 && rejected.length / Math.max(decided.length, 1) >= 0.5) {
    signals.push({
      key: 'downgrade-misfire',
      detail: `${rejected.length}/${decided.length} 次无进展熔断的降级呈批被否——熔断过敏`,
    });
    const next = Math.min(input.current.goalStallLimit + 2, 9);
    if (next > input.current.goalStallLimit) {
      proposal = {
        params: { goalStallLimit: next },
        reason: `降级呈批被否 ${rejected.length}/${decided.length}——建议熔断拍数 ${input.current.goalStallLimit} → ${next}（降敏）`,
      };
    }
  }

  const overturned = input.decisions.filter((d) => d.overturned > 0).length;
  if (input.decisions.length >= 5 && overturned / input.decisions.length >= 0.2) {
    signals.push({
      key: 'overturn-rate',
      detail: `翻案率 ${(overturned / input.decisions.length * 100).toFixed(0)}%（${overturned}/${input.decisions.length}）——级1 判据留观（v1 无对应全局参数，翻案位照用）`,
    });
  }

  const budgetOut = input.goals.filter((g) => g.status === 'budget_out').length;
  const achieved = input.goals.filter((g) => g.status === 'achieved').length;
  if (budgetOut >= 3 && budgetOut > achieved) {
    signals.push({
      key: 'budget-tight',
      detail: `预算尽 ${budgetOut} 例 > 达成 ${achieved} 例——立项预算偏紧（各 goal 的 budgetTurns，人放不进全局参数）`,
    });
  }

  return { signals, proposal };
}

/**
 * 进化频率闸（红线三）：同一邮件口径的提案（pending 或 24h 内已决的
 * cross-house-write 带 routingProfile）在堂 ⇒ 不重复出草稿。
 */
export function proposalGatedOf(input: {
  decisions: readonly Pick<RpgRoutingDecisionRow, 'action' | 'result' | 'input' | 'at'>[];
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  return input.decisions.some((d) => {
    if (d.action !== 'cross-house-write' || !d.input || !d.input.includes('routingProfile')) return false;
    if (d.result === 'pending') return true;
    if (d.result !== 'approved' && d.result !== 'rejected') return false;
    const at = Date.parse(d.at);
    return Number.isFinite(at) && now - at < 24 * 3_600_000;
  });
}
