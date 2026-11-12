import type { DatabaseSync } from 'node:sqlite';

/**
 * 路由策略档（G6 进化闭环，G线设计 §六）：复盘扫出的调参经级2 呈批后落档，
 * 版本化可回滚（append-only 版本链 + is_current 唯一标记）。参数词表封闭在
 * `RoutingProfileParams`——扩参 = 加键 + 引擎消费点；**级2 八条清单永不入 params**
 * （安全边界非参数，提案永不触碰——红线一）。
 */

/** 策略参数（缺省 = 引擎内置缺省；部分键合法 = 只覆盖写到的键）。 */
export interface RoutingProfileParams {
  /** 无进展熔断阈值（GoalEngine stallLimit；缺省 3）。 */
  goalStallLimit?: number;
  /** 推进节拍冷却毫秒（GoalEngine driveCooldownMs；缺省 90s）。 */
  goalDriveCooldownMs?: number;
}

export const DEFAULT_ROUTING_PROFILE: Required<RoutingProfileParams> = {
  goalStallLimit: 3,
  goalDriveCooldownMs: 90_000,
};

export interface RpgProfileVersionRow {
  id: number;
  params: RoutingProfileParams;
  note: string | null;
  appliedBy: string;
  fromDecision: number | null;
  createdAt: string;
  isCurrent: boolean;
}

function toRow(raw: Record<string, unknown>): RpgProfileVersionRow {
  let params: RoutingProfileParams = {};
  try {
    params = JSON.parse(String(raw.params)) as RoutingProfileParams;
  } catch {
    params = {};
  }
  if (typeof params !== 'object' || params === null) params = {};
  return {
    id: Number(raw.id),
    params,
    note: raw.note == null ? null : String(raw.note),
    appliedBy: String(raw.applied_by),
    fromDecision: raw.from_decision == null ? null : Number(raw.from_decision),
    createdAt: String(raw.created_at),
    isCurrent: Number(raw.is_current) === 1,
  };
}

function sanitizeParams(input: Partial<RoutingProfileParams>): RoutingProfileParams {
  const out: RoutingProfileParams = {};
  const stall = input.goalStallLimit;
  if (typeof stall === 'number' && Number.isInteger(stall) && stall >= 1 && stall <= 9) {
    out.goalStallLimit = stall;
  }
  const cooldown = input.goalDriveCooldownMs;
  if (typeof cooldown === 'number' && Number.isInteger(cooldown) && cooldown >= 1_000 && cooldown <= 3_600_000) {
    out.goalDriveCooldownMs = cooldown;
  }
  return out;
}

export class RpgProfileRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 当前生效参数（无版本行 = 空对象 = 引擎全走缺省；不与缺省合并——合并在读方）。 */
  current(): RoutingProfileParams {
    const row = this.db
      .prepare('SELECT * FROM rpg_profile_versions WHERE is_current = 1 ORDER BY id DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    return row ? toRow(row).params : {};
  }

  /** 全量展开（合上缺省）——读方一步到位。 */
  resolved(): Required<RoutingProfileParams> {
    return { ...DEFAULT_ROUTING_PROFILE, ...this.current() };
  }

  /** 落新档（append-only）：唯一 is_current 交班。sanitize 词表外的值丢弃。 */
  commit(
    input: Partial<RoutingProfileParams> & {
      note?: string;
      appliedBy?: 'god' | 'proposal';
      fromDecision?: number | null;
    },
  ): RpgProfileVersionRow {
    const params = sanitizeParams(input);
    const res = this.db
      .prepare(
        `INSERT INTO rpg_profile_versions (params, note, applied_by, from_decision, created_at, is_current)
         VALUES (?, ?, ?, ?, ?, 1)`,
      )
      .run(
        JSON.stringify(params),
        input.note ?? null,
        input.appliedBy ?? 'god',
        input.fromDecision ?? null,
        new Date().toISOString(),
      );
    this.db.prepare('UPDATE rpg_profile_versions SET is_current = 0 WHERE id != ?').run(Number(res.lastInsertRowid));
    return this.getById(Number(res.lastInsertRowid))!;
  }

  getById(id: number): RpgProfileVersionRow | undefined {
    const row = this.db.prepare('SELECT * FROM rpg_profile_versions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toRow(row) : undefined;
  }

  listVersions(limit = 10): RpgProfileVersionRow[] {
    return (
      this.db.prepare('SELECT * FROM rpg_profile_versions ORDER BY id DESC LIMIT ?').all(limit) as Array<
        Record<string, unknown>
      >
    ).map(toRow);
  }

  /** 一键回滚：把旧版标回 is_current（append-only，不移除历史）。已是当前版 no-op null。 */
  rollbackTo(id: number): RpgProfileVersionRow | undefined {
    const row = this.getById(id);
    if (!row || row.isCurrent) return row ?? undefined;
    this.db.prepare('UPDATE rpg_profile_versions SET is_current = 0').run();
    this.db.prepare('UPDATE rpg_profile_versions SET is_current = 1 WHERE id = ?').run(id);
    return this.getById(id);
  }
}
