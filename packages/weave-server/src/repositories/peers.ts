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
  }): PeerRow {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO peers (id, name, host, port, fingerprint, source, last_seen_at, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    patch: Partial<Pick<PeerRow, 'name' | 'host' | 'port' | 'fingerprint' | 'enabled'>>,
  ): PeerRow | undefined {
    const row = this.getById(id);
    if (!row) return undefined;
    const next = { ...row, ...patch };
    this.db
      .prepare(
        `UPDATE peers SET name = ?, host = ?, port = ?, fingerprint = ?, enabled = ? WHERE id = ?`,
      )
      .run(next.name, next.host, next.port, next.fingerprint, next.enabled ? 1 : 0, id);
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
    createdAt: String(row.created_at),
  };
}
