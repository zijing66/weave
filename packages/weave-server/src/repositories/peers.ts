import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 联邦 peer 注册表（E3）：手动 `host:port` 是基础（D8 原文），mDNS 自动发现是
 * 增强。per-peer token 不落本表——落 `<local>/peer-tokens/<peerId>.json`（0600，
 * 对齐 localToken 纪律：凭据绝不进 settings/DB 可读面；本表只记 tokenFile 名）。
 */
export interface PeerRow {
  id: string;
  name: string;
  host: string;
  port: number;
  /** 对端证书指纹（TOFU 首见记录；指纹不匹配即拒、重新 pairing——裁决 15④）。 */
  fingerprint: string | null;
  /** 配对来源。 */
  source: 'manual' | 'mdns' | 'pairing';
  /** 最近一次心跳（ISO）；null = 从未心跳。 */
  lastSeenAt: string | null;
  enabled: boolean;
  /**
   * 会话共享的项目范围（服务端裁决，客户端无感知）：null = 全部项目；
   * 数组 = 只放行这些项目 id 的会话（sessions.list / sessions.events / inject）。
   */
  scopeProjects: number[] | null;
  createdAt: string;
}

/** 每行 per-peer token 的落盘文件名（`<local>/peer-tokens/<tokenFile>`，0600）。 */
export function tokenFileOf(peerId: string): string {
  return `${peerId}.json`;
}

export class PeerRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: {
    name: string;
    host: string;
    port: number;
    fingerprint?: string | null;
    source?: PeerRow['source'];
    scopeProjects?: number[] | null;
  }): PeerRow {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO peers (id, name, host, port, fingerprint, source, last_seen_at, enabled, scope_projects, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.host,
        input.port,
        input.fingerprint ?? null,
        input.source ?? 'manual',
        null,
        1,
        input.scopeProjects == null ? null : JSON.stringify(input.scopeProjects),
        new Date().toISOString(),
      );
    return this.getById(id)!;
  }

  getById(id: string): PeerRow | undefined {
    const row = this.db.prepare('SELECT * FROM peers WHERE id = ?').get(id);
    return row ? toRow(row) : undefined;
  }

  list(): PeerRow[] {
    return (this.db.prepare('SELECT * FROM peers ORDER BY created_at').all() as Array<
      Record<string, unknown>
    >).map(toRow);
  }

  update(
    id: string,
    patch: Partial<Pick<PeerRow, 'name' | 'host' | 'port' | 'fingerprint' | 'enabled' | 'scopeProjects'>>,
  ): PeerRow | undefined {
    const row = this.getById(id);
    if (!row) return undefined;
    const next = { ...row, ...patch };
    this.db
      .prepare(
        `UPDATE peers SET name = ?, host = ?, port = ?, fingerprint = ?, enabled = ?, scope_projects = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.host,
        next.port,
        next.fingerprint,
        next.enabled ? 1 : 0,
        next.scopeProjects == null ? null : JSON.stringify(next.scopeProjects),
        id,
      );
    return this.getById(id);
  }

  /** 心跳落地：覆盖 last_seen_at（在线/离线由 peerLiveness 派生，不存状态列）。 */
  heartbeat(id: string, at: string): boolean {
    return (
      Number(
        this.db
          .prepare('UPDATE peers SET last_seen_at = ? WHERE id = ?')
          .run(at, id).changes,
      ) === 1
    );
  }

  delete(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM peers WHERE id = ?').run(id).changes) === 1;
  }
}

function toRow(row: Record<string, unknown>): PeerRow {
  return {
    id: String(row.id),
    name: String(row.name),
    host: String(row.host),
    port: Number(row.port),
    fingerprint: row.fingerprint == null ? null : String(row.fingerprint),
    source: (row.source === 'mdns' || row.source === 'pairing' ? row.source : 'manual') as PeerRow['source'],
    lastSeenAt: row.last_seen_at == null ? null : String(row.last_seen_at),
    enabled: Number(row.enabled) === 1,
    // 坏值（手改库 / 半截写入）回落 null = 全量——范围闸宁宽勿假窄，绝不猜一个子集
    scopeProjects: parseScope(row.scope_projects),
    createdAt: String(row.created_at),
  };
}

function parseScope(raw: unknown): number[] | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    // 显式 [] = 不共享（用户取消全选的意图原样保留）；坏 JSON 才回落 null = 全量
    return parsed.filter((v): v is number => typeof v === 'number' && Number.isInteger(v));
  } catch {
    return null;
  }
}
