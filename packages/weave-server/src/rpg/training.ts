import path from 'node:path';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { ProjectRepository } from '../repositories/projects.js';
import { RpgGrowthRepository, type RpgRoleRepository } from './roles.js';
import { RpgCropRepository, type CropKind, type GradeMetrics } from './grade.js';

/**
 * 修炼动作（G3，G线设计 §七）：种田 / 钓鱼两条产物通道的机械件——
 * - **种田 = skill**：一株作物 = 一次真实构建回合；「下种」= 在角色仓起一块
 *   skill 模板田（`crops/<作物名>/`），生长 = 该 skill 被真实写全（SKILL.md 存在
 *   且有正文），收菜 = 验收（度量列 + 品阶即评定）+ 既有 installSkill 装进角色仓
 *   `.claude/skills/`。产物落角色仓库，绝不越界写用户项目。
 * - **钓鱼 = 插件**：咬钩 = 产物验收交互（同一 assess 收口，kind='fishing'）；
 *   照料介入（构建失败「该浇水了」）走既有 watch/notify 通道，这里不造第二套。
 * - **锻造 = 角色**：纯前端入口（导向 CreateRoleForm），无服务端动作。
 */

export interface TrainingDeps {
  projects: ProjectRepository;
  roles: RpgRoleRepository;
  crops: RpgCropRepository;
  growth: RpgGrowthRepository;
}

/** 种田田块落点（角色仓内、可提交进版本历史的产物区）。 */
export function cropFieldDir(roleProjectPath: string, name: string): string {
  return path.join(roleProjectPath, 'crops', name);
}

/** 模板 SKILL.md（下种即落——生长的事实基线，之后由真实构建回合写全）。
 *  **纯注释体**：模板态被验收判成「未长出」（保守判定的事实基线）。 */
function skillTemplate(name: string, kind: CropKind): string {
  const label = kind === 'farming' ? '种田' : '钓鱼';
  void name;
  return `<!-- weave 修炼产物（${label}）：本文件是生长基线，由真实构建回合写全。 -->\n<!-- 生长阶段 = 事实发展阶段：正文写全 + 带测试 + 过 lint + 有文档 = 品阶自评。 -->\n`;
}

/**
 * 下种（种田/钓鱼通用起手）：角色仓 `crops/<名>/` 落一块带模板 SKILL.md 的田 +
 * rpg_crops 落一行 growing。同名 growing 田已存在 = 409（一株一田，不覆盖）。
 */
export async function plantCrop(
  deps: TrainingDeps,
  roleId: number,
  input: { kind: CropKind; name: string },
): Promise<{ ok: true; cropId: number; fieldPath: string } | { ok: false; status: number; error: string }> {
  const role = deps.roles.getById(roleId);
  if (!role) return { ok: false, status: 404, error: 'Role not found' };
  const project = deps.projects.getById(role.projectId);
  if (!project) return { ok: false, status: 404, error: 'Role project not found' };
  const name = input.name.trim();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
    return { ok: false, status: 400, error: 'Crop name must be kebab-case (a-z 0-9 -)' };
  }
  const field = cropFieldDir(project.path, name);
  const skillFile = path.join(field, 'SKILL.md');
  if (existsSync(skillFile)) {
    return { ok: false, status: 409, error: `Crop field already exists: ${field}` };
  }
  await mkdir(field, { recursive: true });
  await writeFile(skillFile, skillTemplate(name, input.kind), 'utf8');
  const row = deps.crops.plant({ roleId, projectId: project.id, kind: input.kind, name });
  deps.growth.insert({
    roleId,
    verb: 'plant',
    target: name,
    detail: `${input.kind} field ${path.relative(project.path, field)}`,
  });
  return { ok: true, cropId: row.id, fieldPath: field };
}

/** 收菜验收的自动度量（角色仓内）：产物/测试/文档按盘上事实、lint 交给上游判定。 */
export async function assessCropFromField(
  deps: TrainingDeps,
  cropId: number,
  extra?: Partial<GradeMetrics> & { note?: string },
): Promise<{ ok: true; crop: NonNullable<ReturnType<RpgCropRepository['getById']>> } | { ok: false; status: number; error: string }> {
  const crop = deps.crops.getById(cropId);
  if (!crop) return { ok: false, status: 404, error: 'Crop not found' };
  const role = deps.roles.getById(crop.roleId);
  if (!role) return { ok: false, status: 404, error: 'Role not found' };
  const project = deps.projects.getById(role.projectId);
  if (!project) return { ok: false, status: 404, error: 'Role project not found' };
  const field = cropFieldDir(project.path, crop.name);
  const skillFile = path.join(field, 'SKILL.md');
  // 保守判定（宁可判凡）：SKILL.md 缺席或只有模板注释 = 没长出来。
  let body = '';
  try {
    body = await readFile(skillFile, 'utf8');
  } catch {
    /* 缺文件 = 未长出 */
  }
  const hasArtifact =
    existsSync(skillFile) &&
    body
      .split('\n')
      .some((l) => l.trim() !== '' && !l.trim().startsWith('<!--')) &&
    !/^\s*$/.test(body.replace(/<!--[\s\S]*?-->/g, '').trim());
  const hasTests = existsSync(path.join(field, 'tests')) || existsSync(path.join(field, '__tests__')) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(body);
  const docsOk = existsSync(path.join(field, 'README.md'));
  const updated = deps.crops.assess(
    cropId,
    // 盘上事实是权威（请求方虚报不抬档——保守判定的落点）；lint 交给上游判定。
    {
      hasArtifact,
      hasTests,
      lintOk: extra?.lintOk ?? false,
      docsOk,
      ...(extra?.note !== undefined ? { note: extra.note } : {}),
    },
    { artifactPath: `crops/${crop.name}`, note: extra?.note ?? null, status: hasArtifact ? 'harvested' : 'growing' },
  );
  if (!updated) return { ok: false, status: 404, error: 'Crop not found' };
  if (updated.status === 'harvested') {
    deps.growth.insert({
      roleId: crop.roleId,
      verb: 'harvest',
      target: crop.name,
      detail: `grade ${updated.grade ?? '凡'} artifact=${hasArtifact} tests=${hasTests} lint=${extra?.lintOk ?? false} docs=${docsOk}`,
    });
  }
  return { ok: true, crop: updated };
}

/** 收菜装进角色仓 `.claude/skills/`（田 → 正式 skill 位；种田的「产物落角色仓库」）。 */
export async function harvestCropToSkill(
  deps: TrainingDeps,
  cropId: number,
): Promise<{ ok: true; installedAt: string } | { ok: false; status: number; error: string }> {
  const crop = deps.crops.getById(cropId);
  if (!crop) return { ok: false, status: 404, error: 'Crop not found' };
  if (crop.kind !== 'farming') return { ok: false, status: 400, error: 'Only farming crops install as skills' };
  if (crop.status !== 'harvested') {
    return { ok: false, status: 409, error: `Crop is ${crop.status} — assess (harvest) first` };
  }
  if (!gradeAtLeastNullable(crop.grade)) {
    return { ok: false, status: 409, error: 'Grade 凡品 stays in the field (灵品+ to harvest into skills)' };
  }
  const role = deps.roles.getById(crop.roleId);
  if (!role) return { ok: false, status: 404, error: 'Role not found' };
  const project = deps.projects.getById(role.projectId);
  if (!project) return { ok: false, status: 404, error: 'Role project not found' };
  const field = cropFieldDir(project.path, crop.name);
  const target = path.join(project.path, '.claude', 'skills', crop.name);
  if (existsSync(target)) {
    return { ok: false, status: 409, error: `Skill already installed in role repo: ${target}` };
  }
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await cp(field, target, { recursive: true });
  } catch (err) {
    return { ok: false, status: 400, error: err instanceof Error ? err.message : 'copy failed' };
  }
  deps.growth.insert({
    roleId: crop.roleId,
    verb: 'cultivate',
    target: crop.name,
    detail: `harvested from crops/${crop.name} (grade ${crop.grade ?? '凡'})`,
  });
  return { ok: true, installedAt: target };
}

/** 收菜进 skill 位同样要至少灵品（凡品不自封——保守判定的同一条闸）。 */
function gradeAtLeastNullable(grade: string | null): boolean {
  return grade === '灵' || grade === '仙' || grade === '天';
}
