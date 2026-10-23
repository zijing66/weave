import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getTmpDir } from '../db/paths.js';

/**
 * 分块上传的会话态（断点续传）：客户端按 offset 顺序追加字节，服务端只认
 * 「下一块必须接在当前长度上」；偏移对不上就把真实长度回给客户端续传。
 *
 * 落点是 `cache/tmp/uploads/<id>.part` + 同名 `.json`（名字/类型/总长/已收）——
 * 半截文件是**可弃产物**，不进 `data/`，也不进库；只有 finish 收尾时才由
 * `UploadRepository.adoptFromFile` 算 sha256 搬进正式落点。
 *
 * 写入 = **预分配 + 位置写**：begin 就把 `.part` 撑到声明总长（簇/稀疏预留随
 * 文件系统），append 按偏移写进常开的句柄——内存里永远只有当前这一块，不整份
 * 攒缓冲。已收长度记在 meta（预分配后 `stat.size` 是总长不是进度）；写完截回
 * 真实长度，半途中断的 `.part` 不虚占磁盘。正式落点只经 rename 出现（tmp→改名，
 * 不会有一半的正式文件）。
 */

export interface UploadSession {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  received: number;
}

export type AppendResult =
  | { kind: 'ok'; received: number }
  | { kind: 'conflict'; received: number }
  | { kind: 'overflow'; received: number }
  | { kind: 'missing' };

/** 半截件的保留期：比「用户离开页面又回来」长得多，又不至于攒垃圾。 */
export const UPLOAD_SESSION_MAX_AGE_MS = 24 * 60 * 60_000;

const ID_RE = /^[0-9a-f-]{36}$/;

export class UploadSessions {
  /** 常开的写句柄（id → handle）：位置写不复位游标，块与块之间不重开文件。 */
  private readonly handles = new Map<string, import('node:fs/promises').FileHandle>();

  constructor(private readonly dir: string = path.join(getTmpDir(), 'uploads')) {}

  private part(id: string): string {
    return path.join(this.dir, `${id}.part`);
  }

  private meta(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async begin(input: { name: string; mediaType: string; size: number }): Promise<UploadSession> {
    await mkdir(this.dir, { recursive: true });
    const id = randomUUID();
    await writeFile(
      this.meta(id),
      JSON.stringify({ name: input.name, mediaType: input.mediaType, size: input.size, received: 0 }),
      'utf8',
    );
    // 预分配：'w' 建档，句柄常开——后续块按偏移往里写，块间不重开文件
    const handle = await open(this.part(id), 'w');
    await handle.truncate(input.size);
    this.handles.set(id, handle);
    return { id, ...input, received: 0 };
  }

  /** 已有会话的当前进度（续传入口）。不存在/坏 meta = null。 */
  async get(id: string): Promise<UploadSession | null> {
    if (!ID_RE.test(id)) return null;
    try {
      const meta = JSON.parse(await readFile(this.meta(id), 'utf8')) as {
        name?: unknown;
        mediaType?: unknown;
        size?: unknown;
        received?: unknown;
      };
      if (typeof meta.name !== 'string' || typeof meta.mediaType !== 'string' || typeof meta.size !== 'number') {
        return null;
      }
      // 已收长度记在 meta（预分配后 stat.size = 总长）；旧版半截件没有该字段，回落 stat
      const received =
        typeof meta.received === 'number' ? meta.received : (await stat(this.part(id))).size;
      return { id, name: meta.name, mediaType: meta.mediaType, size: meta.size, received };
    } catch {
      return null;
    }
  }

  /** 顺序追加一块：offset ≠ 当前长度 = 客户端拿着旧偏移，回真实长度让它续。 */
  async append(id: string, offset: number, bytes: Buffer): Promise<AppendResult> {
    const cur = await this.get(id);
    if (!cur) return { kind: 'missing' };
    if (offset !== cur.received) return { kind: 'conflict', received: cur.received };
    if (cur.received + bytes.length > cur.size) return { kind: 'overflow', received: cur.received };
    let handle = this.handles.get(id);
    if (!handle) {
      // daemon 重启后半截件还在：重开句柄续写（'r+'，文件已由 begin 预分配）
      handle = await open(this.part(id), 'r+');
      this.handles.set(id, handle);
    }
    const received = cur.received + bytes.length;
    await handle.write(bytes, 0, bytes.length, offset);
    // 截回真实长度：预分配多撑的部分不跟着半截件过夜
    await handle.truncate(received);
    await writeFile(
      this.meta(id),
      JSON.stringify({ name: cur.name, mediaType: cur.mediaType, size: cur.size, received }),
      'utf8',
    );
    return { kind: 'ok', received };
  }

  /** 收尾：交出临时件路径与元数据；临时件由调用方搬走后删。 */
  async finish(id: string): Promise<{ name: string; mediaType: string; file: string; size: number } | null> {
    const cur = await this.get(id);
    if (!cur) return null;
    if (cur.received !== cur.size) return null; // 还差字节：不假装收完
    return { name: cur.name, mediaType: cur.mediaType, file: this.part(id), size: cur.size };
  }

  /** 丢弃（客户端取消 / 收尾搬完）。 */
  async abort(id: string): Promise<void> {
    if (!ID_RE.test(id)) return;
    await this.handles.get(id)?.close().catch(() => undefined);
    this.handles.delete(id);
    await rm(this.part(id), { force: true });
    await rm(this.meta(id), { force: true });
  }

  /** 过期半截件回收（与孤儿上传件同轮）。返回清掉的条数。 */
  async sweep(olderThanMs: number = UPLOAD_SESSION_MAX_AGE_MS, now: number = Date.now()): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      try {
        const s = await stat(this.meta(id));
        if (now - s.mtimeMs < olderThanMs) continue;
        await this.abort(id);
        removed++;
      } catch {
        // 竞态：枚举与 stat 之间被删/搬走
      }
    }
    return removed;
  }
}

/** 进程内默认落点（daemon 只有一个；测试用 `deps.uploadSessions` 注入临时目录）。 */
export const defaultUploadSessions = new UploadSessions();
