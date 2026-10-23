/**
 * 带进度与断点续传的文件上传（分块 PUT）。协议在服务端 `daemon/upload-sessions.ts`：
 * `POST /uploads/begin` → `PUT /uploads/:id?offset=N`（裸字节）→ `POST /uploads/:id/finish`。
 * 断点记在 sessionStorage（键 = 名字+大小+修改时刻）：刷新页面后再拖同一个文件，
 * 从服务端已收长度接着传；临时件过期（404）就从头再来一次。
 */

import { API_BASE, type UploadFile } from './api';

/** 一块的大小：小到弱网重传不心疼（512MB 上限下也就几百块），大到进度条有得动。 */
const CHUNK_BYTES = 1024 * 1024;
const RESUME_PREFIX = 'weave:upload:';

function resumeKeyOf(file: File): string {
  return `${RESUME_PREFIX}${file.name}:${file.size}:${file.lastModified}`;
}

interface ResumePoint {
  id: string;
}

function readResume(key: string): ResumePoint | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ResumePoint>;
    return typeof parsed.id === 'string' ? { id: parsed.id } : null;
  } catch {
    return null;
  }
}

function writeResume(key: string, point: ResumePoint | null): void {
  try {
    if (point) sessionStorage.setItem(key, JSON.stringify(point));
    else sessionStorage.removeItem(key);
  } catch {
    // 隐私模式/配额满：只是丢了跨刷新续传，本次上传照常
  }
}

async function errorOf(res: Response): Promise<string> {
  const body = await res.text();
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
  } catch {
    // 非 JSON
  }
  return body ? `${res.status} ${body}` : String(res.status);
}

async function jsonOf<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as T;
}

/** 一块的 PUT：用 XHR 是为了拿 `upload.onprogress`（fetch 没有上传进度）。 */
function putChunk(
  id: string,
  offset: number,
  body: Blob,
  onProgress: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<{ received: number }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    const onAbort = (): void => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    xhr.open('PUT', `${API_BASE}/uploads/${id}?offset=${offset}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onloadend = () => signal?.removeEventListener('abort', onAbort);
    xhr.onload = () => {
      let parsed: { received?: number; error?: string } = {};
      try {
        parsed = JSON.parse(xhr.responseText) as typeof parsed;
      } catch {
        // 非 JSON（代理层错误页）
      }
      if (xhr.status === 200 && typeof parsed.received === 'number') {
        resolve({ received: parsed.received });
      } else if (xhr.status === 409 && typeof parsed.received === 'number') {
        // 服务端已收长度与我们的偏移对不上：交给调用方续传
        resolve({ received: parsed.received });
      } else {
        reject(new Error(parsed.error ?? `${xhr.status} ${xhr.responseText}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    xhr.send(body);
  });
}

/**
 * 上传一个文件：`onProgress` 收 0..1 的整体进度（含断点续传跳过的部分）。
 * 失败直接抛（调用方把错误挂在文件图标上）。
 */
export async function uploadFileWithProgress(
  file: File,
  onProgress: (ratio: number) => void,
  opts: { signal?: AbortSignal } = {},
): Promise<UploadFile> {
  const key = resumeKeyOf(file);
  const mediaType = file.type || 'application/octet-stream';
  let id: string | null = null;
  let offset = 0;

  const prior = readResume(key);
  if (prior) {
    try {
      const cur = await jsonOf<{ received: number; size: number; name: string; mediaType: string }>(
        `/uploads/${prior.id}`,
      );
      if (cur.name === file.name && cur.size === file.size) {
        id = prior.id;
        offset = Math.min(cur.received, file.size);
      }
    } catch {
      // 临时件已被回收：当作没有半截
    }
  }

  if (!id) {
    const begun = await jsonOf<{ uploadId: string; received: number }>('/uploads/begin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: file.name, mediaType, size: file.size }),
    });
    id = begun.uploadId;
    offset = begun.received;
    writeResume(key, { id });
  }

  onProgress(file.size === 0 ? 1 : offset / file.size);

  while (offset < file.size) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const end = Math.min(offset + CHUNK_BYTES, file.size);
    const at = offset;
    let next: number;
    try {
      next = (
        await putChunk(
          id,
          at,
          file.slice(at, end),
          (loaded) => {
            onProgress(Math.min(1, (at + loaded) / file.size));
          },
          opts.signal,
        )
      ).received;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      // 临时件没了（服务端回收/重启）：从头来一次，不无限重试
      const retry = await fetch(`${API_BASE}/uploads/${id}`, { method: 'GET' }).catch(() => null);
      if (retry && retry.status === 404) {
        writeResume(key, null);
        throw new Error('Upload expired; please retry');
      }
      throw err;
    }
    if (next === at) throw new Error('Upload stalled');
    offset = next;
    onProgress(Math.min(1, offset / file.size));
  }

  const done = await jsonOf<{ upload: UploadFile }>(`/uploads/${id}/finish`, { method: 'POST' });
  writeResume(key, null);
  onProgress(1);
  return done.upload;
}

/** 丢弃半截件（用户把文件从附件条上撤掉时；尽力而为）。 */
export function discardUpload(file: File): void {
  const key = resumeKeyOf(file);
  const prior = readResume(key);
  writeResume(key, null);
  if (prior) void fetch(`${API_BASE}/uploads/${prior.id}`, { method: 'DELETE' }).catch(() => undefined);
}
