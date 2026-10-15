import type { DatabaseSync } from 'node:sqlite';

/**
 * Web Push 订阅（每浏览器安装一份）：endpoint = 推送服务分配的绝对 URL（天然
 * 唯一键）；p256dh/auth = 浏览器生成的加密密钥对（aes128gcm 载荷加密用）。
 * 生命周期由推送服务裁决——发送侧收到 404/410 即删行，没有手工管理面。
 */
export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: string;
}

export class PushSubscriptionRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 同 endpoint 重订阅 = 覆写密钥（浏览器 rotate 密钥后 endpoint 常不变）。 */
  upsert(input: {
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string | null;
  }): PushSubscriptionRow {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
           user_agent = excluded.user_agent`,
      )
      .run(
        input.endpoint,
        input.p256dh,
        input.auth,
        input.userAgent ?? null,
        new Date().toISOString(),
      );
    return this.getById(input.endpoint)!;
  }

  getById(endpoint: string): PushSubscriptionRow | undefined {
    const row = this.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
    return row ? toRow(row) : undefined;
  }

  list(): PushSubscriptionRow[] {
    return this.db
      .prepare('SELECT * FROM push_subscriptions ORDER BY created_at, endpoint')
      .all()
      .map(toRow);
  }

  deleteByEndpoint(endpoint: string): boolean {
    return Number(
      this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes,
    ) === 1;
  }
}

function toRow(row: Record<string, unknown>): PushSubscriptionRow {
  return {
    endpoint: String(row.endpoint),
    p256dh: String(row.p256dh),
    auth: String(row.auth),
    userAgent: row.user_agent == null ? null : String(row.user_agent),
    createdAt: String(row.created_at),
  };
}
