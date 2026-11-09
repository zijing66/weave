/**
 * RPG 域 client（D1 动词门面）：web 只发游戏动词，不拼 REST 组合——修炼/组队/
 * 出征/传音都是一枚端点，游戏事实（成长/技巧分/六维）由 server 落。
 */

import { apiFetch } from './client';

export interface RpgHexagon {
  力量: number;
  智慧: number;
  敏捷: number;
  速度: number;
  内力: number;
  运气: number;
}

export interface RpgRoleView {
  id: number;
  projectId: number;
  name: string;
  archetype: string | null;
  persona: string | null;
  hexagon: RpgHexagon | null;
  createdAt: string;
  project: { id: number; path: string; name: string } | null;
}

export interface RpgGrowthRow {
  id: number;
  roleId: number;
  verb: string;
  target: string;
  detail: string | null;
  at: string;
}

export interface RpgHexagonView {
  dims: RpgHexagon;
  score: { role: number; score: number; basis: string | null; at: string } | null;
}

export interface CultivateResultView {
  ok: true;
  skill: string;
  projectPath: string;
  score: number;
  hexagon: RpgHexagon;
}

/** RPG-3 成长派生面（/rpg/roles/:id/progress）。 */
export interface RpgProgressView {
  xp: {
    total: number;
    breakdown: { quest: number; turns: number; cultivation: number; collaboration: number };
    level: number;
    nextAt: number;
    remaining: number;
    realm: string;
  };
  achievements: Array<{ key: string; describe: string; at: string | null; stats: string | null }>;
  hexagon: {
    base: RpgHexagon;
    bonus: Record<string, number>;
    dims: RpgHexagon;
    reason: string;
  };
}

/** RPG-3 成长榜行（/rpg/board）。 */
export interface RpgBoardRow {
  roleId: number;
  name: string;
  archetype: string | null;
  total: number;
  level: number;
  realm: string;
  achievements: number;
  dims: RpgHexagon | null;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export const rpgApi = {
  listRoles: () => apiFetch<{ roles: RpgRoleView[] }>('/rpg/roles'),
  /** 建角色（E4 验收④）：游戏视图内建角色入口，落 `<data>/rpg/roles/`。 */
  createRole: (input: { name: string; archetype?: string; persona?: string }) =>
    post<RpgRoleView>('/rpg/roles', input),
  listGrowth: (roleId: number) => apiFetch<{ growth: RpgGrowthRow[] }>(`/rpg/roles/${roleId}/growth`),
  hexagonOf: (roleId: number) => apiFetch<RpgHexagonView>(`/rpg/roles/${roleId}/hexagon`),
  /** 成长派生（XP/等级/境界/成就/六维修正；读侧派生 + 解锁事实落库）。 */
  progressOf: (roleId: number) => apiFetch<{ progress: RpgProgressView }>(`/rpg/roles/${roleId}/progress`),
  /** 成长榜（XP 降序）。 */
  growthBoard: () => apiFetch<{ board: RpgBoardRow[] }>('/rpg/board'),
  /** 修炼：给角色装一门 skill（sourceDir = 已落盘的技能源目录）。 */
  cultivate: (roleId: number, skill: string, sourceDir: string) =>
    post<CultivateResultView>(`/rpg/roles/${roleId}/cultivate`, { skill, sourceDir }),
  /** 组队：协调者 teams/ 落一份声明文件。 */
  formTeam: (input: { name: string; goal?: string; roles: Array<{ role: string; module?: string }>; playbook?: string }) =>
    post<{ ok: true; file: string; name: string }>('/rpg/teams', input),
  /** 出征：触发一次编排运行。 */
  expedition: (roleId: number, orchId: number, text?: string) =>
    post<{ ok: true; runId: number; orchName: string }>(`/rpg/roles/${roleId}/expedition`, { orchId, text }),
  /** 传音：给目标会话送一条消息。 */
  transmit: (roleId: number, toSessionId: string, text: string) =>
    post<{ ok: true; messageId: string; status: string }>(`/rpg/roles/${roleId}/message`, { toSessionId, text }),
};
