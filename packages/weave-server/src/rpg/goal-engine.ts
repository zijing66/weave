import type { Harness } from '@weavecode/core';
import { HARNESS_LIFECYCLE, HARNESS_TOOL_EVENTS } from '@weavecode/core';
import type { MessageDeliverer } from '../hooks/message-deliverer.js';
import { combinedLivenessOf } from '../daemon/liveness.js';
import { pidAliveOf } from '../daemon/claude-liveness.js';
import type { ProjectRepository } from '../repositories/projects.js';
import type { SessionRepository } from '../repositories/sessions.js';
import type { RpgRoleRepository } from './roles.js';
import type { RpgExpeditionRepository } from './expedition-repo.js';
import type { RpgGoalRepository, RpgGoalRow } from './goals.js';
import type { RpgRoutingDecisionRepository } from './routing.js';
import { routeRpgAction } from './routing.js';

/**
 * goal 驱动循环（G6 批4b，G线设计 §四「goal 模式」）：服务端节拍器驱动模型回合
 * ——重启可续（回合账落库），不上常驻子进程。
 *
 * 两个挂点：
 * - `onEvent`：ingest 消费链（第六消费者，与 watch/orchestration 平行）。回合收尾
 *   事件 = 落账一回合（turns_used+1）；拍内工具事件 = 进度证据（stall_streak 清零，
 *   否则 +1）。失控兜底两闸都在落账后判：
 *   - 预算闸：turns_used ≥ budget_turns → 状态 budget_out + 呈信箱
 *     （pending budget-renew——「要不要续期」恒问上帝）；
 *   - 无进展熔断：stall_streak ≥ 上限 → 状态 paused + 呈信箱
 *     （pending downgrade——降标/换法/放弃建议稿，协调者 skill 同口径）。
 * - `tick`：装配侧 30s 节拍（同 cronTick 形态）。对 active goal 的目标会话投
 *   三岔口自查契约（origin 'goal'——投递器据此登记诱导回合，编排的自然回合
 *   判定不会被 goal 驱动误触发）。冷却窗内不重投；目标忙（turnOpen 非 false）
 *   或判死（pidAlive false）不投——v1 只驱已活会话，拉起归上帝。
 */

/** 推进节拍冷却（自主推进边「无正文只带冷却」的服务端时钟近似）。 */
export const GOAL_DRIVE_COOLDOWN_MS = 90_000;
/** 无进展熔断阈值：连续 N 拍零工具事件。 */
export const GOAL_STALL_LIMIT = 3;

export interface GoalEngineDeps {
  goals: Pick<RpgGoalRepository, 'list' | 'getById' | 'noteTurn' | 'updateStatus'>;
  roles: Pick<RpgRoleRepository, 'getByProjectId'>;
  expeditions: Pick<RpgExpeditionRepository, 'getBySessionKey' | 'listByRole'>;
  routing: Pick<RpgRoutingDecisionRepository, 'insert'>;
  deliverer: Pick<MessageDeliverer, 'send'>;
  projects: Pick<ProjectRepository, 'getById'>;
  sessions: Pick<SessionRepository, 'getBySessionId' | 'listWithCounts' | 'turnOpenOf'>;
  /** 测试注入；缺省 combinedLivenessOf。 */
  livenessOf?: () => Map<string, boolean>;
  /** 测试注入；缺省 GOAL_DRIVE_COOLDOWN_MS。 */
  driveCooldownMs?: number;
  /** 测试注入；缺省 GOAL_STALL_LIMIT。 */
  stallLimit?: number;
  /** 策略档读点（G6 进化闭环）：级2 落档的参数实时生效（每读现查）；缺省全走内置。 */
  profile?: { resolved(): { goalStallLimit: number; goalDriveCooldownMs: number } };
}

export class RpgGoalEngine {
  /** 拍内进度证据：sessionId → 该拍是否出现过工具事件（收尾即清）。 */
  private readonly toolSeen = new Map<string, boolean>();
  /** 推进冷却：goalId → 上次驱动时刻。 */
  private readonly lastDriveAt = new Map<number, number>();

  constructor(private readonly deps: GoalEngineDeps) {}

  /** ingest 消费路径的事件钩子（fire-and-forget；内部全吞）。 */
  onEvent(input: { sessionId: string; eventType: string; source: Harness }): void {
    try {
      const toolEvents: readonly string[] = HARNESS_TOOL_EVENTS[input.source] ?? [];
      const closeEvents: readonly string[] = HARNESS_LIFECYCLE[input.source].close;
      if (toolEvents.includes(input.eventType)) {
        this.toolSeen.set(input.sessionId, true);
        return;
      }
      if (!closeEvents.includes(input.eventType)) return;
      const progressed = this.toolSeen.get(input.sessionId) ?? false;
      this.toolSeen.delete(input.sessionId);
      const roleId = this.roleOf(input.sessionId);
      if (roleId == null) return;
      for (const goal of this.deps.goals.list({ roleId, status: 'active' })) {
        this.settleTurn(goal, progressed, input.sessionId);
      }
    } catch {
      // 库错误不影响采集
    }
  }

  /** 当前冷却窗（策略档实时盖过注入/内置——进化闭环的生效点）。 */
  private cooldownMs(): number {
    return this.deps.profile?.resolved().goalDriveCooldownMs ?? this.deps.driveCooldownMs ?? GOAL_DRIVE_COOLDOWN_MS;
  }

  /** 当前熔断阈值（同上）。 */
  private stallLimitNow(): number {
    return this.deps.profile?.resolved().goalStallLimit ?? this.deps.stallLimit ?? GOAL_STALL_LIMIT;
  }

  /** 推进节拍（装配侧 30s 一枪）：返回本拍实际发起的驱动数。 */
  tick(now: number = Date.now()): number {
    let driven = 0;
    try {
      for (const goal of this.deps.goals.list({ status: 'active' })) {
        const last = this.lastDriveAt.get(goal.id) ?? 0;
        if (now - last < this.cooldownMs()) continue;
        const target = this.targetSessionOf(goal);
        if (!target) continue;
        this.lastDriveAt.set(goal.id, now);
        void this.deps.deliverer
          .send({
            toSessionId: target,
            text: goalPromptOf(goal),
            mode: 'prompt',
            fromKind: 'dashboard',
            origin: 'goal',
            oneWay: true,
          })
          .catch(() => {});
        driven++;
      }
    } catch {
      // 单拍失败不影响下一拍
    }
    return driven;
  }

  /** 会话 → 角色：出征行改绑后的 session_key 命中即归那支出征的角色；否则角色仓项目归一。 */
  private roleOf(sessionId: string): number | null {
    const expedition = this.deps.expeditions.getBySessionKey(sessionId);
    if (expedition) return expedition.roleId;
    const session = this.deps.sessions.getBySessionId(sessionId);
    if (session?.projectId == null) return null;
    return this.deps.roles.getByProjectId(session.projectId)?.id ?? null;
  }

  /** goal 的目标会话：active 出征会话优先，其次角色仓最近活跃的会话；判死/无会话 = null。 */
  private targetSessionOf(goal: RpgGoalRow): string | null {
    const liveness = this.deps.livenessOf?.() ?? combinedLivenessOf();
    const rows = this.deps.sessions.listWithCounts();
    const aliveAndIdle = (sessionId: string): boolean => {
      const row = rows.find((r) => r.sessionId === sessionId);
      if (!row || pidAliveOf(row, liveness) === false) return false;
      return this.deps.sessions.turnOpenOf(sessionId) === false; // 未知（null）不猜：不驱
    };
    for (const exp of this.deps.expeditions.listByRole(goal.roleId)) {
      if (exp.status !== 'active' || !exp.sessionKey || exp.sessionKey.startsWith('pending-')) continue;
      if (aliveAndIdle(exp.sessionKey)) return exp.sessionKey;
    }
    const roleProject = this.deps.roles.getByProjectId(
      this.deps.goals.getById(goal.id)?.roleId ?? goal.roleId,
    )?.projectId;
    if (roleProject == null) return null;
    const home = rows
      .filter((r) => r.projectId === roleProject && aliveAndIdle(r.sessionId))
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))[0];
    return home?.sessionId ?? null;
  }

  /** 回合落账 + 失控兜底两闸（预算闸 / 无进展熔断）；闸动作一次落定（状态机幂等）。 */
  private settleTurn(goal: RpgGoalRow, progressed: boolean, sessionId: string): void {
    const updated = this.deps.goals.noteTurn(goal.id, progressed);
    if (!updated || updated.status !== 'active') return;
    const limit = this.stallLimitNow();
    if (updated.budgetTurns != null && updated.turnsUsed >= updated.budgetTurns) {
      this.deps.goals.updateStatus(
        updated.id,
        'budget_out',
        `预算 ${updated.budgetTurns} 回合耗尽（已跑 ${updated.turnsUsed}）——续否由上帝裁`,
      );
      this.report(updated, 'budget-renew',
        `goal「${updated.title}」回合预算 ${updated.budgetTurns} 耗尽（已跑 ${updated.turnsUsed}）——续期或撤销呈批`, sessionId);
      return;
    }
    if (updated.stallStreak >= limit) {
      this.deps.goals.updateStatus(
        updated.id,
        'paused',
        `连续 ${updated.stallStreak} 拍零工具事件（无进展熔断）——降级评估呈批`,
      );
      this.report(updated, 'downgrade',
        `goal「${updated.title}」连续 ${updated.stallStreak} 拍零进展（机制熔断）——降标/换法/放弃建议稿呈批`, sessionId);
    }
  }

  /** 呈信箱：pending 级2 行（执行权恒等用户；信箱面即批1 的 RoutingInbox）。 */
  private report(goal: RpgGoalRow, action: 'budget-renew' | 'downgrade', detail: string, sessionId: string): void {
    const route = routeRpgAction(action); // 词表唯一权威（level/basis 不散写）
    this.deps.routing.insert({
      projectId: goal.projectId ?? null,
      sessionId,
      action,
      level: route.level,
      basis: route.basis,
      input: JSON.stringify({ goalId: goal.id }),
      result: 'pending',
      source: null, // 机制层呈报（无 AI 裁决参与）；上帝批/拒不猜
      detail,
    });
  }
}

/** 三岔口自查契约（persona 契约的 prompt 层；G线设计 §四）。 */
export function goalPromptOf(goal: Pick<RpgGoalRow, 'title' | 'terminal'>): string {
  return [
    `[weave goal]「${goal.title}」自主推进拍：朝终态条件走你的下一拍。`,
    `终态条件：${goal.terminal}`,
    '三岔口自查——顺畅则继续；无法决策或触及不可逆/跨边界/价值敏感动作则停手上报（等上帝批）；终态条件已命中则收官播报，不开新工。',
  ].join('\n');
}
