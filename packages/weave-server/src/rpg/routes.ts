import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import type { WeaveServerDeps } from '../daemon/server.js';
import { readJson, sendJson } from '../daemon/http.js';
import { readDaemonSettingsSync } from '../daemon/settings.js';
import { readAiKey } from '../daemon/ai-config.js';
import {
  RpgGrowthRepository,
  RpgHexagramRepository,
  RpgRoleRepository,
  RpgScoreRepository,
  HEXAGON_DIMS,
  type Hexagon,
} from './roles.js';
import { provisionRole, scaffoldCoordinator } from './provisioning.js';
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
    const result = await provisionRole(
      { projects: deps.projects, roles, rolesRoot: deps.rpgRolesRoot },
      {
        name: body.name,
        archetype: typeof body.archetype === 'string' ? body.archetype : undefined,
        persona: typeof body.persona === 'string' ? body.persona : undefined,
        hexagon: parseHexagon(body.hexagon),
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
    const result = await scaffoldCoordinator({ projects: deps.projects, roles, rolesRoot: deps.rpgRolesRoot });
    deps.dataBus?.emit({ key: 'projects' });
    sendJson(res, 200, result);
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

  sendJson(res, 404, { error: 'Not found' });
  return true;
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
