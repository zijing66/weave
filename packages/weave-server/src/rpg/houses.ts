import type { DatabaseSync } from 'node:sqlite';

/**
 * 房子域（G2，G线设计 §一）：项目组合 = 1 核心工作空间 + N 辅助项目 + team/角色
 * 入住。**同一张 houses 表**，单项目房 = 退化态（core=自己、无成员行）——不另设
 * 「单项目房」实体。分身（协调者）= 每房必有的上帝分身（用户裁决 2026-11-08：
 * 协调者是用户掌控的上帝在各项目的分身，不是独立第三方 agent），随房建、名字
 * 固定语义、v1 最小形只存人设文本。
 */

export type HouseMemberKind = 'aux' | 'role';

export interface RpgHouseRow {
  id: number;
  name: string;
  coreProjectId: number;
  coordinatorPersona: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RpgHouseMemberRow {
  id: number;
  houseId: number;
  kind: HouseMemberKind;
  projectId: number | null;
  roleId: number | null;
  addedAt: string;
}

export class RpgHouseRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: { name: string; coreProjectId: number; coordinatorPersona?: string }): RpgHouseRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO rpg_houses (name, core_project_id, coordinator_persona, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.name, input.coreProjectId, input.coordinatorPersona ?? null, now, now);
    const row = this.db.prepare('SELECT * FROM rpg_houses WHERE id = last_insert_rowid()').get() as
      | Record<string, unknown>
      | undefined;
    return toHouse(row)!;
  }

  getById(id: number): RpgHouseRow | undefined {
    return toHouse(this.db.prepare('SELECT * FROM rpg_houses WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined);
  }

  /** 同核心项目只允许一栋活房（核心工作空间语义：一个项目在一张图里只有一间主屋）。 */
  getByCoreProjectId(coreProjectId: number): RpgHouseRow | undefined {
    return toHouse(
      this.db.prepare('SELECT * FROM rpg_houses WHERE core_project_id = ?').get(coreProjectId) as
        | Record<string, unknown>
        | undefined,
    );
  }

  list(): RpgHouseRow[] {
    return (this.db.prepare('SELECT * FROM rpg_houses ORDER BY id').all() as Array<
      Record<string, unknown>
    >).map((r) => toHouse(r)!);
  }

  update(id: number, patch: { name?: string; coordinatorPersona?: string | null }): RpgHouseRow | undefined {
    const house = this.getById(id);
    if (!house) return undefined;
    const name = patch.name ?? house.name;
    const persona = patch.coordinatorPersona !== undefined ? patch.coordinatorPersona : house.coordinatorPersona;
    this.db
      .prepare('UPDATE rpg_houses SET name = ?, coordinator_persona = ?, updated_at = ? WHERE id = ?')
      .run(name, persona, new Date().toISOString(), id);
    return this.getById(id);
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM rpg_houses WHERE id = ?').run(id).changes > 0;
  }

  listMembers(houseId: number): RpgHouseMemberRow[] {
    return (
      this.db
        .prepare('SELECT * FROM rpg_house_members WHERE house_id = ? ORDER BY id')
        .all(houseId) as Array<Record<string, unknown>>
    ).map(toMember);
  }

  addMember(input: { houseId: number; kind: HouseMemberKind; projectId?: number; roleId?: number }): number {
    if (input.kind === 'aux' && input.projectId == null) throw new Error('aux member requires projectId');
    if (input.kind === 'role' && input.roleId == null) throw new Error('role member requires roleId');
    const res = this.db
      .prepare('INSERT INTO rpg_house_members (house_id, kind, project_id, role_id, added_at) VALUES (?, ?, ?, ?, ?)')
      .run(
        input.houseId,
        input.kind,
        input.projectId ?? null,
        input.roleId ?? null,
        new Date().toISOString(),
      );
    return Number(res.lastInsertRowid);
  }

  removeMember(houseId: number, memberId: number): boolean {
    return (
      this.db
        .prepare('DELETE FROM rpg_house_members WHERE house_id = ? AND id = ?')
        .run(houseId, memberId).changes > 0
    );
  }
}

function toHouse(row: Record<string, unknown> | undefined): RpgHouseRow | undefined {
  if (!row) return undefined;
  return {
    id: Number(row.id),
    name: String(row.name),
    coreProjectId: Number(row.core_project_id),
    coordinatorPersona: row.coordinator_persona == null ? null : String(row.coordinator_persona),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toMember(row: Record<string, unknown>): RpgHouseMemberRow {
  return {
    id: Number(row.id),
    houseId: Number(row.house_id),
    kind: row.kind === 'role' ? 'role' : 'aux',
    projectId: row.project_id == null ? null : Number(row.project_id),
    roleId: row.role_id == null ? null : Number(row.role_id),
    addedAt: String(row.added_at),
  };
}
