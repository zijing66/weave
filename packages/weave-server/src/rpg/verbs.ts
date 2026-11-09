import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectRepository } from '../repositories/projects.js';
import type { OrchestrationRepository } from '../repositories/orchestrations.js';
import type { OrchestrationEngine } from '../hooks/orchestration-engine.js';
import type { MessageDeliverer } from '../hooks/message-deliverer.js';
import { installSkill } from '../install/installer.js';
import {
  RpgGrowthRepository,
  RpgHexagramRepository,
  RpgRoleRepository,
  RpgScoreRepository,
  archetypeBaseline,
  hexagonWithSkills,
  skillScoreOf,
  type Hexagon,
} from './roles.js';

/**
 * 动词门面首批（RPG 稿 §5.2 / D1）：修炼 / 组队 / 出征 / 传音。适配层写侧——
 * 映射 + 组合 + 游戏事实记录（rpg_growth / rpg_scores / rpg_hexagram），底层恒
 * 既有 API（installSkill / 编排引擎 / MessageDeliverer / 协调者 teams 文件），
 * 永不自带业务裁决。传音/出征是纯转发，游戏事实只在成功后落一行。
 */

/** 六维派生：模板基线 + Σ 修炼加成（每次成功修炼主维 +1，封顶 SKILL_BONUS_CAP）。 */
export function currentHexagonOf(
  role: { archetype: string | null; hexagon: Hexagon | null },
  cultivatedCount: number,
): Hexagon {
  return hexagonWithSkills(role.hexagon ?? archetypeBaseline(role.archetype), cultivatedCount);
}

export interface CultivateDeps {
  projects: ProjectRepository;
  roles: RpgRoleRepository;
  growth: RpgGrowthRepository;
  scores: RpgScoreRepository;
  hexagram: RpgHexagramRepository;
}

export type CultivateResult =
  | { ok: true; skill: string; projectPath: string; score: number; hexagon: Hexagon }
  | { ok: false; status: number; error: string };

/**
 * 修炼 = 给角色装一门 skill（既有 installSkill 唯一写入口）+ 落三样游戏事实：
 * rpg_growth 一行、rpg_scores 技巧分（首修落基线派生分，之后 +2/门）、
 * rpg_hexagram 六维快照。装不进（冲突/越界）= 修炼失败，零游戏事实。
 */
export async function cultivate(
  deps: CultivateDeps,
  roleId: number,
  input: { skill: string; sourceDir?: string },
): Promise<CultivateResult> {
  const role = deps.roles.getById(roleId);
  if (!role) return { ok: false, status: 404, error: 'Role not found' };
  const project = deps.projects.getById(role.projectId);
  if (!project) return { ok: false, status: 404, error: 'Role project not found' };

  try {
    await installSkill(project.path, input.sourceDir!, input.skill);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Skill install failed';
    const status = err instanceof Error && err.name === 'InstallConflictError' ? 409 : 400;
    return { ok: false, status, error: message };
  }

  deps.growth.insert({ roleId, verb: 'cultivate', target: input.skill });

  const prior = deps.scores.get(roleId);
  const score = prior ? Math.min(100, prior.score + 2) : skillScoreOf(role.archetype).score;
  const updated = deps.scores.upsert({
    roleId,
    score,
    basis: prior
      ? `修炼「${input.skill}」+2（累计 ${countCultivation(deps.growth, roleId)} 门）`
      : skillScoreOf(role.archetype).basis,
  });

  const cultivated = countCultivation(deps.growth, roleId);
  const hexagon = currentHexagonOf(role, cultivated);
  deps.hexagram.insert({ roleId, dims: hexagon, reason: `修炼「${input.skill}」` });

  return { ok: true, skill: input.skill, projectPath: project.path, score: updated.score, hexagon };
}

function countCultivation(growth: RpgGrowthRepository, roleId: number): number {
  return growth.listByRole(roleId, 10_000).filter((g) => g.verb === 'cultivate').length;
}

// ---- 组队（协调者 teams/ 文件写）----

export interface TeamDeps {
  rolesRoot?: string;
  growth?: RpgGrowthRepository;
  roles?: RpgRoleRepository;
}

export type TeamResult =
  | { ok: true; file: string; name: string }
  | { ok: false; status: number; error: string };

const TEAM_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * 组队 = 协调者仓库 `teams/<name>.yaml` 落一份声明文件（角色名单 + 目标 +
 * 可选剧本引用）。文件即事实——没有 teams 表写、没有编排创建（出征时才解析
 * playbook 建编排）。同一队名重写 = 改组（幂等覆盖）。
 */
export async function formTeam(
  deps: TeamDeps,
  root: string | undefined,
  input: { name: string; goal?: string; roles: Array<{ role: string; module?: string }>; playbook?: string },
): Promise<TeamResult> {
  const name = input.name.trim();
  if (!TEAM_NAME_RE.test(name)) {
    return { ok: false, status: 400, error: 'Team name must be kebab-case (a-z 0-9 -)' };
  }
  if (!Array.isArray(input.roles) || input.roles.length === 0) {
    return { ok: false, status: 400, error: '"roles" must be a non-empty array' };
  }
  for (const r of input.roles) {
    if (typeof r?.role !== 'string' || r.role.trim() === '') {
      return { ok: false, status: 400, error: 'each role entry needs a "role" name' };
    }
  }
  const base = root ?? deps.rolesRoot;
  if (!base) return { ok: false, status: 503, error: 'RPG roles root unavailable' };
  const dir = path.join(base, '..', 'coordinator', 'teams');
  const file = path.join(dir, `${name}.yaml`);

  const lines: string[] = [`name: ${name}`];
  if (input.goal) lines.push(`goal: ${JSON.stringify(input.goal)}`);
  if (input.playbook) lines.push(`playbook: ${input.playbook}`);
  lines.push('roles:');
  for (const r of input.roles) {
    lines.push(r.module ? `  - role: ${r.role}\n    module: ${r.module}` : `  - role: ${r.role}`);
  }
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, lines.join('\n') + '\n', 'utf8');
  } catch (err) {
    return { ok: false, status: 500, error: err instanceof Error ? err.message : 'team write failed' };
  }
  return { ok: true, file, name };
}

// ---- 出征（编排触发）----

export interface ExpeditionDeps {
  orchestrations: Pick<OrchestrationRepository, 'getById'>;
  engine: Pick<OrchestrationEngine, 'start'>;
  growth: RpgGrowthRepository;
  roles: RpgRoleRepository;
}

export type ExpeditionResult =
  | { ok: true; runId: number; orchName: string }
  | { ok: false; status: number; error: string };

/** 出征 = 触发一次编排运行（既有引擎唯一入口）；成功落一行成长记录。 */
export async function expedition(
  deps: ExpeditionDeps,
  roleId: number,
  input: { orchId: number; text?: string; entries?: readonly string[] },
): Promise<ExpeditionResult> {
  const role = deps.roles.getById(roleId);
  if (!role) return { ok: false, status: 404, error: 'Role not found' };
  const orch = deps.orchestrations.getById(input.orchId);
  if (!orch) return { ok: false, status: 404, error: 'Orchestration not found' };
  const started = await deps.engine.start(input.orchId, 'manual', input.text, input.entries);
  if (!started.ok) return { ok: false, status: started.status, error: started.error };
  deps.growth.insert({
    roleId,
    verb: 'expedition',
    target: orch.name,
    detail: `run ${started.runId}`,
  });
  return { ok: true, runId: started.runId, orchName: orch.name };
}

// ---- 传音（MessageDeliverer.send 转发）----

export interface MessageVerbDeps {
  deliverer: Pick<MessageDeliverer, 'send'>;
  growth: RpgGrowthRepository;
  roles: RpgRoleRepository;
}

export type MessageVerbResult =
  | { ok: true; messageId: string; status: string; toSessionId: string }
  | { ok: false; status: number; error: string };

/** 传音 = 给目标会话送一条消息（既有投递管道唯一裁决）；成功落一行成长记录。 */
export async function transmit(
  deps: MessageVerbDeps,
  roleId: number,
  input: { toSessionId: string; text: string },
): Promise<MessageVerbResult> {
  const role = deps.roles.getById(roleId);
  if (!role) return { ok: false, status: 404, error: 'Role not found' };
  const sent = await deps.deliverer.send({
    toSessionId: input.toSessionId,
    text: input.text,
    mode: 'auto',
    fromKind: 'dashboard',
  });
  if (!sent.ok) return { ok: false, status: sent.status, error: sent.error };
  deps.growth.insert({
    roleId,
    verb: 'transmit',
    target: input.toSessionId,
    detail: input.text.slice(0, 120),
  });
  return { ok: true, messageId: sent.messageId, status: sent.status, toSessionId: input.toSessionId };
}
