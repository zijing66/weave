import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import type { WeaveServerDeps } from '../daemon/server.js';
import { readJson, sendJson } from '../daemon/http.js';
import { readDaemonSettingsSync } from '../daemon/settings.js';
import { readAiKey } from '../daemon/ai-config.js';
import { defaultProjectOpener } from '../daemon/opener.js';
import { defaultWorktreeGitExec } from '../daemon/worktree.js';
import {
  RpgGrowthRepository,
  RpgHexagramRepository,
  RpgRoleRepository,
  RpgScoreRepository,
  HEXAGON_DIMS,
  APPEARANCE_SEED_MAX,
  ROLE_GENDERS,
  type Hexagon,
} from './roles.js';
import { RpgHouseRepository } from './houses.js';
import { MergeLadderRepository } from './merge-ladder.js';
import { RpgExpeditionRepository } from './expedition-repo.js';
import { mergeExpeditionViaLadder, startExpeditionSession } from './expedition-session.js';
import { RpgCropRepository, type CropKind } from './grade.js';
import { plantCrop, assessCropFromField, harvestCropToSkill } from './training.js';
import { promoteCrop, type PromotionTier } from './promotion.js';
import { RpgRoutingDecisionRepository, routeRpgAction } from './routing.js';
import { assertGoalTerminal, GOAL_STATUSES, RpgGoalRepository, type GoalStatus, type RpgGoalRow } from './goals.js';
import { RpgProfileRepository, type RoutingProfileParams } from './profile.js';
import { reviewSignalsOf, proposalGatedOf } from './review.js';
import { RpgHandbookRepository } from './handbook.js';
import { getRpgHandbookRoot } from '../db/paths.js';
import { provisionRole, readFactoryStamp, scaffoldCoordinator } from './provisioning.js';
import { WEAVE_VERSION } from '../version.js';
import { readPlaybookFile, renderPlaybook, type PlaybookBindings } from './playbook.js';
import { cultivate, currentHexagonOf, expedition, formTeam, transmit } from './verbs.js';
import {
  castRolesFromInvitation,
  GROWTH_VERB_CAST,
} from './invitations.js';
import { parseTeamRole } from './verbs.js';
import {
  deriveRoleProgress,
  growthBoardOf,
  RpgAchievementRepository,
  RpgXpRepository,
  type ProgressDeps,
} from './progress-store.js';

/**
 * RPG 域路由（RPG-1 适配层写侧首批）：建角色 / 角色清单 / 协调者脚手架 / 剧本
 * 解析与渲染预览。建会话仍走既有 `POST /projects/:id/new-session`（REST 动词门面，
 * 不依赖 MCP——总纲裁决）；本路由只做「游戏动词 → 既有域」的映射 + 游戏事实记录，
 * 永不自带业务裁决。
 *
 * deps 缺省即 503（RPG 整体可启停：装配不挂 = 零开销，缺省不装）。
 */

export function rpgDepsOf(deps: WeaveServerDeps): {
  roles: RpgRoleRepository;
  growth: RpgGrowthRepository;
} | null {
  if (!deps.rpgRoles) return null;
  return { roles: deps.rpgRoles, growth: deps.rpgGrowth ?? new RpgGrowthRepository(deps.rpgRoles.db) };
}

function parseHexagon(raw: unknown): Hexagon | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const out = {} as Record<string, number>;
  for (const dim of HEXAGON_DIMS) {
    const v = obj[dim];
    if (typeof v !== 'number') return undefined;
    out[dim] = v;
  }
  return out as Hexagon;
}

/** 派生面 deps（RPG-3）：库连接 + 成长仓储 + 快照仓储（缺省自建，同库连接）。 */
function progressDepsOf(deps: WeaveServerDeps): ProgressDeps {
  const roles = deps.rpgRoles!;
  return {
    db: roles.db,
    growth: deps.rpgGrowth ?? new RpgGrowthRepository(roles.db),
    achievements: deps.rpgAchievements ?? new RpgAchievementRepository(roles.db),
    xp: deps.rpgXp ?? new RpgXpRepository(roles.db),
  };
}

/**
 * /rpg/* 路由。返回 true = 本路由认领；false = 未命中，主链继续。
 * 认证沿主链的既有门（本路由不豁免）。
 */
export async function handleRpgRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/rpg/') && pathname !== '/rpg') return false;
  if (!deps.rpgRoles) {
    sendJson(res, 503, { error: 'RPG subsystem unavailable' });
    return true;
  }
  const roles = deps.rpgRoles;
  const growth = deps.rpgGrowth ?? new RpgGrowthRepository(roles.db);
  const scores = deps.rpgScores ?? new RpgScoreRepository(roles.db);
  const hexagram = deps.rpgHexagram ?? new RpgHexagramRepository(roles.db);

  // POST /rpg/roles — 建角色（项目 + 登记 + RPG 行）
  if (pathname === '/rpg/roles' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readJson(req)) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (typeof body.name !== 'string') {
      sendJson(res, 400, { error: '"name" is required' });
      return true;
    }
    if (body.gender !== undefined && body.gender !== null && !ROLE_GENDERS.includes(body.gender as never)) {
      sendJson(res, 400, { error: '"gender" must be one of: male, female' });
      return true;
    }
    if (
      body.appearanceSeed !== undefined &&
      body.appearanceSeed !== null &&
      (typeof body.appearanceSeed !== 'number' ||
        !Number.isInteger(body.appearanceSeed) ||
        body.appearanceSeed < 0 ||
        body.appearanceSeed > APPEARANCE_SEED_MAX)
    ) {
      sendJson(res, 400, { error: `"appearanceSeed" must be an integer 0..${APPEARANCE_SEED_MAX}` });
      return true;
    }
    const result = await provisionRole(
      { projects: deps.projects, roles, rolesRoot: deps.rpgRolesRoot },
      {
        name: body.name,
        archetype: typeof body.archetype === 'string' ? body.archetype : undefined,
        persona: typeof body.persona === 'string' ? body.persona : undefined,
        hexagon: parseHexagon(body.hexagon),
        gender: (body.gender ?? undefined) as 'male' | 'female' | undefined,
        appearanceSeed: (body.appearanceSeed ?? undefined) as number | undefined,
      },
    );
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    deps.dataBus?.emit({ key: 'projects' });
    sendJson(res, 201, result.role);
    return true;
  }

  // GET /rpg/roles — 角色清单（RPG 行 ∪ 项目行；观察态字段前端另从 /sessions 派生）
  if (pathname === '/rpg/roles' && req.method === 'GET') {
    sendJson(res, 200, {
      roles: roles.list().map((r) => ({
        ...r,
        project: deps.projects.getById(r.projectId) ?? null,
      })),
    });
    return true;
  }

  // POST /rpg/coordinator — 协调者项目脚手架（幂等）
  if (pathname === '/rpg/coordinator' && req.method === 'POST') {
    const result = await scaffoldCoordinator({ projects: deps.projects, roles, rolesRoot: deps.rpgRolesRoot }, deps.superagentRoot);
    deps.dataBus?.emit({ key: 'projects' });
    sendJson(res, 200, result);
    return true;
  }

  // POST /rpg/coordinator/refresh-factory — 手动更新出厂内容（项目卡按钮）：
  // force 重物化（weave 升级后的出厂文件重写 + 补一笔 git 提交）。用户点了才跑，
  // daemon 启动永不自动覆盖（2026-11-13 裁决）。
  if (pathname === '/rpg/coordinator/refresh-factory' && req.method === 'POST') {
    const result = await scaffoldCoordinator(
      { projects: deps.projects, roles, rolesRoot: deps.rpgRolesRoot },
      deps.superagentRoot,
      { force: true },
    );
    deps.dataBus?.emit({ key: 'projects' });
    sendJson(res, 200, result);
    return true;
  }

  // GET /rpg/coordinator/factory-status — 出厂内容待更新？（web「更新出厂内容」
  // 按钮的显隐数据源；stamp 读盘，无缓存）。
  if (pathname === '/rpg/coordinator/factory-status' && req.method === 'GET') {
    const root = deps.superagentRoot;
    const stamp = root ? await readFactoryStamp(root) : null;
    sendJson(res, 200, {
      factoryOutdated: stamp !== null && stamp !== WEAVE_VERSION,
      stamp,
      weaveVersion: WEAVE_VERSION,
    });
    return true;
  }

  // POST /rpg/playbooks/parse — 剧本文件解析 + 渲染预览（绑定表由调用方给；
  // 真正建编排仍走既有 POST /messaging/orchestrations——渲染产物即其请求体）。
  const parseMatch = pathname.match(/^\/rpg\/playbooks\/([^/]+)\/parse$/);
  if (parseMatch && req.method === 'POST') {
    let body: { path?: unknown; bindings?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (typeof body.path !== 'string') {
      sendJson(res, 400, { error: '"path" is required' });
      return true;
    }
    const parsed = await readPlaybookFile(body.path);
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error });
      return true;
    }
    const bindings = (body.bindings ?? {}) as PlaybookBindings;
    const rendered = renderPlaybook(parsed.playbook, bindings);
    if (!rendered.ok) {
      sendJson(res, 400, { error: rendered.error });
      return true;
    }
    sendJson(res, 200, { playbook: parsed.playbook, orchestrations: rendered.orchestrations });
    return true;
  }

  // GET /rpg/roles/:id/growth — 成长记录（行动态只读面）
  const growthMatch = pathname.match(/^\/rpg\/roles\/(\d+)\/growth$/);
  if (growthMatch && req.method === 'GET') {
    sendJson(res, 200, { growth: growth.listByRole(Number(growthMatch[1])) });
    return true;
  }

  // GET /rpg/roles/:id/progress — XP/等级/境界/成就/六维修正（RPG-3 派生面；
  // 读侧派生 + 解锁事实落 rpg_achievements / rpg_xp 快照，幂等）
  const progressMatch = pathname.match(/^\/rpg\/roles\/(\d+)\/progress$/);
  if (progressMatch && req.method === 'GET') {
    const role = roles.getById(Number(progressMatch[1]));
    if (!role) {
      sendJson(res, 404, { error: 'Role not found' });
      return true;
    }
    sendJson(res, 200, {
      progress: deriveRoleProgress(progressDepsOf(deps), role),
    });
    return true;
  }

  // GET /rpg/board — 成长榜（XP 降序；派生面同上）
  if (pathname === '/rpg/board' && req.method === 'GET') {
    sendJson(res, 200, { board: growthBoardOf(progressDepsOf(deps), roles.list()) });
    return true;
  }

  // GET /rpg/roles/:id/hexagon — 六维派生（模板基线 + Σ 修炼加成，读侧纯函数）
  const hexMatch = pathname.match(/^\/rpg\/roles\/(\d+)\/hexagon$/);
  if (hexMatch && req.method === 'GET') {
    const role = roles.getById(Number(hexMatch[1]));
    if (!role) {
      sendJson(res, 404, { error: 'Role not found' });
      return true;
    }
    const cultivated = growth.listByRole(role.id, 10_000).filter((g) => g.verb === 'cultivate').length;
    sendJson(res, 200, {
      dims: currentHexagonOf(role, cultivated),
      score: scores.get(role.id) ?? null,
    });
    return true;
  }

  // POST /rpg/roles/:id/cultivate — 修炼（skill 安装 + 游戏事实三落）
  const cultivateMatch = pathname.match(/^\/rpg\/roles\/(\d+)\/cultivate$/);
  if (cultivateMatch && req.method === 'POST') {
    let body: { skill?: unknown; sourceDir?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (typeof body.skill !== 'string' || body.skill.trim() === '') {
      sendJson(res, 400, { error: '"skill" is required' });
      return true;
    }
    if (typeof body.sourceDir !== 'string' || body.sourceDir.trim() === '') {
      sendJson(res, 400, { error: '"sourceDir" is required (skill source directory)' });
      return true;
    }
    const result = await cultivate(
      { projects: deps.projects, roles, growth, scores, hexagram },
      Number(cultivateMatch[1]),
      { skill: body.skill.trim(), sourceDir: body.sourceDir },
    );
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    deps.dataBus?.emit({ key: 'projects' });
    sendJson(res, 200, result);
    return true;
  }

  // POST /rpg/teams — 组队（协调者 teams/ 文件写）
  if (pathname === '/rpg/teams' && req.method === 'POST') {
    let body: { name?: unknown; goal?: unknown; roles?: unknown; playbook?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (typeof body.name !== 'string') {
      sendJson(res, 400, { error: '"name" is required' });
      return true;
    }
    const result = await formTeam({ rolesRoot: deps.rpgRolesRoot }, undefined, {
      name: body.name,
      goal: typeof body.goal === 'string' ? body.goal : undefined,
      roles: Array.isArray(body.roles) ? (body.roles as Array<{ role: string; module?: string }>) : [],
      playbook: typeof body.playbook === 'string' ? body.playbook : undefined,
    });
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    sendJson(res, 201, result);
    return true;
  }

  // POST /rpg/invitations/:id/cast — 邀请选角（F2，A3 决策内核消费）：跑
  // evaluate/批量形态出「推荐角色子集 + 理由」，**只是推荐**——落 provenance
  // （rpg_growth verb=cast，§七可观测），用户手动确认后才写 teams。
  const castMatch = pathname.match(/^\/rpg\/invitations\/(\d+)\/cast$/);
  if (castMatch && req.method === 'POST') {
    if (!deps.rpgCastKernel) {
      sendJson(res, 503, { error: 'Decision kernel unavailable (casting falls back to manual selection)' });
      return true;
    }
    const invRepo = deps.rpgInvitations;
    const inv = invRepo?.getById(Number(castMatch[1]));
    if (!inv) {
      sendJson(res, 404, { error: 'Invitation not found' });
      return true;
    }
    if (inv.status !== 'pending') {
      sendJson(res, 409, { error: 'Invitation is not pending' });
      return true;
    }
    // 决策模型配置每次现读（设置页改完即时生效）；未配 = null（内核 fork 回落）。
    const decision = readDaemonSettingsSync().decision;
    const apiKey = decision?.baseUrl && decision.model ? readAiKey(deps.aiKeyPath) : null;
    const aiConfig =
      decision?.baseUrl && decision.model && apiKey
        ? { baseUrl: decision.baseUrl, model: decision.model, apiKey }
        : null;
    const result = await castRolesFromInvitation(
      {
        kernel: deps.rpgCastKernel,
        roles,
        aiConfig,
      },
      { team: inv.team, goal: null, scene: inv.scene },
    );
    // provenance 账（§七）：谁邀请、AI 推荐了什么——落邀请行自己的 provenance 列
    // （rpg_growth 的 role 外键拦 roleId=0 的非角色行；失败也记，链路可观测）。
    invRepo!.setProvenance(
      inv.id,
      `peer=${inv.peerName ?? inv.peerId} ai=${result.ok ? result.source : 'fallback'} picks=${
        result.ok ? result.picks.map((p) => p.name).join(',') : 'none'
      }`,
    );
    // 选角成功且邀带有本机角色行时，同步落一条成长记录（verb=cast，角色维度可回放）。
    if (result.ok) {
      for (const pick of result.picks) {
        if (roles.getById(pick.roleId)) {
          growth.insert({ roleId: pick.roleId, verb: GROWTH_VERB_CAST, target: `invitation:${inv.id}`, detail: pick.reason });
        }
      }
    }
    if (!result.ok) {
      // 如实回落：无决策模型/解析不出 = 前端放手选全量表单，不硬造结果。
      sendJson(res, 200, { ok: false, reason: result.reason, fallback: 'manual' });
      return true;
    }
    sendJson(res, 200, result);
    return true;
  }

  // POST /rpg/invitations/:id/confirm — 选角确认（HITL 收口）：用户手动点确认后
  // 才把所选角色写进本机 teams 数据（既有 formTeam 唯一写入口；peer: 形态透传）。
  const confirmMatch = pathname.match(/^\/rpg\/invitations\/(\d+)\/confirm$/);
  if (confirmMatch && req.method === 'POST') {
    if (!deps.rpgInvitations) {
      sendJson(res, 503, { error: 'RPG invitations subsystem unavailable' });
      return true;
    }
    let body: { roles?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const picked = Array.isArray(body.roles) ? (body.roles as Array<{ role: string; module?: string }>) : [];
    if (picked.length === 0) {
      sendJson(res, 400, { error: '"roles" must be a non-empty array' });
      return true;
    }
    const inv = deps.rpgInvitations.getById(Number(confirmMatch[1]));
    if (!inv) {
      sendJson(res, 404, { error: 'Invitation not found' });
      return true;
    }
    if (inv.status !== 'pending') {
      sendJson(res, 409, { error: 'Invitation is not pending' });
      return true;
    }
    const written = await formTeam({ rolesRoot: deps.rpgRolesRoot }, undefined, {
      name: kebabOf(inv.team),
      goal: inv.message ?? undefined,
      roles: picked,
    });
    if (!written.ok) {
      sendJson(res, written.status, { error: written.error });
      return true;
    }
    deps.rpgInvitations.decide(inv.id, 'accepted', 'manual');
    deps.dataBus?.emit({ key: 'federation' });
    sendJson(res, 200, written);
    return true;
  }

  // GET /rpg/teams/:name/resolve — teams 角色来源解析（F2）：peer: 前缀查 peers
  // 注册表得名；未知 peer 报错文案随行（web 据此置灰）。
  const teamResolve = pathname.match(/^\/rpg\/teams\/([^/]+)\/resolve$/);
  if (teamResolve && req.method === 'GET') {
    const rows = deps.peers?.list() ?? [];
    const fakePeers = { list: () => rows };
    const entries = readTeamRoles(deps.rpgRolesRoot, decodeURIComponent(teamResolve[1]!));
    sendJson(res, 200, {
      roles: entries.map((e) => ({ entry: e, parsed: parseTeamRole(e.role, fakePeers) })),
    });
    return true;
  }

  // POST /rpg/roles/:id/expedition — 出征（编排触发）
  const expeditionMatch = pathname.match(/^\/rpg\/roles\/(\d+)\/expedition$/);
  if (expeditionMatch && req.method === 'POST') {
    if (!deps.orchestrationEngine || !deps.orchestrations) {
      sendJson(res, 503, { error: 'Orchestration engine unavailable' });
      return true;
    }
    let body: { orchId?: unknown; text?: unknown; entries?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (typeof body.orchId !== 'number') {
      sendJson(res, 400, { error: '"orchId" is required' });
      return true;
    }
    const result = await expedition(
      {
        orchestrations: deps.orchestrations,
        engine: deps.orchestrationEngine,
        growth,
        roles,
      },
      Number(expeditionMatch[1]),
      {
        orchId: body.orchId,
        text: typeof body.text === 'string' ? body.text : undefined,
        entries: Array.isArray(body.entries) ? (body.entries as string[]) : undefined,
      },
    );
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    sendJson(res, 200, result);
    return true;
  }

  // POST /rpg/roles/:id/message — 传音（MessageDeliverer.send 转发）
  const messageMatch = pathname.match(/^\/rpg\/roles\/(\d+)\/message$/);
  if (messageMatch && req.method === 'POST') {
    if (!deps.messageDeliverer) {
      sendJson(res, 503, { error: 'Message deliverer unavailable' });
      return true;
    }
    let body: { toSessionId?: unknown; text?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (typeof body.toSessionId !== 'string' || typeof body.text !== 'string' || body.text === '') {
      sendJson(res, 400, { error: '"toSessionId" and "text" are required' });
      return true;
    }
    const result = await transmit(
      { deliverer: deps.messageDeliverer, growth, roles },
      Number(messageMatch[1]),
      { toSessionId: body.toSessionId, text: body.text },
    );
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    sendJson(res, 200, result);
    return true;
  }

  // ---- 房子域（G2）：CRUD + 组建流（选核心 + 辅助项目 + team 入住）----
  const houses = new RpgHouseRepository(roles.db);

  // POST /rpg/houses — 建房（核心项目必填；同名核心项目已有房 = 409 幂等闸；
  // 分身随房建，人设可随请求给，缺省空——分身编辑走 PATCH）。
  if (pathname === '/rpg/houses' && req.method === 'POST') {
    let body: { name?: unknown; coreProjectId?: unknown; coordinatorPersona?: unknown; auxProjectIds?: unknown; roleIds?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (typeof body.name !== 'string' || body.name.trim() === '' || typeof body.coreProjectId !== 'number') {
      sendJson(res, 400, { error: '"name" and numeric "coreProjectId" are required' });
      return true;
    }
    if (!deps.projects.getById(body.coreProjectId)) {
      sendJson(res, 404, { error: 'Core project not found' });
      return true;
    }
    if (houses.getByCoreProjectId(body.coreProjectId)) {
      sendJson(res, 409, { error: 'This project already has a house' });
      return true;
    }
    const house = houses.create({
      name: body.name.trim(),
      coreProjectId: body.coreProjectId,
      coordinatorPersona: typeof body.coordinatorPersona === 'string' ? body.coordinatorPersona : undefined,
    });
    const auxIds = Array.isArray(body.auxProjectIds) ? (body.auxProjectIds as unknown[]) : [];
    const roleIds = Array.isArray(body.roleIds) ? (body.roleIds as unknown[]) : [];
    for (const pid of auxIds) {
      if (typeof pid === 'number' && deps.projects.getById(pid)) houses.addMember({ houseId: house.id, kind: 'aux', projectId: pid });
    }
    for (const rid of roleIds) {
      if (typeof rid === 'number' && roles.getById(rid)) houses.addMember({ houseId: house.id, kind: 'role', roleId: rid });
    }
    deps.dataBus?.emit({ key: 'projects' });
    sendJson(res, 201, houseWithMembers(houses, house.id));
    return true;
  }

  // GET /rpg/houses — 全部房（成员行随行；web 据此渲染入住房与名册）。
  if (pathname === '/rpg/houses' && req.method === 'GET') {
    sendJson(res, 200, {
      houses: houses.list().map((h) => houseWithMembers(houses, h.id)),
    });
    return true;
  }

  // GET /rpg/houses/:id — 单房详情。
  const houseGet = pathname.match(/^\/rpg\/houses\/(\d+)$/);
  if (houseGet && req.method === 'GET') {
    const house = houses.getById(Number(houseGet[1]));
    if (!house) {
      sendJson(res, 404, { error: 'House not found' });
      return true;
    }
    sendJson(res, 200, houseWithMembers(houses, house.id));
    return true;
  }

  // PATCH /rpg/houses/:id — 房名 / 分身人设（Home 统一控制台的「分身编辑」落点）。
  const housePatch = pathname.match(/^\/rpg\/houses\/(\d+)$/);
  if (housePatch && req.method === 'PATCH') {
    let body: { name?: unknown; coordinatorPersona?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const house = houses.update(Number(housePatch[1]), {
      ...(typeof body.name === 'string' && body.name.trim() !== '' ? { name: body.name.trim() } : {}),
      ...(body.coordinatorPersona !== undefined
        ? { coordinatorPersona: typeof body.coordinatorPersona === 'string' ? body.coordinatorPersona : null }
        : {}),
    });
    if (!house) {
      sendJson(res, 404, { error: 'House not found' });
      return true;
    }
    deps.dataBus?.emit({ key: 'projects' });
    sendJson(res, 200, houseWithMembers(houses, house.id));
    return true;
  }

  // DELETE /rpg/houses/:id — 拆房（成员行级联删；项目/角色本体不动）。
  const houseDelete = pathname.match(/^\/rpg\/houses\/(\d+)$/);
  if (houseDelete && req.method === 'DELETE') {
    if (!houses.delete(Number(houseDelete[1]))) {
      sendJson(res, 404, { error: 'House not found' });
      return true;
    }
    deps.dataBus?.emit({ key: 'projects' });
    sendJson(res, 200, { ok: true });
    return true;
  }

  // POST /rpg/houses/:id/members — 入住（aux=辅助项目 / role=角色或 team 名册成员）。
  const houseMemberPost = pathname.match(/^\/rpg\/houses\/(\d+)\/members$/);
  if (houseMemberPost && req.method === 'POST') {
    let body: { kind?: unknown; projectId?: unknown; roleId?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (body.kind !== 'aux' && body.kind !== 'role') {
      sendJson(res, 400, { error: '"kind" must be "aux" or "role"' });
      return true;
    }
    const house = houses.getById(Number(houseMemberPost[1]));
    if (!house) {
      sendJson(res, 404, { error: 'House not found' });
      return true;
    }
    if (body.kind === 'aux' && (typeof body.projectId !== 'number' || !deps.projects.getById(body.projectId))) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    if (body.kind === 'role' && (typeof body.roleId !== 'number' || !roles.getById(body.roleId))) {
      sendJson(res, 404, { error: 'Role not found' });
      return true;
    }
    houses.addMember({
      houseId: house.id,
      kind: body.kind,
      ...(body.kind === 'aux' ? { projectId: body.projectId as number } : {}),
      ...(body.kind === 'role' ? { roleId: body.roleId as number } : {}),
    });
    sendJson(res, 201, houseWithMembers(houses, house.id));
    return true;
  }

  // DELETE /rpg/houses/:id/members/:mid — 退住。
  const houseMemberDelete = pathname.match(/^\/rpg\/houses\/(\d+)\/members\/(\d+)$/);
  if (houseMemberDelete && req.method === 'DELETE') {
    const house = houses.getById(Number(houseMemberDelete[1]));
    if (!house) {
      sendJson(res, 404, { error: 'House not found' });
      return true;
    }
    if (!houses.removeMember(house.id, Number(houseMemberDelete[2]))) {
      sendJson(res, 404, { error: 'Member not found' });
      return true;
    }
    sendJson(res, 200, houseWithMembers(houses, house.id));
    return true;
  }

  // GET /rpg/merge-ladder?projectId= — 合并梯账只读面（合并链路卡的数据源）。
  if (pathname === '/rpg/merge-ladder' && req.method === 'GET') {
    const ladder = new MergeLadderRepository(roles.db);
    const projectId = Number(new URL(req.url ?? '/rpg/merge-ladder', 'http://x').searchParams.get('projectId') ?? 0);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      sendJson(res, 400, { error: '"projectId" query param is required' });
      return true;
    }
    sendJson(res, 200, { entries: ladder.listByProject(projectId) });
    return true;
  }

  // ---- 出征会话域（G3 段0 接钉）：新路由（旧 /expedition = 编排触发语义，不复用）----
  const expeditions = new RpgExpeditionRepository(roles.db);
  const ladder = new MergeLadderRepository(roles.db);

  // POST /rpg/roles/:id/expeditions — 出征起手（worktree 挂载 + 锚定 + kit + 起会话）。
  const expeditionPost = pathname.match(/^\/rpg\/roles\/(\d+)\/expeditions$/);
  if (expeditionPost && req.method === 'POST') {
    if (!deps.opener) {
      sendJson(res, 503, { error: 'Terminal opener unavailable' });
      return true;
    }
    let body: { projectId?: unknown; title?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (typeof body.projectId !== 'number') {
      sendJson(res, 400, { error: 'numeric "projectId" is required' });
      return true;
    }
    const result = await startExpeditionSession(
      {
        projects: deps.projects,
        roles,
        expeditions,
        growth,
        ladder,
        opener: deps.opener,
        harnesses: deps.harnesses,
        exec: deps.worktreeGitExec ?? defaultWorktreeGitExec,
        hooksDir: deps.hooksDir,
      },
      Number(expeditionPost[1]),
      { projectId: body.projectId, title: typeof body.title === 'string' ? body.title : undefined },
    );
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    sendJson(res, 201, result);
    return true;
  }

  // GET /rpg/roles/:id/expeditions — 该角色的出征账；GET /rpg/expeditions?projectId= — 项目维度。
  if (expeditionPost && req.method === 'GET') {
    sendJson(res, 200, { expeditions: expeditions.listByRole(Number(expeditionPost[1])) });
    return true;
  }
  if (pathname === '/rpg/expeditions' && req.method === 'GET') {
    // projectId 可选：省略 = 全量（G6 角色可见桥的项目行徽章一次拉齐）。
    const raw = new URL(req.url ?? '/rpg/expeditions', 'http://x').searchParams.get('projectId');
    const projectId = raw != null && raw !== '' ? Number(raw) : undefined;
    if (projectId != null && (!Number.isInteger(projectId) || projectId <= 0)) {
      sendJson(res, 400, { error: '"projectId" must be a positive integer' });
      return true;
    }
    sendJson(res, 200, {
      expeditions: projectId != null ? expeditions.listByProject(projectId) : expeditions.listAll(),
    });
    return true;
  }

  // POST /rpg/expeditions/:id/merge — 并回（合并梯，每层一行账）。
  const expeditionMerge = pathname.match(/^\/rpg\/expeditions\/(\d+)\/merge$/);
  if (expeditionMerge && req.method === 'POST') {
    const result = await mergeExpeditionViaLadder(
      {
        projects: deps.projects,
        roles,
        expeditions,
        growth,
        ladder,
        opener: deps.opener ?? defaultProjectOpener,
        exec: deps.worktreeGitExec ?? defaultWorktreeGitExec,
        hooksDir: deps.hooksDir,
      },
      Number(expeditionMerge[1]),
    );
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error, ...(result.layer ? { layer: result.layer } : {}) });
      return true;
    }
    sendJson(res, 200, result);
    return true;
  }

  // ---- 修炼域（G3，G线设计 §七）：种田/钓鱼产物账 + 品阶 + 晋升三档 ----
  const crops = new RpgCropRepository(roles.db);
  const trainingDeps = { projects: deps.projects, roles, crops, growth };

  // POST /rpg/roles/:id/crops — 下种（kind: farming | fishing）。
  const cropPost = pathname.match(/^\/rpg\/roles\/(\d+)\/crops$/);
  if (cropPost && req.method === 'POST') {
    let body: { kind?: unknown; name?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (body.kind !== 'farming' && body.kind !== 'fishing') {
      sendJson(res, 400, { error: '"kind" must be "farming" or "fishing"' });
      return true;
    }
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      sendJson(res, 400, { error: '"name" is required' });
      return true;
    }
    const result = await plantCrop(trainingDeps, Number(cropPost[1]), {
      kind: body.kind as CropKind,
      name: body.name,
    });
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    sendJson(res, 201, result);
    return true;
  }

  // GET /rpg/roles/:id/crops — 该角色的产物账。
  if (cropPost && req.method === 'GET') {
    sendJson(res, 200, { crops: crops.listByRole(Number(cropPost[1])) });
    return true;
  }

  // POST /rpg/crops/:id/assess — 收菜验收（度量落列 + 品阶即评定；钓鱼的「咬钩」
  // 交互同此收口）。度量布尔由上游真实验收给（保守：缺席 = 未达标）。
  const cropAssess = pathname.match(/^\/rpg\/crops\/(\d+)\/assess$/);
  if (cropAssess && req.method === 'POST') {
    let body: { hasArtifact?: unknown; hasTests?: unknown; lintOk?: unknown; docsOk?: unknown; note?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const result = await assessCropFromField(trainingDeps, Number(cropAssess[1]), {
      hasArtifact: body.hasArtifact === true,
      hasTests: body.hasTests === true,
      lintOk: body.lintOk === true,
      docsOk: body.docsOk === true,
      ...(typeof body.note === 'string' ? { note: body.note } : {}),
    });
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    sendJson(res, 200, { crop: result.crop });
    return true;
  }

  // POST /rpg/crops/:id/harvest — 收菜装进角色仓 `.claude/skills/`（灵品+ 闸）。
  const cropHarvest = pathname.match(/^\/rpg\/crops\/(\d+)\/harvest$/);
  if (cropHarvest && req.method === 'POST') {
    const result = await harvestCropToSkill(trainingDeps, Number(cropHarvest[1]));
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    sendJson(res, 200, result);
    return true;
  }

  // POST /rpg/crops/:id/promote — 晋升三档（tier 1..3）。级2 人工裁决：确认闸在
  // web（ConfirmDialog 呈确认后调用）；本端点不做二次确认、只做机械件与闸校验。
  const cropPromote = pathname.match(/^\/rpg\/crops\/(\d+)\/promote$/);
  if (cropPromote && req.method === 'POST') {
    let body: { tier?: unknown; targetProjectId?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (body.tier !== 1 && body.tier !== 2 && body.tier !== 3) {
      sendJson(res, 400, { error: '"tier" must be 1, 2 or 3' });
      return true;
    }
    const result = await promoteCrop(
      { projects: deps.projects, roles, crops, growth, builtinRoot: deps.rpgBuiltinRoot },
      Number(cropPromote[1]),
      body.tier as PromotionTier,
      { targetProjectId: typeof body.targetProjectId === 'number' ? body.targetProjectId : undefined },
    );
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    // 级2 裁决落账（G6 决策路由的第一份真实数据源）：晋升 = 上帝当场批
    // （ConfirmDialog 在 web 已呈过），机械失败不落（那不是裁决失败——执行的
    // 事实在 api 日志与 crop 状态里）。level/basis 查词表，不散写。
    const promotedCrop = crops.getById(Number(cropPromote[1]));
    const route = routeRpgAction('crop-promote');
    new RpgRoutingDecisionRepository(roles.db).insert({
      projectId:
        promotedCrop?.projectId ?? (promotedCrop ? roles.getById(promotedCrop.roleId)?.projectId ?? null : null),
      sessionId: null,
      action: 'crop-promote',
      level: route.level,
      basis: route.basis,
      input: JSON.stringify({ cropId: Number(cropPromote[1]), tier: body.tier }),
      result: 'approved',
      source: 'god',
      detail: `tier ${body.tier} → ${result.installedAt}`,
    });
    sendJson(res, 200, result);
    return true;
  }

  // ---- 决策分级路由（G6，G线设计 §六）：信箱面（级2 待批清单）+ 上帝裁决 ----

  // GET /rpg/routing/decisions?projectId=&limit= — 决策轨迹 + 复盘统计。projectId
  // 省略 = 全局（信箱视角）；web 警报带「级2 待批」读 pending 计数。
  if (pathname === '/rpg/routing/decisions' && req.method === 'GET') {
    const url = new URL(req.url ?? '/rpg/routing/decisions', 'http://x');
    const projectRaw = url.searchParams.get('projectId');
    const projectId = projectRaw != null && projectRaw !== '' ? Number(projectRaw) : undefined;
    if (projectId != null && (!Number.isInteger(projectId) || projectId <= 0)) {
      sendJson(res, 400, { error: '"projectId" must be a positive integer' });
      return true;
    }
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const routing = new RpgRoutingDecisionRepository(roles.db);
    sendJson(res, 200, {
      decisions: routing.list({ projectId, limit: Number.isInteger(limit) && limit > 0 ? limit : 50 }),
      pending: routing.listPending(projectId).length,
      stats: routing.stats(projectId),
    });
    return true;
  }

  // POST /rpg/routing/decisions/:id/decide — 上帝裁决（approve=true 批准）。
  // pending → approved/rejected；非 pending 409（裁决是一次性事实）。批准只落
  // 账——执行权恒在用户，动作执行归各自端点（协调者预告的批读 input 续跑）。
  const routingDecide = pathname.match(/^\/rpg\/routing\/decisions\/(\d+)\/decide$/);
  if (routingDecide && req.method === 'POST') {
    let body: { approve?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (typeof body.approve !== 'boolean') {
      sendJson(res, 400, { error: '"approve" must be a boolean' });
      return true;
    }
    const routing = new RpgRoutingDecisionRepository(roles.db);
    const row = routing.decide(Number(routingDecide[1]), body.approve);
    if (!row) {
      sendJson(res, 409, { error: 'Decision not found or already decided' });
      return true;
    }
    // 批读 input 续跑（批1 既定构型）：批准携带 routingProfile 的策略提案 →
    // 当场落档（拒绝不落——草稿作废，等下一轮复盘）。input 坏/无参数 = 裁决
    // 照旧、不落档（审批事实不受执行错误拖累，如实返回 applied:false）。
    let applied = false;
    if (body.approve && row.action === 'cross-house-write' && row.input?.includes('routingProfile') === true) {
      try {
        const params = (JSON.parse(row.input) as { routingProfile?: Partial<import('./profile.js').RoutingProfileParams> }).routingProfile;
        if (params) {
          new RpgProfileRepository(roles.db).commit({
            ...params,
            note: row.detail ?? '信箱批准落档',
            appliedBy: 'proposal',
            fromDecision: row.id,
          });
          applied = true;
        }
      } catch {
        /* input 坏：裁决已落，落档跳过（applied:false 如实报） */
      }
    }
    sendJson(res, 200, { decision: row, applied });
    return true;
  }

  // ---- goal 域（G6 批4a，G线设计 §四）：立项终态闸 + CRUD；驱动循环后续批 ----

  const goals = new RpgGoalRepository(roles.db);

  // POST /rpg/goals — 立项（终态闸：terminal 非空才立项；roleId 必填存在）。
  if (pathname === '/rpg/goals' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readJson(req)) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const roleId = body.roleId;
    if (typeof roleId !== 'number' || !Number.isInteger(roleId) || !roles.getById(roleId)) {
      sendJson(res, 400, { error: '"roleId" must reference an existing role' });
      return true;
    }
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (title === '') {
      sendJson(res, 400, { error: '"title" is required' });
      return true;
    }
    const gate = assertGoalTerminal(body.terminal);
    if (!gate.ok) {
      sendJson(res, 400, { error: gate.error });
      return true;
    }
    const optNum = (v: unknown): number | null =>
      typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
    let goal: RpgGoalRow;
    try {
      goal = goals.insert({
        roleId,
        title,
        terminal: String(body.terminal),
        houseId: typeof body.houseId === 'number' && houses.getById(body.houseId) ? body.houseId : null,
        projectId: typeof body.projectId === 'number' && deps.projects.getById(body.projectId) ? body.projectId : null,
        budgetTurns: optNum(body.budgetTurns),
        budgetTokens: optNum(body.budgetTokens),
      });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    sendJson(res, 201, { goal });
    return true;
  }

  // GET /rpg/goals?roleId=&houseId=&projectId=&status=&limit= — 过滤列举。
  if (pathname === '/rpg/goals' && req.method === 'GET') {
    const url = new URL(req.url ?? '/rpg/goals', 'http://x');
    const num = (key: string): number | undefined => {
      const raw = url.searchParams.get(key);
      const v = raw == null || raw === '' ? NaN : Number(raw);
      return Number.isInteger(v) && v > 0 ? v : undefined;
    };
    const statusRaw = url.searchParams.get('status');
    const status =
      statusRaw != null && statusRaw !== '' && (GOAL_STATUSES as readonly string[]).includes(statusRaw)
        ? (statusRaw as GoalStatus)
        : undefined;
    const limit = num('limit') ?? 200;
    sendJson(res, 200, { goals: goals.list({ roleId: num('roleId'), houseId: num('houseId'), projectId: num('projectId'), status }, limit) });
    return true;
  }

  // GET /rpg/goals/:id/detail — 任务卡详情（G6 批7 三 tab）一次拉齐：goal 本行 +
  // 角色出征行（现场）+ 决策轨迹（input.goalId 命中的行）+ 合并梯事件（该角色
  // 出征）。生长 tab 的 crops/成长走既有端点（/listCrops、/progress），不复制。
  // 「run 历史」v1 = 决策轨迹 + 合并梯代呈现（goal 直投回合不逐拍记账，逐拍账
  // 留改进项——turnsUsed 汇总已在 goal 行上）。
  const goalDetail = pathname.match(/^\/rpg\/goals\/(\d+)\/detail$/);
  if (goalDetail && req.method === 'GET') {
    const goal = goals.getById(Number(goalDetail[1]));
    if (!goal) {
      sendJson(res, 404, { error: 'Goal not found' });
      return true;
    }
    const expeditionRepo = new RpgExpeditionRepository(roles.db);
    const expeditions = expeditionRepo.listByRole(goal.roleId);
    const routing = new RpgRoutingDecisionRepository(roles.db);
    const decisions = routing
      .list({ limit: 500 })
      .filter((row) => {
        if (row.input == null) return false;
        try {
          return JSON.parse(row.input)?.goalId === goal.id;
        } catch {
          return false;
        }
      });
    const ladderRepo = new MergeLadderRepository(roles.db);
    const expIds = new Set(expeditions.map((e) => e.id));
    const ladder = (goal.projectId != null ? ladderRepo.listByProject(goal.projectId, 200) : [])
      .filter((row) => row.expedition != null && expIds.has(row.expedition));
    sendJson(res, 200, { goal, expeditions, decisions, ladder });
    return true;
  }

  // PATCH /rpg/goals/:id — 目标变更 / 预算续期 / 状态落定。三者都是级2 动作：
  // 用户经 web 表单/确认对话框直改 = 上帝当场批（落账构型同 promote）；协调者
  // 预告路径（pending 信箱）待驱动循环批接上再审变动。
  const goalPatch = pathname.match(/^\/rpg\/goals\/(\d+)$/);
  if (goalPatch && req.method === 'PATCH') {
    let body: Record<string, unknown>;
    try {
      body = (await readJson(req)) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const id = Number(goalPatch[1]);
    const goal = goals.getById(id);
    if (!goal) {
      sendJson(res, 404, { error: 'Goal not found' });
      return true;
    }
    if (body.terminal !== undefined) {
      const gate = assertGoalTerminal(body.terminal);
      if (!gate.ok) {
        sendJson(res, 400, { error: gate.error });
        return true;
      }
    }
    const statusRaw = body.status;
    if (statusRaw !== undefined && !(GOAL_STATUSES as readonly string[]).includes(String(statusRaw))) {
      sendJson(res, 400, { error: `"status" must be one of ${GOAL_STATUSES.join(' | ')}` });
      return true;
    }
    const optNum = (v: unknown): number | null | undefined =>
      v === null ? null : typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
    let updated: RpgGoalRow | undefined;
    try {
      updated = goals.patch(id, {
        title: typeof body.title === 'string' ? body.title : undefined,
        terminal: typeof body.terminal === 'string' ? body.terminal : undefined,
        budgetTurns: optNum(body.budgetTurns),
        budgetTokens: optNum(body.budgetTokens),
      });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    if (statusRaw !== undefined && String(statusRaw) !== goal.status) {
      updated = goals.updateStatus(id, statusRaw as GoalStatus, typeof body.statusNote === 'string' ? body.statusNote : undefined);
    }
    // 级2 落账：只调预算 = budget-renew（预算续期）；其余改动 = goal-change
    // （目标变更/撤销/续预算按词表口径）。level/basis 查词表不散写。
    const onlyBudget =
      body.title === undefined && body.terminal === undefined && statusRaw === undefined &&
      (body.budgetTurns !== undefined || body.budgetTokens !== undefined) &&
      updated != null;
    const action = onlyBudget ? 'budget-renew' : 'goal-change';
    const route = routeRpgAction(action);
    new RpgRoutingDecisionRepository(roles.db).insert({
      projectId: updated?.projectId ?? roles.getById(goal.roleId)?.projectId ?? null,
      sessionId: null,
      action,
      level: route.level,
      basis: route.basis,
      input: JSON.stringify({ goalId: id, ...body }),
      result: 'approved',
      source: 'god',
      detail: `goal ${id} "${updated?.title ?? goal.title}" → ${updated?.status ?? goal.status}`,
    });
    sendJson(res, 200, { goal: updated });
    return true;
  }

  // ---- 进化闭环（G6，G线设计 §六「决策进化闭环」）：复盘 → 提案 → 级2 落档 ----

  const profiles = new RpgProfileRepository(roles.db);

  // GET /rpg/routing/review — 复盘面：决策轨迹统计 + goal 收益统计 + 信号与草稿
  // （纯读侧，不落账不拦不劝——信箱批准是另一回事）。
  if (pathname === '/rpg/routing/review' && req.method === 'GET') {
    const routing = new RpgRoutingDecisionRepository(roles.db);
    const decisions = routing.list({ limit: 500 });
    const goalRows = goals.list({}, 500);
    const current = profiles.resolved();
    const review = reviewSignalsOf({ decisions, goals: goalRows, current });
    sendJson(res, 200, {
      stats: routing.stats(),
      goalStats: {
        total: goalRows.length,
        active: goalRows.filter((g) => g.status === 'active').length,
        achieved: goalRows.filter((g) => g.status === 'achieved').length,
        abandoned: goalRows.filter((g) => g.status === 'abandoned').length,
        paused: goalRows.filter((g) => g.status === 'paused').length,
        budgetOut: goalRows.filter((g) => g.status === 'budget_out').length,
      },
      profile: current,
      signals: review.signals,
      proposal: review.proposal,
      gated: proposalGatedOf({ decisions: routing.list({ limit: 500 }) }),
    });
    return true;
  }

  // POST /rpg/routing/review — 生成提案（进化闭环第二拍）：信号命中且过频率闸 →
  // pending cross-house-write（input 内嵌 routingProfile 草稿）呈信箱；否则如实
  // 回 null（无信号不硬凑提案）。
  if (pathname === '/rpg/routing/review' && req.method === 'POST') {
    const routing = new RpgRoutingDecisionRepository(roles.db);
    const decisions = routing.list({ limit: 500 });
    if (proposalGatedOf({ decisions })) {
      sendJson(res, 200, { proposal: null, reason: 'gated: 已有在堂/24h 内已决的策略提案（进化频率闸）' });
      return true;
    }
    const current = profiles.resolved();
    const review = reviewSignalsOf({ decisions, goals: goals.list({}, 500), current });
    if (!review.proposal) {
      sendJson(res, 200, { proposal: null, reason: review.signals.length > 0 ? 'signals-only（无可调参信号，如实报告）' : 'no-signals' });
      return true;
    }
    const route = routeRpgAction('cross-house-write');
    const row = routing.insert({
      projectId: null,
      sessionId: null,
      action: 'cross-house-write',
      level: route.level,
      basis: route.basis,
      input: JSON.stringify({ routingProfile: review.proposal.params }),
      result: 'pending',
      source: null, // 机制启发式草稿（零智能级0 生成、级2 呈批）——不是 AI 裁决
      detail: review.proposal.reason,
    });
    sendJson(res, 200, { proposal: row, signals: review.signals });
    return true;
  }

  // GET /rpg/routing/profile — 当前档 + 版本链（读面）。
  if (pathname === '/rpg/routing/profile' && req.method === 'GET') {
    sendJson(res, 200, { current: profiles.current(), resolved: profiles.resolved(), versions: profiles.listVersions() });
    return true;
  }

  // POST /rpg/routing/profile — 落档（级2 呈批后的应用步）：两条入口——
  // ① {decisionId}：信箱批准那条提案裁决（批读 input 续跑：input 内嵌的
  //    routingProfile 落档）；② {params,note}：上帝直改（构型同 goal PATCH——
  //    批准只落账、执行走本端点）。都 append-only 一版，红线三进 note。
  if (pathname === '/rpg/routing/profile' && req.method === 'POST') {
    let body: { decisionId?: unknown; params?: unknown; note?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const routing = new RpgRoutingDecisionRepository(roles.db);
    if (typeof body.decisionId === 'number') {
      const row = routing.get(body.decisionId);
      if (!row || row.action !== 'cross-house-write' || row.result !== 'pending') {
        sendJson(res, 409, { error: 'Decision not found, already decided, or not a profile proposal' });
        return true;
      }
      let params: RoutingProfileParams | null = null;
      try {
        params = (JSON.parse(row.input ?? '{}') as { routingProfile?: RoutingProfileParams }).routingProfile ?? null;
      } catch {
        params = null;
      }
      if (!params) {
        sendJson(res, 400, { error: 'Proposal input has no routingProfile' });
        return true;
      }
      const decided = routing.decide(row.id, true);
      if (!decided) {
        sendJson(res, 409, { error: 'Decision not pending' });
        return true;
      }
      const version = profiles.commit({ ...params, note: row.detail ?? '提案落地', appliedBy: 'proposal', fromDecision: row.id });
      sendJson(res, 200, { decision: decided, version, current: profiles.resolved() });
      return true;
    }
    if (typeof body.params !== 'object' || body.params === null) {
      sendJson(res, 400, { error: '"params" (or "decisionId") required' });
      return true;
    }
    const route = routeRpgAction('cross-house-write');
    const decided = routing.insert({
      projectId: null,
      sessionId: null,
      action: 'cross-house-write',
      level: route.level,
      basis: route.basis,
      input: JSON.stringify({ routingProfile: body.params }),
      result: 'approved',
      source: 'god',
      detail: typeof body.note === 'string' ? body.note : null,
    });
    const version = profiles.commit({
      ...(body.params as Partial<RoutingProfileParams>),
      note: typeof body.note === 'string' ? body.note : undefined,
      appliedBy: 'god',
    });
    sendJson(res, 200, { decision: decided, version, current: profiles.resolved() });
    return true;
  }

  // POST /rpg/routing/profile/rollback — 一键回滚（级2：用户在 web 确认 = 上帝
  // 当场批；append-only 换标记，历史版本留档）。
  const profileRollback = pathname.match(/^\/rpg\/routing\/profile\/rollback$/);
  if (profileRollback && req.method === 'POST') {
    let body: { id?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (typeof body.id !== 'number') {
      sendJson(res, 400, { error: '"id" must be a version id' });
      return true;
    }
    const version = profiles.rollbackTo(body.id);
    if (!version) {
      sendJson(res, 404, { error: 'Version not found' });
      return true;
    }
    const route = routeRpgAction('cross-house-write');
    new RpgRoutingDecisionRepository(roles.db).insert({
      projectId: null,
      sessionId: null,
      action: 'cross-house-write',
      level: route.level,
      basis: route.basis,
      input: JSON.stringify({ routingProfile: version.params, rollbackTo: version.id }),
      result: 'approved',
      source: 'god',
      detail: `回滚到版本 #${version.id}`,
    });
    sendJson(res, 200, { version, current: profiles.resolved() });
    return true;
  }

  // ---- 手法库（G6 批6）：协调者本体跨 house 记忆，文件层即事实 ----

  const handbook = new RpgHandbookRepository(deps.rpgHandbookRoot ?? getRpgHandbookRoot());

  // GET /rpg/handbook — 清点（分身直读目录也行；这是 web 观察面 + 端点外壳）。
  if (pathname === '/rpg/handbook' && req.method === 'GET') {
    sendJson(res, 200, await handbook.list());
    return true;
  }

  // POST /rpg/handbook — 落/巩固一条手法（分身或上帝；同名重写 = 巩固）。
  if (pathname === '/rpg/handbook' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readJson(req)) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const learned = await handbook.learn(body);
    if (!learned.ok) {
      sendJson(res, 400, { error: learned.error });
      return true;
    }
    sendJson(res, 200, { entry: learned.entry });
    return true;
  }

  // POST /rpg/handbook/prune — 剪枝（上帝手删；复盘闭环的翻案率淘汰走提案通道，另行）。
  if (pathname === '/rpg/handbook/prune' && req.method === 'POST') {
    let body: { name?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (typeof body.name !== 'string') {
      sendJson(res, 400, { error: '"name" is required' });
      return true;
    }
    const ok = await handbook.prune(body.name);
    if (!ok) {
      sendJson(res, 404, { error: 'Entry not found' });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  // 非 API 的 /rpg/<scene> 深链（前端 SPA 路由）放行给静态托管 fallback——
  // API 404 只对未知 /rpg/* 接口生效。
  if (!pathname.startsWith('/rpg/api-') && !pathname.startsWith('/rpg/roles') && !pathname.startsWith('/rpg/houses') && !pathname.startsWith('/rpg/merge-ladder') && !pathname.startsWith('/rpg/coordinator') && !pathname.startsWith('/rpg/board') && !pathname.startsWith('/rpg/playbook') && !pathname.startsWith('/rpg/expedition') && !pathname.startsWith('/rpg/expeditions') && !pathname.startsWith('/rpg/crops') && !pathname.startsWith('/rpg/kit') && !pathname.startsWith('/rpg/progress') && !pathname.startsWith('/rpg/routing') && !pathname.startsWith('/rpg/goals') && !pathname.startsWith('/rpg/handbook')) {
    return false;
  }
  sendJson(res, 404, { error: 'Not found' });
  return true;
}

/** 房详情 = 房行 + 成员行（team 名册 live 展开的数据面：成员行随库现读，不拍快照）。 */
function houseWithMembers(houses: RpgHouseRepository, houseId: number) {
  const house = houses.getById(houseId)!;
  return { ...house, members: houses.listMembers(houseId) };
}

/** 团队名 → kebab-case 文件名（formTeam 的词法闸复用口径；非法字符压 '-'）。 */
function kebabOf(team: string): string {
  return (
    team
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'team'
  );
}

/** 读协调者 teams/<name>.yaml 的 roles 条目（文件即事实；读不到 = 空数组）。 */
function readTeamRoles(rolesRoot: string | undefined, name: string): Array<{ role: string; module?: string }> {
  if (!rolesRoot) return [];
  try {
    const file = path.join(rolesRoot, '..', 'coordinator', 'teams', `${name}.yaml`);
    const doc = yaml.load(readFileSync(file, 'utf-8')) as { roles?: unknown } | null;
    if (!Array.isArray(doc?.roles)) return [];
    return (doc!.roles as Array<{ role?: unknown; module?: unknown }>)
      .filter((r) => r != null && typeof r.role === 'string')
      .map((r) => ({ role: r.role as string, ...(typeof r.module === 'string' ? { module: r.module } : {}) }));
  } catch {
    return [];
  }
}
