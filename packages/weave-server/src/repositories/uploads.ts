import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getUploadsDir } from '../db/paths.js';

/**
 * 会话上传件：文件内容寻址（sha256 = id）落 `<dataDir>/data/uploads/<id>.<ext>`，
 * 行只记展示名与媒体类型。**上传 ≠ 投递**——资源不因消息发送而搬家，harness
 * 拿到的是这个稳定绝对路径（claude 的粘贴处理器按扩展名认出它是图）。
 *
 * 图片四型 = claude 路径识别集 `\.(png|jpe?g|gif|webp)$`（宿主把它变成 image
 * block + 输入框 `[Image #N]` 占位）；**其它类型宿主没有附件形态**，路径原样
 * 留在 prompt 里由模型自己读——所以非图片不做类型白名单，只按尺寸与名字限制。
 */
export const UPLOAD_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type UploadImageType = (typeof UPLOAD_IMAGE_TYPES)[number];
/** 旧名（图片上下文仍在用：prompt-images 的回采只搬这四种）。 */
export const UPLOAD_MEDIA_TYPES = UPLOAD_IMAGE_TYPES;
export type UploadMediaType = UploadImageType;

export function isImageMediaType(mediaType: string): mediaType is UploadImageType {
  return (UPLOAD_IMAGE_TYPES as readonly string[]).includes(mediaType);
}

/** 图片单张上限：对齐 claude 自己贴图的粘贴缓存上限（~10MB）。 */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/** 其它文件单件上限：文件不内联进上下文（宿主按需读），这里管的是磁盘配额。 */
export const UPLOAD_FILE_MAX_BYTES = 64 * 1024 * 1024;

export function maxUploadBytes(mediaType: string): number {
  return isImageMediaType(mediaType) ? UPLOAD_MAX_BYTES : UPLOAD_FILE_MAX_BYTES;
}

/**
 * 孤儿回收的宽限期：编辑器里选了图、还没发出去的那份此刻同样「无引用」，
 * 清理不能把它从用户手上抽走。
 */
export const UPLOAD_ORPHAN_GRACE_MS = 60 * 60_000;

const EXT_BY_MEDIA: Record<UploadImageType, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** 落盘扩展名：图片按媒体类型（claude 靠它认图），其它沿用原文件名的后缀。 */
function extOf(mediaType: string, name: string): string {
  if (isImageMediaType(mediaType)) return EXT_BY_MEDIA[mediaType];
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return m ? `.${m[1]!.toLowerCase()}` : '.bin';
}

export interface UploadRow {
  id: string;
  mediaType: string;
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
  save(input: { name: string; mediaType: string; bytes: Buffer }): UploadRow {
    const id = createHash('sha256').update(input.bytes).digest('hex');
    mkdirSync(this.dir, { recursive: true });
    const file = this.filePath(id, input.mediaType, input.name);
    if (!existsSync(file)) writeFileSync(file, input.bytes);
    this.db
      .prepare(
        `INSERT INTO uploads (id, media_type, name, size, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, input.mediaType, input.name, input.bytes.length, new Date().toISOString());
    return this.getById(id)!;
  }

  /**
   * 从临时件落库（分块上传的收尾）：流式算 sha256，再把它 rename 到正式落点
   * （`cache/` 与 `data/` 同一个根 → 同盘 rename，32MB 文件不进内存）。
   */
  async adoptFromFile(input: { name: string; mediaType: string; file: string }): Promise<UploadRow> {
    const hash = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      createReadStream(input.file)
        .on('data', (c) => hash.update(c))
        .on('end', () => resolve())
        .on('error', reject);
    });
    const id = hash.digest('hex');
    const size = statSync(input.file).size;
    mkdirSync(this.dir, { recursive: true });
    const target = this.filePath(id, input.mediaType, input.name);
    // 内容寻址：同一份内容可能已经在了（重复上传），那就只留旧的
    if (existsSync(target)) rmSync(input.file, { force: true });
    else renameSync(input.file, target);
    this.db
      .prepare(
        `INSERT INTO uploads (id, media_type, name, size, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, input.mediaType, input.name, size, new Date().toISOString());
    return this.getById(id)!;
  }

  getById(id: string): UploadRow | undefined {
    const row = this.db.prepare('SELECT * FROM uploads WHERE id = ?').get(id);
    return row ? toRow(row) : undefined;
  }

  /** 磁盘绝对路径（harness 的 `composePrompt` 引用的就是它）。 */
  filePath(id: string, mediaType: string, name: string): string {
    return path.join(this.dir, `${id}${extOf(mediaType, name)}`);
  }

  /** 投递引用（id + 展示名 + 落盘绝对路径）；任一 id 查不到即 null（整条拒绝）。 */
  refsOf(ids: readonly string[]): Array<{ id: string; name: string; mediaType: string; path: string }> | null {
    const out: Array<{ id: string; name: string; mediaType: string; path: string }> = [];
    for (const id of ids) {
      const row = this.getById(id);
      if (!row) return null;
      out.push({
        id: row.id,
        name: row.name,
        mediaType: row.mediaType,
        path: this.filePath(row.id, row.mediaType, row.name),
      });
    }
    return out;
  }

  /** 按行里记的媒体类型反查文件（serve 用；行不存在 / 文件被删 = undefined）。 */
  fileOf(id: string): { row: UploadRow; bytes: Buffer } | undefined {
    const row = this.getById(id);
    if (!row) return undefined;
    const file = this.filePath(row.id, row.mediaType, row.name);
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
   * 孤儿回收：没有任何 `event_images` 引用的上传件（文件 + 行）。图只被会话事件
   * 引用——事件随会话/项目一起清掉之后就再没有展示面（对话弹窗是事件的投影）。
   * 返清掉的条数。
   */
  pruneUnreferenced(olderThanMs: number = UPLOAD_ORPHAN_GRACE_MS, now: number = Date.now()): number {
    const rows = this.db
      .prepare(
        `SELECT id, media_type, name FROM uploads
          WHERE created_at <= ? AND id NOT IN (SELECT upload_id FROM event_images)`,
      )
      .all(new Date(now - olderThanMs).toISOString()) as Array<{
      id: string;
      media_type: string;
      name: string;
    }>;
    const del = this.db.prepare('DELETE FROM uploads WHERE id = ?');
    for (const row of rows) {
      rmSync(this.filePath(row.id, row.media_type, row.name), { force: true });
      del.run(row.id);
    }
    return rows.length;
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
    mediaType: String(raw.media_type),
    name: String(raw.name),
    size: Number(raw.size),
    createdAt: String(raw.created_at),
  };
}
