import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getUploadsDir } from '../db/paths.js';

/**
 * 会话图片上传：文件内容寻址（sha256 = id）落 `<dataDir>/uploads/<id>.<ext>`，
 * 行只记展示名与媒体类型。**上传 ≠ 投递**——资源不因消息发送而搬家，harness
 * 拿到的是这个稳定绝对路径（claude 的粘贴处理器按扩展名认出它是图）。
 * 收的四种类型 = claude 路径识别集 `\.(png|jpe?g|gif|webp)$`（别的类型即使能进
 * content block 也不进路径文法，v1 不收）。
 */
export const UPLOAD_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type UploadMediaType = (typeof UPLOAD_MEDIA_TYPES)[number];

/** 单张上限：对齐 claude 自己贴图的粘贴缓存上限（~10MB）。 */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

const EXT_BY_MEDIA: Record<UploadMediaType, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export interface UploadRow {
  id: string;
  mediaType: UploadMediaType;
  name: string;
  size: number;
  createdAt: string;
}

export class UploadRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly dir: string = getUploadsDir(),
  ) {}

  /**
   * 落盘 + 登记（内容寻址，重复上传即 no-op）。返回已存行。
   * 调用方先验过媒体类型与大小，这里只按类型定扩展名。
   */
  save(input: { name: string; mediaType: UploadMediaType; bytes: Buffer }): UploadRow {
    const id = createHash('sha256').update(input.bytes).digest('hex');
    mkdirSync(this.dir, { recursive: true });
    const file = this.filePath(id, input.mediaType);
    if (!existsSync(file)) writeFileSync(file, input.bytes);
    this.db
      .prepare(
        `INSERT INTO uploads (id, media_type, name, size, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, input.mediaType, input.name, input.bytes.length, new Date().toISOString());
    return this.getById(id)!;
  }

  getById(id: string): UploadRow | undefined {
    const row = this.db.prepare('SELECT * FROM uploads WHERE id = ?').get(id);
    return row ? toRow(row) : undefined;
  }

  /** 磁盘绝对路径（harness 的 `composePrompt` 引用的就是它）。 */
  filePath(id: string, mediaType: UploadMediaType): string {
    return path.join(this.dir, `${id}${EXT_BY_MEDIA[mediaType]}`);
  }

  /** 投递引用（id + 展示名 + 落盘绝对路径）；任一 id 查不到即 null（整条拒绝）。 */
  refsOf(ids: readonly string[]): Array<{ id: string; name: string; mediaType: string; path: string }> | null {
    const out: Array<{ id: string; name: string; mediaType: string; path: string }> = [];
    for (const id of ids) {
      const row = this.getById(id);
      if (!row) return null;
      out.push({ id: row.id, name: row.name, mediaType: row.mediaType, path: this.filePath(row.id, row.mediaType) });
    }
    return out;
  }

  /** 按行里记的媒体类型反查文件（serve 用；行不存在 / 文件被删 = undefined）。 */
  fileOf(id: string): { row: UploadRow; bytes: Buffer } | undefined {
    const row = this.getById(id);
    if (!row) return undefined;
    const file = this.filePath(row.id, row.mediaType);
    if (!existsSync(file)) return undefined;
    return { row, bytes: readFileSync(file) };
  }

  /** 挂到开轮事件上（对话气泡的缩略图指针；事件删则级联删）。 */
  linkToEvent(eventId: number, uploadIds: readonly string[]): void {
    const stmt = this.db.prepare(
      'INSERT INTO event_images (event_id, upload_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
    );
    for (const id of uploadIds) stmt.run(eventId, id);
  }

  /**
   * 会话各开轮事件随附的图（一次查询，不逐行 join）。
   * 返回 eventId → 指针表，web 据此把缩略图装到对话条目上。
   */
  imagesBySession(sessionId: string): Map<number, UploadRow[]> {
    const rows = this.db
      .prepare(
        `SELECT e.event_id AS eventId, u.* FROM event_images e
           JOIN uploads u ON u.id = e.upload_id
           JOIN hook_events h ON h.id = e.event_id
          WHERE h.session_id = ?
          ORDER BY e.event_id, u.created_at`,
      )
      .all(sessionId);
    const out = new Map<number, UploadRow[]>();
    for (const raw of rows) {
      const eventId = Number((raw as { eventId: number }).eventId);
      const list = out.get(eventId) ?? [];
      list.push(toRow(raw));
      out.set(eventId, list);
    }
    return out;
  }
}

function toRow(raw: Record<string, unknown>): UploadRow {
  return {
    id: String(raw.id),
    mediaType: String(raw.media_type) as UploadMediaType,
    name: String(raw.name),
    size: Number(raw.size),
    createdAt: String(raw.created_at),
  };
}
