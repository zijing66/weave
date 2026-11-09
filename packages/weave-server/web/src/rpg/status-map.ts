/**
 * 会话状态 → 游戏状态机（纯函数映射，D1 裁定：不引 XState）。
 * 观察态全派生——`deriveSessionStatus` 的七态收进四个游戏态：
 * 战斗（running/compacting，动画帧快）、待命（open/interrupted，呼吸帧）、
 * 败退（failed）、退场（closed/terminated——在场景里只剩一座空位标记）。
 */

import type { SessionStatus } from '@/components/tasks/session-status';

export type GameStatus = 'battle' | 'idle' | 'defeated' | 'gone';

export function gameStatusOf(status: SessionStatus): GameStatus {
  switch (status) {
    case 'running':
    case 'compacting':
      return 'battle';
    case 'failed':
      return 'defeated';
    case 'closed':
    case 'terminated':
      return 'gone';
    default:
      return 'idle';
  }
}

/** 游戏态 → 动画帧配置（CSS keyframes 名 + 周期；weaveRPG.md 状态帧表）。 */
export const GAME_STATUS_ANIM: Record<GameStatus, { frames: number; periodMs: number }> = {
  battle: { frames: 4, periodMs: 120 * 4 },
  idle: { frames: 2, periodMs: 500 * 2 },
  defeated: { frames: 3, periodMs: 180 * 3 },
  gone: { frames: 4, periodMs: 180 * 4 },
};

/** 编排 run 状态 → 游戏看板态（战况徽标）。 */
export type RunGameStatus = 'fighting' | 'victory' | 'defeat' | 'withdrawn' | 'interrupted';

export function runGameStatusOf(status: string): RunGameStatus {
  switch (status) {
    case 'running':
      return 'fighting';
    case 'done':
      return 'victory';
    case 'failed':
      return 'defeat';
    case 'cancelled':
      return 'withdrawn';
    default:
      return 'interrupted';
  }
}
