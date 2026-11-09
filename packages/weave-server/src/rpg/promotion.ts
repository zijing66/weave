import path from 'node:path';
import { existsSync } from 'node:fs';
import { installSkill } from '../install/installer.js';
import { installGlobalSkill } from '../install/global-config.js';
import { builtinMarketDir } from '../market/builtin.js';
import { getDataRoot } from '../db/paths.js';
import type { ProjectRepository } from '../repositories/projects.js';
import { RpgGrowthRepository, type RpgRoleRepository } from './roles.js';
import { RpgCropRepository, gradeAtLeast, type RpgCropRow } from './grade.js';

/**
 * 晋升三档（G3 修炼，G线设计 §七）：既有三层安装位游戏化——
 * ① 核心工作空间项目档（installSkill，角色项目 → 目标项目）
 * ② 内建仓库（`<data>/market/weave/`，builtinMarketDir 副本）
 * ③ 全局用户级（installGlobalSkill，`~/.claude/skills/`）
 * 晋升是**级2 人工裁决**（收菜那一刻用户确认）——本模块只做机械件，确认闸在路由
 * 层呈 ConfirmDialog；级2 未确认不写任何安装位。
 */

export type PromotionTier = 1 | 2 | 3;

export const PROMOTION_TIER_LABELS: Record<PromotionTier, string> = {
  1: '核心工作空间项目档',
  2: '内建仓库（builtin market）',
  3: '全局用户级',
};

export interface PromotionDeps {
  projects: ProjectRepository;
  roles: RpgRoleRepository;
  crops: RpgCropRepository;
  growth: RpgGrowthRepository;
  /** 内建仓库根覆盖（测试注入；缺省 builtinMarketDir(dataRoot)）。 */
  builtinRoot?: string;
  /** 全局 skills 根覆盖（测试注入；缺省 installGlobalSkill 直写 homedir）。 */
  globalInstall?: (sourceDir: string, name: string) => Promise<string>;
}

export type PromotionResult =
  | { ok: true; tier: PromotionTier; installedAt: string; grade: RpgCropRow['grade'] }
  | { ok: false; status: number; error: string };

/**
 * 晋升一株已收菜的作物到第 N 档。晋升闸：status 必须是 harvested（growing 还没
 * 收，promoted 已晋过——重复晋升=幂等拒绝）；grade 至少到灵品才可晋升（凡品产物
 * 自产自销，不出角色仓——级0 判据）。
 */
export async function promoteCrop(
  deps: PromotionDeps,
  cropId: number,
  tier: PromotionTier,
  input?: { targetProjectId?: number },
): Promise<PromotionResult> {
  const crop = deps.crops.getById(cropId);
  if (!crop) return { ok: false, status: 404, error: 'Crop not found' };
  if (crop.status !== 'harvested') {
    return { ok: false, status: 409, error: `Crop is ${crop.status}, only harvested crops can be promoted` };
  }
  if (!gradeAtLeast(crop.grade, '灵')) {
    return { ok: false, status: 409, error: 'Grade 凡品 cannot be promoted (灵品+ required)' };
  }
  const role = deps.roles.getById(crop.roleId);
  if (!role) return { ok: false, status: 404, error: 'Role not found' };
  const roleProject = deps.projects.getById(role.projectId);
  if (!roleProject) return { ok: false, status: 404, error: 'Role project not found' };
  // 产物源目录：skill 形态 = 角色仓 `.claude/skills/<name>/`（种田收菜落点）；
  // artifact_path 相对路径优先（钓鱼等自定义落点）。
  const sourceDir = crop.artifactPath
    ? path.join(roleProject.path, crop.artifactPath)
    : path.join(roleProject.path, '.claude', 'skills', crop.name);
  if (!existsSync(sourceDir)) {
    return { ok: false, status: 404, error: `Crop artifact not found: ${sourceDir}` };
  }

  let installedAt: string;
  if (tier === 1) {
    // 核心工作空间项目档：目标是调用方给的项目（缺省 = 角色仓自己的项目行）。
    const targetProject = input?.targetProjectId
      ? deps.projects.getById(input.targetProjectId)
      : crop.projectId
        ? deps.projects.getById(crop.projectId)
        : roleProject;
    if (!targetProject) return { ok: false, status: 404, error: 'Target project not found' };
    try {
      installedAt = await installSkill(targetProject.path, sourceDir, crop.name);
    } catch (err) {
      return { ok: false, status: err instanceof Error && err.name === 'InstallConflictError' ? 409 : 400, error: err instanceof Error ? err.message : 'install failed' };
    }
  } else if (tier === 2) {
    const root = deps.builtinRoot ?? builtinMarketDir(getDataRoot());
    const target = path.join(root, 'skills', crop.name);
    const { cp, mkdir } = await import('node:fs/promises');
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await cp(sourceDir, target, { recursive: true });
    } catch (err) {
      return { ok: false, status: 400, error: err instanceof Error ? err.message : 'builtin market copy failed' };
    }
    installedAt = target;
  } else {
    try {
      installedAt = deps.globalInstall
        ? await deps.globalInstall(sourceDir, crop.name)
        : await installGlobalSkill(sourceDir, crop.name);
    } catch (err) {
      return { ok: false, status: 409, error: err instanceof Error ? err.message : 'global install failed' };
    }
  }

  deps.crops.setStatus(cropId, 'promoted', `promoted to tier ${tier}: ${installedAt}`);
  deps.growth.insert({
    roleId: crop.roleId,
    verb: 'promote',
    target: crop.name,
    detail: `tier ${tier} (${PROMOTION_TIER_LABELS[tier]}) from ${sourceDir}`,
  });
  return { ok: true, tier, installedAt, grade: crop.grade };
}
