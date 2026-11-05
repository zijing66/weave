import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 外发提醒通道：kind 决定 config 的形状（平台凭据），enabled 决定是否参与
 * 提醒扇出与可被编排 webhook 出口选用。凭据随 config JSON 落库——与编排
 * webhook 节点的 secret 同口径（dashboard 在认证门后，管理面要能回显重验）。
 */
export type NotifyChannelKind = 'wecom' | 'feishu' | 'dingtalk' | 'email' | 'serverchan' | 'pushplus';

export interface NotifyChannelConfig {
  /** wecom / feishu / dingtalk：机器人 webhook URL（含 token/key 查询参数）。 */
  url?: string;
  /** feishu / dingtalk：加签密钥（可选；平台侧开了签名校验才需要）。 */
  secret?: string;
  /** email：SMTP 连接与收发件人。 */
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from?: string;
  to?: string;
  /** serverchan：SendKey（sct.ftqq.com）。 */
  sendKey?: string;
  /** pushplus：token（pushplus.plus）。 */
  token?: string;
}

export interface NotifyChannelRow {
  id: string;
  kind: NotifyChannelKind;
  name: string;
  config: NotifyChannelConfig;
  enabled: boolean;
  createdAt: string;
}

const KINDS: readonly NotifyChannelKind[] = [
  'wecom',
  'feishu',
  'dingtalk',
  'email',
  'serverchan',
  'pushplus',
];

export function isNotifyChannelKind(value: unknown): value is NotifyChannelKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

export class NotifyChannelRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: {
    kind: NotifyChannelKind;
    name: string;
    config: NotifyChannelConfig;
    enabled?: boolean;
  }): NotifyChannelRow {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO notify_channels (id, kind, name, config, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.name,
        JSON.stringify(input.config),
        input.enabled === false ? 0 : 1,
        new Date().toISOString(),
      );
    return this.getById(id)!;
  }

  getById(id: string): NotifyChannelRow | undefined {
    const row = this.db.prepare('SELECT * FROM notify_channels WHERE id = ?').get(id);
    return row ? toRow(row) : undefined;
  }

  list(): NotifyChannelRow[] {
    return this.db
      .prepare('SELECT * FROM notify_channels ORDER BY created_at, id')
      .all()
      .map(toRow);
  }

  listEnabled(): NotifyChannelRow[] {
    return this.db
      .prepare('SELECT * FROM notify_channels WHERE enabled = 1 ORDER BY created_at, id')
      .all()
      .map(toRow);
  }

  update(
    id: string,
    patch: {
      kind?: NotifyChannelKind;
      name?: string;
      config?: NotifyChannelConfig;
      enabled?: boolean;
    },
  ): NotifyChannelRow | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    this.db
      .prepare('UPDATE notify_channels SET kind = ?, name = ?, config = ?, enabled = ? WHERE id = ?')
      .run(
        patch.kind ?? current.kind,
        patch.name ?? current.name,
        JSON.stringify(patch.config ?? current.config),
        (patch.enabled ?? current.enabled) ? 1 : 0,
        id,
      );
    return this.getById(id);
  }

  delete(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM notify_channels WHERE id = ?').run(id).changes) === 1;
  }
}

function toRow(row: Record<string, unknown>): NotifyChannelRow {
  return {
    id: String(row.id),
    kind: isNotifyChannelKind(row.kind) ? row.kind : 'wecom',
    name: String(row.name),
    config: parseConfig(row.config),
    enabled: Number(row.enabled) === 1,
    createdAt: String(row.created_at),
  };
}

/** 坏 JSON 当空配置：行还在，发送时按缺字段报错（不因一条坏行炸整表）。 */
function parseConfig(raw: unknown): NotifyChannelConfig {
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as NotifyChannelConfig) : {};
  } catch {
    return {};
  }
}
