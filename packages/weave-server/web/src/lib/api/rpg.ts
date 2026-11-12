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
  /** male | female；null = 未指定（服务端随机）或旧角色。 */
  gender?: 'male' | 'female' | null;
  /** 外貌种子；null = 未指定（服务端随机）或旧角色。 */
  appearanceSeed?: number | null;
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

export interface RpgHouseMemberView {
  id: number;
  houseId: number;
  kind: 'aux' | 'role';
  projectId: number | null;
  roleId: number | null;
  addedAt: string;
}

/** 修炼产物行（G3，/rpg/roles/:id/crops）。 */
export interface RpgCropView {
  id: number;
  roleId: number;
  projectId: number | null;
  kind: 'farming' | 'fishing';
  name: string;
  artifactPath: string | null;
  hasArtifact: boolean;
  hasTests: boolean;
  lintOk: boolean;
  docsOk: boolean;
  /** 凡 | 灵 | 仙 | 天（null = 未评定）。 */
  grade: string | null;
  status: 'growing' | 'harvested' | 'discarded' | 'promoted';
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RpgHouseView {
  id: number;
  name: string;
  coreProjectId: number;
  coordinatorPersona: string | null;
  createdAt: string;
  updatedAt: string;
  members: RpgHouseMemberView[];
}

/** 出征账行（G6 角色可见桥：项目行徽章 + 折叠区的数据源）。 */
export interface RpgExpeditionView {
  id: number;
  roleId: number;
  projectId: number;
  sessionKey: string | null;
  branch: string;
  anchorBranch: string;
  anchorSha: string;
  status: 'active' | 'merged' | 'conflict' | 'dangling' | 'frozen' | 'error';
  title: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 决策分级路由行（G6，/rpg/routing/decisions）：级2 待批进信箱、已决行作轨迹。 */
export interface RpgRoutingDecisionView {
  id: number;
  projectId: number | null;
  sessionId: string | null;
  action: string;
  level: number;
  basis: string;
  input: string | null;
  result: 'pending' | 'approved' | 'rejected' | 'allowed' | 'blocked' | 'tripped';
  source: 'decision-model' | 'fork' | 'god' | null;
  detail: string | null;
  overturned: number;
  at: string;
}

export interface RpgRoutingStatsView {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  allowed: number;
  blocked: number;
  tripped: number;
  overturned: number;
}

/** goal 行（G6 批4/4c，/rpg/goals）：长期驻留到达成/预算尽/撤销；驱动循环的事实源。 */
export interface RpgGoalView {
  id: number;
  houseId: number | null;
  roleId: number;
  projectId: number | null;
  title: string;
  terminal: string;
  budgetTurns: number | null;
  budgetTokens: number | null;
  turnsUsed: number;
  stallStreak: number;
  status: 'active' | 'paused' | 'achieved' | 'abandoned' | 'budget_out';
  statusNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export const rpgApi = {
  listRoles: () => apiFetch<{ roles: RpgRoleView[] }>('/rpg/roles'),
  /** 房子域（G2）：建房（核心+辅助+角色入住一步落）/ 名册（live 展开随库现读）。 */
  listHouses: () => apiFetch<{ houses: RpgHouseView[] }>('/rpg/houses'),
  fetchHouse: (id: number) => apiFetch<RpgHouseView>(`/rpg/houses/${id}`),
  createHouse: (input: {
    name: string;
    coreProjectId: number;
    coordinatorPersona?: string;
    auxProjectIds?: number[];
    roleIds?: number[];
  }) => post<RpgHouseView>('/rpg/houses', input),
  updateHouse: (id: number, patch: { name?: string; coordinatorPersona?: string | null }) =>
    apiFetch<RpgHouseView>(`/rpg/houses/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteHouse: (id: number) => apiFetch<{ ok: boolean }>(`/rpg/houses/${id}`, { method: 'DELETE' }),
  addHouseMember: (id: number, member: { kind: 'aux'; projectId: number } | { kind: 'role'; roleId: number }) =>
    post<RpgHouseView>(`/rpg/houses/${id}/members`, member),
  removeHouseMember: (id: number, memberId: number) =>
    apiFetch<RpgHouseView>(`/rpg/houses/${id}/members/${memberId}`, { method: 'DELETE' }),
  /** 建角色（E4 验收④）：游戏视图内建角色入口，落 `<data>/rpg/roles/`。 */
  createRole: (input: {
    name: string;
    archetype?: string;
    persona?: string;
    gender?: 'male' | 'female';
    appearanceSeed?: number;
  }) =>
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
  // ---- 修炼域（G3）：种田/钓鱼产物账 + 品阶 + 晋升三档 ----
  listCrops: (roleId: number) => apiFetch<{ crops: RpgCropView[] }>(`/rpg/roles/${roleId}/crops`),
  /** 下种（kind: farming=种田 | fishing=钓鱼）：角色仓 crops/<名>/ 落一块田。 */
  plantCrop: (roleId: number, kind: 'farming' | 'fishing', name: string) =>
    post<{ cropId: number; fieldPath: string }>(`/rpg/roles/${roleId}/crops`, { kind, name }),
  /** 收菜验收（钓鱼的「咬钩」同此收口）：度量落列 + 品阶即评定（服务端按盘上事实重算）。 */
  assessCrop: (cropId: number, metrics?: Partial<{ hasArtifact: boolean; hasTests: boolean; lintOk: boolean; docsOk: boolean }>) =>
    post<{ crop: RpgCropView }>(`/rpg/crops/${cropId}/assess`, metrics ?? {}),
  /** 收菜装进角色仓 `.claude/skills/`（灵品+ 闸）。 */
  harvestCrop: (cropId: number) => post<{ ok: boolean; installedAt: string }>(`/rpg/crops/${cropId}/harvest`, {}),
  /** 晋升三档（tier 1=项目档 2=内建仓库 3=全局用户级；级2 确认闸在 web 呈 ConfirmDialog）。 */
  promoteCrop: (cropId: number, tier: 1 | 2 | 3) =>
    post<{ ok: boolean; tier: number; installedAt: string; grade: string | null }>(`/rpg/crops/${cropId}/promote`, { tier }),
  /** 邀请选角（F2，A3 决策内核消费）：推荐角色子集 + 理由；ok:false = 回落手选。 */
  castInvitation: (invitationId: number) =>
    post<{ ok: true; source: string; picks: Array<{ roleId: number; name: string; reason: string }> } | { ok: false; reason: string; fallback: 'manual' }>(
      `/rpg/invitations/${invitationId}/cast`,
      {},
    ),
  /** 选角确认（HITL 收口）：用户手动确认后写本机 teams（peer: 形态透传）。 */
  confirmInvitation: (invitationId: number, roles: Array<{ role: string; module?: string }>) =>
    post<{ ok: true; file: string; name: string }>(`/rpg/invitations/${invitationId}/confirm`, { roles }),
  /** teams 角色来源解析（peer: 前缀查 peers 注册表得名；未知 peer 报错随行）。 */
  resolveTeamRoles: (name: string) =>
    apiFetch<{ roles: Array<{ entry: { role: string; module?: string }; parsed: unknown }> }>(
      `/rpg/teams/${encodeURIComponent(name)}/resolve`,
    ),
  // ---- 决策分级路由（G6）：信箱（级2 待批）+ 上帝裁决 ----
  /** 出征账（projectId 省略 = 全量；G6 角色可见桥的项目行徽章与折叠区）。 */
  listExpeditions: (params?: { projectId?: number }) => {
    const q = params?.projectId != null ? `?projectId=${params.projectId}` : '';
    return apiFetch<{ expeditions: RpgExpeditionView[] }>(`/rpg/expeditions${q}`);
  },
  /** 决策轨迹 + 复盘统计；projectId 省略 = 全局（信箱视角）。 */
  listRoutingDecisions: (params?: { projectId?: number; limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.projectId != null) q.set('projectId', String(params.projectId));
    if (params?.limit != null) q.set('limit', String(params.limit));
    const qs = q.size > 0 ? `?${q}` : '';
    return apiFetch<{ decisions: RpgRoutingDecisionView[]; pending: number; stats: RpgRoutingStatsView }>(
      `/rpg/routing/decisions${qs}`,
    );
  },
  /** 上帝裁决（approve = 批准；pending → approved/rejected，已决 409）。 */
  decideRoutingDecision: (id: number, approve: boolean) =>
    apiFetch<{ decision: RpgRoutingDecisionView }>(`/rpg/routing/decisions/${id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ approve }),
    }),
  // ---- goal 域（G6 批4c 任务沙盘）：立项终态闸在 server，web 只渲染 ----
  /** goal 列表（状态过滤可空 = 全量；任务沙盘全局面板的数据源）。 */
  listGoals: (params?: { roleId?: number; houseId?: number; status?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.roleId != null) q.set('roleId', String(params.roleId));
    if (params?.houseId != null) q.set('houseId', String(params.houseId));
    if (params?.status) q.set('status', params.status);
    if (params?.limit != null) q.set('limit', String(params.limit));
    const qs = q.size > 0 ? `?${q}` : '';
    return apiFetch<{ goals: RpgGoalView[] }>(`/rpg/goals${qs}`);
  },
  /** 立项（终态条件必填——不明确不立项由 server 闸，表单本地也先拦）。 */
  createGoal: (input: { roleId: number; title: string; terminal: string; projectId?: number; budgetTurns?: number }) =>
    post<{ goal: RpgGoalView }>('/rpg/goals', input),
  /** 状态落定/预算续期/目标变更（级2：用户直改 = 上帝当场批，server 落账）。 */
  patchGoal: (id: number, patch: { title?: string; terminal?: string; status?: string; statusNote?: string; budgetTurns?: number }) =>
    apiFetch<{ goal: RpgGoalView }>(`/rpg/goals/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  // ---- 进化闭环（G6 批5）：复盘 → 提案（信箱 pending）→ 级2 落档 / 回滚 ----
  /** 复盘面：决策/goal 统计 + 信号与草稿（纯读）。 */
  getRoutingReview: () =>
    apiFetch<{
      stats: object;
      goalStats: object;
      profile: { goalStallLimit?: number; goalDriveCooldownMs?: number };
      signals: Array<{ key: string; detail: string }>;
      proposal: { params: { goalStallLimit?: number; goalDriveCooldownMs?: number }; reason: string } | null;
      gated: boolean;
    }>('/rpg/routing/review'),
  /** 生成提案（频率闸内不重复；信箱 pending 行即提案卡）。 */
  runRoutingReview: () =>
    apiFetch<{ proposal: RpgRoutingDecisionView | null; reason?: string; signals?: unknown[] }>(
      '/rpg/routing/review',
      { method: 'POST', body: JSON.stringify({}) },
    ),
  /** 当前档 + 版本链（回滚即点旧版）。 */
  getRoutingProfile: () =>
    apiFetch<{
      current: RoutingProfileParams;
      resolved: { goalStallLimit: number; goalDriveCooldownMs: number };
      versions: RoutingProfileVersionView[];
    }>('/rpg/routing/profile'),
  /** 上帝直改落档（级2 当场批构型；决策行 server 落账）。 */
  applyRoutingProfile: (input: { params: { goalStallLimit?: number; goalDriveCooldownMs?: number }; note?: string }) =>
    apiFetch<{ version: RoutingProfileVersionView; current: { goalStallLimit: number } }>(
      '/rpg/routing/profile',
      { method: 'POST', body: JSON.stringify(input) },
    ),
  /** 一键回滚到旧版（append-only 换标记；server 落账）。 */
  rollbackRoutingProfile: (versionId: number) =>
    apiFetch<{ version: RoutingProfileVersionView; current: { goalStallLimit: number } }>(
      '/rpg/routing/profile/rollback',
      { method: 'POST', body: JSON.stringify({ id: versionId }) },
    ),
  // ---- 全局手法库（G6 批6）：协调者本体跨 house 记忆，文件层即事实 ----
  /** 清点（坏文件如实进 broken——零伪造）。 */
  listHandbook: () => apiFetch<{ entries: HandbookEntryView[]; broken: string[] }>('/rpg/handbook'),
  /** 落/巩固一条手法（同名重写 = 巩固）。 */
  learnHandbookEntry: (input: { name: string; description?: string; body: string; source?: 'god' | 'coordinator' | 'review' }) =>
    post<{ entry: HandbookEntryView }>('/rpg/handbook', input),
  /** 剪枝（上帝手删）。 */
  pruneHandbookEntry: (name: string) => post<{ ok: true }>('/rpg/handbook/prune', { name }),
  // ---- 任务卡详情（G6 批7，G线设计 §八三 tab）----
  /** 一次拉齐：goal 本行 + 出征行（现场）+ 决策轨迹 + 合并梯事件。 */
  getGoalDetail: (id: number) =>
    apiFetch<{ goal: RpgGoalView; expeditions: RpgExpeditionView[]; decisions: RpgRoutingDecisionView[]; ladder: RpgLadderRowView[] }>(
      `/rpg/goals/${id}/detail`,
    ),
};

/** 手法库条目行。 */
export interface HandbookEntryView {
  name: string;
  description: string;
  source: 'coordinator' | 'god' | 'review' | null;
  createdAt: string | null;
  body: string;
}

/** 合并梯事件行（任务卡·时间线 tab 的 run 历史 v1 呈现之一）。 */
export interface RpgLadderRowView {
  id: number;
  expedition: number | null;
  projectId: number;
  fromBranch: string;
  intoBranch: string;
  layer: string;
  outcome: string;
  signature: string | null;
  reason: string | null;
  at: string;
}

/** 策略参数（部分键合法——sanitize 词表闸在 server）。 */
export interface RoutingProfileParams {
  goalStallLimit?: number;
  goalDriveCooldownMs?: number;
}

/** 策略档版本行（append-only；is_current 唯一）。 */
export interface RoutingProfileVersionView {
  id: number;
  params: RoutingProfileParams;
  note: string | null;
  appliedBy: 'god' | 'proposal';
  fromDecision: number | null;
  createdAt: string;
  isCurrent: boolean;
}
