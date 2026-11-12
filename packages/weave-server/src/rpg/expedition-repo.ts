import type { DatabaseSync } from 'node:sqlite';

/**
 * 出征账仓储（G3 段0 接钉）：rpg_expeditions 表的唯一读写面。一次出征 = 角色 ×
 * 目标项目 × worktree 分支；session_key 起手记占位键（pending-<uuid>），首个会话
 * 事件认领后改写成真实会话 id（rebindSessionKey，与 worktree 登记的 pending 认领
 * 同一拍）。status 词表封闭：active | merged | conflict | dangling | frozen | error。
 */

export type ExpeditionStatus = 'active' | 'merged' | 'conflict' | 'dangling' | 'frozen' | 'error';

export interface RpgExpeditionRow {
  id: number;
  roleId: number;
  projectId: number;
  /** 占位键/会话 id（登记键，认领后改写）。 */
  sessionKey: string | null;
  branch: string;
  anchorBranch: string;
  anchorSha: string;
  status: ExpeditionStatus;
  title: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export class RpgExpeditionRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(input: {
    roleId: number;
    projectId: number;
    sessionKey?: string | null;
    branch: string;
    anchorBranch: string;
    anchorSha: string;
    title?: string | null;
  }): RpgExpeditionRow {
    const at = new Date().toISOString();
    const res = this.db
      .prepare(
        `INSERT INTO rpg_expeditions (role_id, project_id, session_key, branch, anchor_branch, anchor_sha, status, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        input.roleId,
        input.projectId,
        input.sessionKey ?? null,
        input.branch,
        input.anchorBranch,
        input.anchorSha,
        input.title ?? null,
        at,
        at,
      );
    return this.getById(Number(res.lastInsertRowid))!;
  }

  getById(id: number): RpgExpeditionRow | undefined {
    const row = this.db.prepare('SELECT * FROM rpg_expeditions WHERE id = ?').get(id);
    return row ? toRow(row as Record<string, unknown>) : undefined;
  }

  getBySessionKey(key: string): RpgExpeditionRow | undefined {
    const row = this.db.prepare('SELECT * FROM rpg_expeditions WHERE session_key = ?').get(key);
    return row ? toRow(row as Record<string, unknown>) : undefined;
  }

  listByProject(projectId: number, limit = 200): RpgExpeditionRow[] {
    return (
      this.db
        .prepare('SELECT * FROM rpg_expeditions WHERE project_id = ? ORDER BY id DESC LIMIT ?')
        .all(projectId, limit) as Array<Record<string, unknown>>
    ).map(toRow);
  }

  listByRole(roleId: number, limit = 200): RpgExpeditionRow[] {
    return (
      this.db
        .prepare('SELECT * FROM rpg_expeditions WHERE role_id = ? ORDER BY id DESC LIMIT ?')
        .all(roleId, limit) as Array<Record<string, unknown>>
    ).map(toRow);
  }

  /** 全量（G6 角色可见桥的项目行徽章一次拉齐；新→旧封顶）。 */
  listAll(limit = 500): RpgExpeditionRow[] {
    return (
      this.db
        .prepare('SELECT * FROM rpg_expeditions ORDER BY id DESC LIMIT ?')
        .all(limit) as Array<Record<string, unknown>>
    ).map(toRow);
  }

  /** 占位键 → 真实会话 id（pending 认领改绑；没有该占位键 = 静默 no-op）。 */
  rebindSessionKey(oldKey: string, sessionKey: string): void {
    this.db
      .prepare('UPDATE rpg_expeditions SET session_key = ?, updated_at = ? WHERE session_key = ?')
      .run(sessionKey, new Date().toISOString(), oldKey);
  }

  updateStatus(id: number, status: ExpeditionStatus, note?: string): RpgExpeditionRow | undefined {
    this.db
      .prepare('UPDATE rpg_expeditions SET status = ?, note = ?, updated_at = ? WHERE id = ?')
      .run(status, note ?? null, new Date().toISOString(), id);
    return this.getById(id);
  }
}

function toRow(r: Record<string, unknown>): RpgExpeditionRow {
  return {
    id: Number(r.id),
    roleId: Number(r.role_id),
    projectId: Number(r.project_id),
    sessionKey: r.session_key == null ? null : String(r.session_key),
    branch: String(r.branch),
    anchorBranch: String(r.anchor_branch),
    anchorSha: String(r.anchor_sha),
    status: String(r.status) as ExpeditionStatus,
    title: r.title == null ? null : String(r.title),
    note: r.note == null ? null : String(r.note),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
