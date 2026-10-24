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
export const UPLOAD_FILE_MAX_BYTES = 512 * 1024 * 1024;

export function maxUploadBytes(mediaType: string): number {
  return isImageMediaType(mediaType) ? UPLOAD_MAX_BYTES : UPLOAD_FILE_MAX_BYTES;
}

/**
 * 手动清理（设置页「对话附件存储」）对无引用件的宽限：比孤儿回收的 1h 短——
 * 那道宽限防的是「选了图还没发」，手动清理是用户明确下的手，只护正在输入的
 * 那一小会儿（刚拖进来还没发出的件）。
 */
export const UPLOAD_CLEANUP_GRACE_MS = 5 * 60_000;

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
  /** 项目自定义存储目录（null = 全局默认 <dataDir>/uploads/）。 */
  dir: string | null;
}

export class UploadRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly dir: string = getUploadsDir(),
  ) {}

  /** 全局默认目录（项目未配置时的落点；路由的 effective 口径从这里取）。 */
  get defaultDir(): string {
    return this.dir;
  }

  /**
   * 落盘 + 登记（内容寻址，重复上传即 no-op）。返回已存行。
   * 调用方先验过媒体类型与大小，这里只按类型定扩展名。
   * `dir` = 项目自定义存储目录（缺省 = 全局默认）。
   */
  save(input: { name: string; mediaType: string; bytes: Buffer; dir?: string | null }): UploadRow {
    const id = createHash('sha256').update(input.bytes).digest('hex');
    const dir = input.dir ?? this.dir;
    mkdirSync(dir, { recursive: true });
    const file = this.filePath(id, input.mediaType, input.name, dir);
    if (!existsSync(file)) writeFileSync(file, input.bytes);
    this.db
      .prepare(
        `INSERT INTO uploads (id, media_type, name, size, created_at, dir) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, input.mediaType, input.name, input.bytes.length, new Date().toISOString(), input.dir ?? null);
    return this.getById(id)!;
  }

  /**
   * 从临时件落库（分块上传的收尾）：流式算 sha256，再把它 rename 到正式落点
   * （`cache/` 与 `data/` 同一个根 → 同盘 rename，32MB 文件不进内存）。
   */
  async adoptFromFile(input: {
    name: string;
    mediaType: string;
    file: string;
    dir?: string | null;
  }): Promise<UploadRow> {
    const hash = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      createReadStream(input.file)
        .on('data', (c) => hash.update(c))
        .on('end', () => resolve())
        .on('error', reject);
    });
    const id = hash.digest('hex');
    const size = statSync(input.file).size;
    const dir = input.dir ?? this.dir;
    mkdirSync(dir, { recursive: true });
    const target = this.filePath(id, input.mediaType, input.name, dir);
    // 内容寻址：同一份内容可能已经在了（重复上传），那就只留旧的
    if (existsSync(target)) rmSync(input.file, { force: true });
    else renameSync(input.file, target);
    this.db
      .prepare(
        `INSERT INTO uploads (id, media_type, name, size, created_at, dir) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, input.mediaType, input.name, size, new Date().toISOString(), input.dir ?? null);
    return this.getById(id)!;
  }

  getById(id: string): UploadRow | undefined {
    const row = this.db.prepare('SELECT * FROM uploads WHERE id = ?').get(id);
    return row ? toRow(row) : undefined;
  }

  /** 磁盘绝对路径（harness 的 `composePrompt` 引用的就是它）。 */
  filePath(id: string, mediaType: string, name: string, dir: string = this.dir): string {
    return path.join(dir, `${id}${extOf(mediaType, name)}`);
  }

  /** 行的实际落盘目录：行里记了就用行里的，否则全局默认。 */
  private dirOf(row: Pick<UploadRow, 'dir'>): string {
    return row.dir ?? this.dir;
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
        path: this.filePath(row.id, row.mediaType, row.name, this.dirOf(row)),
      });
    }
    return out;
  }

  /** 按行里记的媒体类型反查文件（serve 用；行不存在 / 文件被删 = undefined）。 */
  fileStatOf(id: string): { row: UploadRow; file: string; size: number } | undefined {
    const row = this.getById(id);
    if (!row) return undefined;
    const file = this.filePath(row.id, row.mediaType, row.name, this.dirOf(row));
    if (!existsSync(file)) return undefined;
    return { row, file, size: statSync(file).size };
  }

  /** 按行里记的媒体类型反查文件（serve 用；行不存在 / 文件被删 = undefined）。 */
  fileOf(id: string): { row: UploadRow; bytes: Buffer } | undefined {
    const row = this.getById(id);
    if (!row) return undefined;
    const file = this.filePath(row.id, row.mediaType, row.name, this.dirOf(row));
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
        `SELECT id, media_type, name, dir FROM uploads
          WHERE created_at <= ? AND id NOT IN (SELECT upload_id FROM event_images)`,
      )
      .all(new Date(now - olderThanMs).toISOString()) as Array<{
      id: string;
      media_type: string;
      name: string;
      dir: string | null;
    }>;
    const del = this.db.prepare('DELETE FROM uploads WHERE id = ?');
    for (const row of rows) {
      rmSync(this.filePath(row.id, row.media_type, row.name, row.dir ?? this.dir), { force: true });
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

  /**
   * 某会话随附的上传件（去重；设置页「按对话清理」的统计与删除都用它）。
   * 返回 null = 会话没有任何随附件（与空数组区分，前端好出「无可清理」）。
   */
  uploadsBySession(sessionId: string): UploadRow[] | null {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT u.* FROM event_images e
           JOIN uploads u ON u.id = e.upload_id
           JOIN hook_events h ON h.id = e.event_id
          WHERE h.session_id = ?
          ORDER BY u.created_at`,
      )
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.length === 0 ? null : rows.map(toRow);
  }

  /**
   * 某会话随附上传件按图/文件分档的小账（会话行展开钻取的头部）。
   * null = 该会话没有任何随附件。
   */
  sessionBreakdown(sessionId: string): {
    images: { count: number; bytes: number };
    files: { count: number; bytes: number };
  } | null {
    const rows = this.db
      .prepare(
        `SELECT u.media_type AS mediaType, COUNT(DISTINCT u.id) AS n, SUM(u.size) AS bytes
           FROM event_images e
             JOIN uploads u ON u.id = e.upload_id
             JOIN hook_events h ON h.id = e.event_id
          WHERE h.session_id = ?
          GROUP BY u.media_type`,
      )
      .all(sessionId) as Array<{ mediaType: string; n: number; bytes: number }>;
    if (rows.length === 0) return null;
    let images = { count: 0, bytes: 0 };
    for (const r of rows) {
      if (isImageMediaType(String(r.mediaType))) {
        images = { count: images.count + Number(r.n), bytes: images.bytes + Number(r.bytes) };
      }
    }
    const total = { count: rows.reduce((s, r) => s + Number(r.n), 0), bytes: rows.reduce((s, r) => s + Number(r.bytes), 0) };
    return { images, files: { count: total.count - images.count, bytes: total.bytes - images.bytes } };
  }

  /** 各会话随附上传件的总量（设置页「按对话清理」的列表面）：一次聚合，不逐会话查。 */
  usageBySession(): Array<{ sessionId: string; count: number; bytes: number }> {
    const rows = this.db
      .prepare(
        `SELECT h.session_id AS sessionId, COUNT(DISTINCT u.id) AS count, COALESCE(SUM(u.size), 0) AS bytes
           FROM event_images e
           JOIN uploads u ON u.id = e.upload_id
           JOIN hook_events h ON h.id = e.event_id
          GROUP BY h.session_id
          ORDER BY bytes DESC`,
      )
      .all() as Array<{ sessionId: string; count: number; bytes: number }>;
    return rows.map((r) => ({ sessionId: String(r.sessionId), count: Number(r.count), bytes: Number(r.bytes) }));
  }

  /**
   * 删一批上传件（文件 + 行）。返回实际清掉的条数——行已不在（重复清理 /
   * 内容寻址撞行）的跳过，文件尽力删。
   */
  removeMany(ids: readonly string[]): number {
    const del = this.db.prepare('DELETE FROM uploads WHERE id = ?');
    let removed = 0;
    for (const id of ids) {
      const row = this.getById(id);
      if (!row) continue;
      rmSync(this.filePath(row.id, row.mediaType, row.name, this.dirOf(row)), { force: true });
      removed += Number(del.run(id).changes);
    }
    return removed;
  }

  /**
   * 无引用上传件的统计（设置页「一键清理」的预告面）：只数过了宽限期的——
   * 刚拖进来还没发出去的那份不算可清，报了数就得真能清掉这么多。
   */
  unreferencedStats(graceMs: number = UPLOAD_CLEANUP_GRACE_MS, now: number = Date.now()): {
    count: number;
    bytes: number;
  } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM uploads
          WHERE created_at <= ? AND id NOT IN (SELECT upload_id FROM event_images)`,
      )
      .get(new Date(now - graceMs).toISOString()) as { n: number; bytes: number };
    return { count: Number(row.n), bytes: Number(row.bytes) };
  }

  /**
   * 存储总览（设置页清理面头部的账）：一次聚合出总/图/文件/被引用/可安全清五档，
   * 不逐档各查一遍。`unreferenced` 与 `unreferencedStats` 同口径（过宽限期的才算）。
   */
  overview(graceMs: number = UPLOAD_CLEANUP_GRACE_MS, now: number = Date.now()): {
    total: { count: number; bytes: number };
    images: { count: number; bytes: number };
    files: { count: number; bytes: number };
    referenced: { count: number; bytes: number };
    unreferenced: { count: number; bytes: number };
  } {
    const cutoff = new Date(now - graceMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes,
                COALESCE(SUM(CASE WHEN media_type IN ('image/png','image/jpeg','image/gif','image/webp') THEN size ELSE 0 END), 0) AS imgBytes,
                COALESCE(SUM(CASE WHEN media_type IN ('image/png','image/jpeg','image/gif','image/webp') THEN 1 ELSE 0 END), 0) AS imgN,
                COALESCE(SUM(CASE WHEN id IN (SELECT upload_id FROM event_images) THEN size ELSE 0 END), 0) AS refBytes,
                COALESCE(SUM(CASE WHEN id IN (SELECT upload_id FROM event_images) THEN 1 ELSE 0 END), 0) AS refN,
                COALESCE(SUM(CASE WHEN created_at <= ? AND id NOT IN (SELECT upload_id FROM event_images) THEN size ELSE 0 END), 0) AS unrefBytes,
                COALESCE(SUM(CASE WHEN created_at <= ? AND id NOT IN (SELECT upload_id FROM event_images) THEN 1 ELSE 0 END), 0) AS unrefN
           FROM uploads`,
      )
      .get(cutoff, cutoff) as Record<string, unknown>;
    const total = { count: Number(row.n), bytes: Number(row.bytes) };
    const images = { count: Number(row.imgN), bytes: Number(row.imgBytes) };
    return {
      total,
      images,
      files: { count: total.count - images.count, bytes: total.bytes - images.bytes },
      referenced: { count: Number(row.refN), bytes: Number(row.refBytes) },
      unreferenced: { count: Number(row.unrefN), bytes: Number(row.unrefBytes) },
    };
  }

  /**
   * 一键清掉无引用上传件（文件 + 行），逐条回调进度（设置页的清理进度条）。
   * 宽限期内的不动（同 `pruneUnreferenced` 的口径，只是期限更短）。
   */
  cleanupUnreferenced(
    onProgress: (done: number, total: number) => void,
    graceMs: number = UPLOAD_CLEANUP_GRACE_MS,
    now: number = Date.now(),
  ): number {
    const rows = this.db
      .prepare(
        `SELECT id, media_type, name, dir FROM uploads
          WHERE created_at <= ? AND id NOT IN (SELECT upload_id FROM event_images)`,
      )
      .all(new Date(now - graceMs).toISOString()) as Array<{
      id: string;
      media_type: string;
      name: string;
      dir: string | null;
    }>;
    const del = this.db.prepare('DELETE FROM uploads WHERE id = ?');
    let removed = 0;
    for (const row of rows) {
      rmSync(this.filePath(row.id, row.media_type, row.name, row.dir ?? this.dir), { force: true });
      removed += Number(del.run(row.id).changes);
      onProgress(removed, rows.length);
    }
    return removed;
  }
}

function toRow(raw: Record<string, unknown>): UploadRow {
  return {
    id: String(raw.id),
    mediaType: String(raw.media_type),
    name: String(raw.name),
    size: Number(raw.size),
    createdAt: String(raw.created_at),
    dir: raw.dir == null ? null : String(raw.dir),
  };
}
