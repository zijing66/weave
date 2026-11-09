import type { DatabaseSync } from 'node:sqlite';

/**
 * 修真品阶（G3 修炼，G线设计 §七 用户选 A）：凡品=能跑（有产物）/ 灵品=带测试 /
 * 仙品=过全门（lint+测试+文档）/ 天品=人工（系统不自动判天）。**度量列是评定的
 * 唯一信号源、保守判定**——宁可判凡不可虚高：anyRequired 缺席按「未达标」算
 * （不是「达标」），纯函数可测、无随机。
 */

export type CropGrade = '凡' | '灵' | '仙' | '天';
export type CropKind = 'farming' | 'fishing';
export type CropStatus = 'growing' | 'harvested' | 'discarded' | 'promoted';

/** 品阶评定输入 = 产物验收时的真实度量（布尔各由上游真实验收判定）。 */
export interface GradeMetrics {
  hasArtifact: boolean;
  hasTests: boolean;
  lintOk: boolean;
  docsOk: boolean;
}

/**
 * 品阶自动评定（级0 纯度量）：灵品要求「产物 + 测试」，仙品要求「产物 + 测试 +
 * lint + 文档」全过。天品不在这里出（人工裁决）。
 */
export function gradeOf(m: GradeMetrics): CropGrade {
  if (m.hasArtifact && m.hasTests && m.lintOk && m.docsOk) return '仙';
  if (m.hasArtifact && m.hasTests) return '灵';
  return '凡';
}

/** 品阶名 → 展示序（凡 < 灵 < 仙 < 天；晋升闸用「至少到某档」比较）。 */
const GRADE_ORDER: Record<CropGrade, number> = { 凡: 0, 灵: 1, 仙: 2, 天: 3 };

export function gradeAtLeast(grade: CropGrade | null, threshold: CropGrade): boolean {
  if (grade == null) return false;
  return GRADE_ORDER[grade] >= GRADE_ORDER[threshold];
}

export interface RpgCropRow {
  id: number;
  roleId: number;
  projectId: number | null;
  kind: CropKind;
  name: string;
  artifactPath: string | null;
  hasArtifact: boolean;
  hasTests: boolean;
  lintOk: boolean;
  docsOk: boolean;
  grade: CropGrade | null;
  status: CropStatus;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export class RpgCropRepository {
  constructor(private readonly db: DatabaseSync) {}

  plant(input: { roleId: number; projectId?: number | null; kind: CropKind; name: string }): RpgCropRow {
    const at = new Date().toISOString();
    const res = this.db
      .prepare(
        `INSERT INTO rpg_crops (role_id, project_id, kind, name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'growing', ?, ?)`,
      )
      .run(input.roleId, input.projectId ?? null, input.kind, input.name, at, at);
    return this.getById(Number(res.lastInsertRowid))!;
  }

  getById(id: number): RpgCropRow | undefined {
    const row = this.db.prepare('SELECT * FROM rpg_crops WHERE id = ?').get(id);
    return row ? toRow(row as Record<string, unknown>) : undefined;
  }

  listByRole(roleId: number, limit = 200): RpgCropRow[] {
    return (
      this.db
        .prepare('SELECT * FROM rpg_crops WHERE role_id = ? ORDER BY id DESC LIMIT ?')
        .all(roleId, limit) as Array<Record<string, unknown>>
    ).map(toRow);
  }

  /** 验收（咬钩/收菜那一拍）：度量落列 + 品阶即评定（度量是唯一信号源）。 */
  assess(
    id: number,
    metrics: GradeMetrics,
    patch?: { artifactPath?: string | null; note?: string | null; status?: CropStatus },
  ): RpgCropRow | undefined {
    const cur = this.getById(id);
    if (!cur) return undefined;
    const grade = gradeOf(metrics);
    const status = patch?.status ?? (metrics.hasArtifact ? 'harvested' : 'growing');
    this.db
      .prepare(
        `UPDATE rpg_crops SET has_artifact = ?, has_tests = ?, lint_ok = ?, docs_ok = ?, grade = ?,
           artifact_path = COALESCE(?, artifact_path), note = COALESCE(?, note), status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        metrics.hasArtifact ? 1 : 0,
        metrics.hasTests ? 1 : 0,
        metrics.lintOk ? 1 : 0,
        metrics.docsOk ? 1 : 0,
        grade,
        patch?.artifactPath ?? null,
        patch?.note ?? null,
        status,
        new Date().toISOString(),
        id,
      );
    return this.getById(id);
  }

  setStatus(id: number, status: CropStatus, note?: string): RpgCropRow | undefined {
    this.db
      .prepare('UPDATE rpg_crops SET status = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?')
      .run(status, note ?? null, new Date().toISOString(), id);
    return this.getById(id);
  }
}

function toRow(r: Record<string, unknown>): RpgCropRow {
  return {
    id: Number(r.id),
    roleId: Number(r.role_id),
    projectId: r.project_id == null ? null : Number(r.project_id),
    kind: String(r.kind) as CropKind,
    name: String(r.name),
    artifactPath: r.artifact_path == null ? null : String(r.artifact_path),
    hasArtifact: Number(r.has_artifact) === 1,
    hasTests: Number(r.has_tests) === 1,
    lintOk: Number(r.lint_ok) === 1,
    docsOk: Number(r.docs_ok) === 1,
    grade: r.grade == null ? null : (String(r.grade) as CropGrade),
    status: String(r.status) as CropStatus,
    note: r.note == null ? null : String(r.note),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
