import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import type { HarnessRegistry } from '@weavecode/harness';
import type { ProjectRepository } from '../repositories/projects.js';
import { projectHarnesses } from '../daemon/project-harnesses.js';
import { readDaemonSettingsSync } from '../daemon/settings.js';
import type { ProjectOpener } from '../daemon/opener.js';
import {
  PENDING_WT_PREFIX,
  createSessionWorktree,
  upsertWorktreeEntry,
  type WorktreeGitExec,
} from '../daemon/worktree.js';
import { RpgGrowthRepository, type RpgRoleRepository } from './roles.js';
import { RpgExpeditionRepository, type RpgExpeditionRow } from './expedition-repo.js';
import { MergeLadderRepository, runMergeLadder } from './merge-ladder.js';
import { anchorBranchOf } from './expedition.js';
import { installKit } from './kit.js';

/**
 * 出征会话编排（G3 段0 接钉，G线设计 §三）：把 B5 的会话 worktree 管线、起手
 * 锚定快照（anchorBranchOf）与 kit 安装（installKit，tracked 查重硬前置）接成
 * 一条「出征起手」——落正经新路由（POST /rpg/roles/:id/expeditions），不复用旧
 * 语义端点（/rpg/roles/:id/expedition = 编排触发）。并回走合并梯
 * （runMergeLadder），每层一行 rpg_merge_ladder 账（expedition 外键随行）。
 */

export interface ExpeditionSessionDeps {
  projects: ProjectRepository;
  roles: RpgRoleRepository;
  expeditions: RpgExpeditionRepository;
  growth: RpgGrowthRepository;
  ladder: MergeLadderRepository;
  opener: ProjectOpener;
  /** harness 驱动注册表（resume 槽取裸 bin）；缺省 = 起不了会话（409 如实报）。 */
  harnesses?: HarnessRegistry;
  exec: WorktreeGitExec;
  /** worktree 登记根（hooksDir）；缺省不登记 = 并回扫描看不到这次出征。 */
  hooksDir?: string;
}

export type StartExpeditionResult =
  | {
      ok: true;
      expedition: RpgExpeditionRow;
      worktreePath: string;
      branch: string;
      anchorBranch: string;
      /** kit 实际装上的 skill 目录名（角色无 skill = 空数组，不算失败）。 */
      kitSkills: string[];
    }
  | { ok: false; status: number; error: string; unsupported?: boolean };

/** tracked 查重（硬前置）：`git ls-files` 看这些相对路径是否已被跟踪。 */
function trackedPathsOf(exec: WorktreeGitExec) {
  return (worktreePath: string, relPaths: string[]): Promise<string[]> => {
    if (relPaths.length === 0) return Promise.resolve([]);
    const res = exec('git', ['ls-files', '--', ...relPaths], { cwd: worktreePath });
    return res.then((r) => {
      if (r.code !== 0) return [];
      const tracked = new Set(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
      return relPaths.filter((p) => tracked.has(p) || tracked.has(`${p}/`));
    });
  };
}

/** 角色仓库里真实存在的 skill 源目录（role.json 声明 ∩ 盘上有目录）。 */
function roleSkillSources(roleProjectPath: string): Record<string, string> {
  const sources: Record<string, string> = {};
  let manifest: { skills?: unknown } = {};
  try {
    manifest = JSON.parse(readFileSync(path.join(roleProjectPath, '.weave', 'role.json'), 'utf8'));
  } catch {
    manifest = {};
  }
  const names = Array.isArray(manifest.skills)
    ? (manifest.skills as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  for (const name of names) {
    const dir = path.join(roleProjectPath, '.claude', 'skills', name);
    try {
      if (statSync(dir).isDirectory()) sources[name] = dir;
    } catch {
      /* 声明了但没物化 = 跳过（不挡出征） */
    }
  }
  return sources;
}

/**
 * 出征起手：锚定 → 建 worktree（pending 占位键）→ 装 kit → 落出征行（session_key
 * = 占位键，首个会话事件认领后改写）→ 起 harness 会话（cwd = worktree）。
 */
export async function startExpeditionSession(
  deps: ExpeditionSessionDeps,
  roleId: number,
  input: { projectId: number; title?: string },
): Promise<StartExpeditionResult> {
  const role = deps.roles.getById(roleId);
  if (!role) return { ok: false, status: 404, error: 'Role not found' };
  const roleProject = deps.projects.getById(role.projectId);
  if (!roleProject) return { ok: false, status: 404, error: 'Role project not found' };
  const project = deps.projects.getById(input.projectId);
  if (!project) return { ok: false, status: 404, error: 'Target project not found' };

  // 会话起在哪个 harness：目标项目的 init 选择结果里挑一个能起的（与 new-session
  // 同一判据 canStartSession）；起不了 = 409 如实报因（不替用户跨配置起会话）。
  const integrated = await projectHarnesses(project.path, deps.harnesses);
  const picked = integrated.find((h) => h.canStartSession);
  const spec = picked ? deps.harnesses?.get(picked.id)?.resume : undefined;
  if (!spec?.bin) {
    return { ok: false, status: 409, error: `No startable harness integrated in project "${project.name}"` };
  }

  const anchor = await anchorBranchOf(project.path, deps.exec);
  if (!anchor.ok) return { ok: false, status: 400, error: anchor.error ?? 'cannot anchor current branch' };

  // sessionId 此刻未知（宿主自己生成）：先占位键建 worktree 与登记，首个会话事件
  // 认领改绑（sweepWorktreeMerges 的 pending 认领 + 出征行 rebind 同一拍）。
  const key = PENDING_WT_PREFIX + crypto.randomUUID();
  const created = await createSessionWorktree(project.path, key, deps.exec);
  if (!created.ok) {
    return {
      ok: false,
      status: created.unsupported ? 409 : 400,
      error: created.error ?? 'worktree unavailable',
      ...(created.unsupported ? { unsupported: true } : {}),
    };
  }

  // kit（人格/技能层）：角色声明的 skill 装进 worktree（tracked 查重硬前置——
  // 撞用户的 tracked 文件 = 整个出征拒绝，不静默覆盖）。角色无 skill = 空装。
  let kitSkills: string[] = [];
  const skills = roleSkillSources(roleProject.path);
  if (Object.keys(skills).length > 0) {
    const kit = await installKit({
      worktreePath: created.path!,
      role: role.name,
      instanceId: key,
      skills,
      trackedCheck: trackedPathsOf(deps.exec),
    });
    if (!kit.ok) {
      return { ok: false, status: 409, error: kit.conflicts?.length ? `${kit.error}: ${kit.conflicts.join(', ')}` : kit.error };
    }
    kitSkills = kit.installed;
  }

  if (deps.hooksDir) {
    upsertWorktreeEntry(deps.hooksDir, {
      sessionId: key,
      projectId: project.id,
      path: created.path!,
      branch: created.branch!,
      status: 'active',
      at: new Date().toISOString(),
    });
  }

  const title = input.title?.trim() || `[weave] 出征·${role.name}·${project.name}`;
  const row = deps.expeditions.insert({
    roleId: role.id,
    projectId: project.id,
    sessionKey: key,
    branch: created.branch!,
    anchorBranch: anchor.branch!,
    anchorSha: anchor.sha!,
    title,
  });
  deps.growth.insert({
    roleId: role.id,
    verb: 'expedition',
    target: project.name,
    detail: `expedition ${row.id} branch ${created.branch} anchor ${anchor.branch}@${anchor.sha!.slice(0, 8)}`,
  });

  const argv = [spec.bin, ...(spec.launchArgs ?? [])];
  await deps.opener.runInTerminal(created.path!, argv, readDaemonSettingsSync().terminal);

  return {
    ok: true,
    expedition: row,
    worktreePath: created.path!,
    branch: created.branch!,
    anchorBranch: anchor.branch!,
    kitSkills,
  };
}

export type MergeExpeditionResult =
  | { ok: true; merged: true; layer: string; into: string }
  | { ok: false; status: number; error: string; layer?: string };

/**
 * 并回（合并梯）：验锚分支还活着（悬空 = 落 dangling、不改写历史）→ 临时
 * worktree 里跑 runMergeLadder（每层一行账，expedition 外键随行）→ 成功后快照
 * ref 归位（update-ref，同 mergeIntoAnchoredBranch 的 detach 形态口径）。
 */
export async function mergeExpeditionViaLadder(
  deps: ExpeditionSessionDeps,
  expeditionId: number,
  aiRepair?: Parameters<typeof runMergeLadder>[0]['aiRepair'],
): Promise<MergeExpeditionResult> {
  const exp = deps.expeditions.getById(expeditionId);
  if (!exp) return { ok: false, status: 404, error: 'Expedition not found' };
  if (exp.status !== 'active' && exp.status !== 'conflict') {
    return { ok: false, status: 409, error: `Expedition is ${exp.status}, not mergeable` };
  }
  const project = deps.projects.getById(exp.projectId);
  if (!project) return { ok: false, status: 404, error: 'Target project not found' };

  const verify = await deps.exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${exp.anchorBranch}`], {
    cwd: project.path,
  });
  if (verify.code !== 0) {
    deps.expeditions.updateStatus(exp.id, 'dangling', `anchored branch ${exp.anchorBranch} no longer exists`);
    return { ok: false, status: 409, error: `anchored branch ${exp.anchorBranch} no longer exists (dangling)` };
  }

  // 幂等：出征分支已是锚分支祖先 = 已并过（登记丢了也免重并）。
  const ancestor = await deps.exec('git', ['merge-base', '--is-ancestor', exp.branch, exp.anchorBranch], {
    cwd: project.path,
  });
  if (ancestor.code === 0) {
    deps.expeditions.updateStatus(exp.id, 'merged', 'already an ancestor of the anchored branch');
    return { ok: true, merged: true, layer: 'mechanical', into: exp.anchorBranch };
  }

  const tmpWt = path.join(project.path, '.weave', 'worktrees', `merge-exp-${exp.id}`);
  const add = await deps.exec('git', ['worktree', 'add', '--detach', tmpWt, exp.anchorBranch], { cwd: project.path });
  if (add.code !== 0) {
    return { ok: false, status: 400, error: (add.stderr || add.stdout).trim().split('\n').slice(-3).join(' | ') || 'cannot open merge worktree' };
  }
  try {
    const run = await runMergeLadder(
      { exec: deps.exec, ladder: deps.ladder, projectId: exp.projectId, expeditionId: exp.id, aiRepair },
      tmpWt,
      exp.branch,
      exp.anchorBranch,
    );
    if (!run.ok) {
      deps.expeditions.updateStatus(exp.id, run.layer === 'returned' ? 'conflict' : 'error', run.report ?? run.outcome);
      return { ok: false, status: 409, error: run.report ?? run.outcome, layer: run.layer };
    }
    const upd = await deps.exec('git', ['update-ref', `refs/heads/${exp.anchorBranch}`, 'HEAD'], { cwd: tmpWt });
    if (upd.code !== 0) {
      deps.expeditions.updateStatus(exp.id, 'error', 'merge succeeded but ref update failed');
      return { ok: false, status: 400, error: 'merge succeeded but ref update failed', layer: run.layer };
    }
    deps.expeditions.updateStatus(exp.id, 'merged', `merged via ${run.layer} into ${exp.anchorBranch}`);
    deps.growth.insert({
      roleId: exp.roleId,
      verb: 'merge',
      target: exp.anchorBranch,
      detail: `expedition ${exp.id} layer ${run.layer}`,
    });
    return { ok: true, merged: true, layer: run.layer, into: exp.anchorBranch };
  } finally {
    await deps.exec('git', ['worktree', 'remove', '--force', tmpWt], { cwd: project.path });
  }
}

/** sweeper pending 认领的出征行改绑钩（登记与账本同一拍改写）：占位键行改写。 */
export function rebindExpeditionOnClaim(
  expeditions: RpgExpeditionRepository,
  pendingKey: string,
  sessionId: string,
): void {
  expeditions.rebindSessionKey(pendingKey, sessionId);
}
