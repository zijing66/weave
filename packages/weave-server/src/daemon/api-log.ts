import type { IncomingMessage, ServerResponse } from 'node:http';
import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { getApiLogsDir } from '../db/paths.js';

/**
 * 接口日志：每个 HTTP 请求落一行 JSON（按本地小时切文件，只留最近 24 个）。
 * 写入恒走异步串行链、失败静默——日志不许拖慢或打断请求路径。出入参先截断脱敏
 * 再落盘（超长字段换占位符、凭据类键打码），行保持 JSON 可解析。
 */

/** 单侧出入参捕获上限（字节）：超了整段换占位符。 */
const CAPTURE_BYTES = 8 * 1024;
const MAX_STR = 2_000;
const MAX_ARR = 50;
const MAX_DEPTH = 6;
/** 保留的小时文件数（= 24 小时）。 */
export const MAX_LOG_FILES = 24;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1_000;

/** 凭据类键：值一律 `[redacted]`（日志是落盘面，绝不落真值）。 */
const REDACT_KEYS = new Set([
  'password',
  'apikey',
  'token',
  'secret',
  'authorization',
  'cookie',
  'x-weave-local',
]);

export interface ApiLogEntry {
  ts: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  ip: string;
  ua?: string;
  req?: unknown;
  res?: unknown;
  resBytes?: number;
  stream?: boolean;
  aborted?: boolean;
}

export interface ApiLogQuery {
  from?: string;
  to?: string;
  path?: string;
  method?: string;
  status?: number;
  limit?: number;
}

/** 超长/过深换占位符，凭据键打码；结果仍是可 JSON.stringify 的结构。 */
function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STR ? `[truncated ${value.length} chars]` : value;
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return '[depth-limited]';
    const out = value.slice(0, MAX_ARR).map((v) => scrub(v, depth + 1));
    if (value.length > MAX_ARR) out.push(`[truncated ${value.length - MAX_ARR} items]`);
    return out;
  }
  if (value && typeof value === 'object') {
    if (depth >= MAX_DEPTH) return '[depth-limited]';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

function shapeBody(captured: string, totalBytes: number): unknown {
  if (totalBytes > CAPTURE_BYTES) return `[truncated body ${totalBytes} bytes]`;
  try {
    return scrub(JSON.parse(captured));
  } catch {
    return scrub(captured);
  }
}

/** 本地小时戳文件名：`api-YYYY-MM-DDTHH.jsonl`。 */
export function logFileFor(dir: string, at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(at.getHours())}`;
  return path.join(dir, `api-${stamp}.jsonl`);
}

function hourOf(file: string): string | null {
  const m = path.basename(file).match(/^api-(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/);
  return m ? m[1]! : null;
}

/** 请求体旁路（readBody 收完流时上报）：登记的是**逐请求**闭包，并发请求各记各的。 */
const bound = new WeakMap<IncomingMessage, (text: string) => void>();

export function noteRequestBody(req: IncomingMessage, text: string): void {
  bound.get(req)?.(text);
}

export class ApiLogger {
  private readonly dir: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: { dir?: string } = {}) {
    this.dir = opts.dir ?? getApiLogsDir();
  }

  /** 挂上计时与响应捕获；响应收尾（finish/abort）即落一行。 */
  begin(req: IncomingMessage, res: ServerResponse): void {
    const start = Date.now();
    const chunks: Buffer[] = [];
    let captured = 0;
    let resBytes = 0;
    let reqText = '';
    let reqBytes = 0;
    let done = false;

    bound.set(req, (text: string) => {
      reqText = text;
      reqBytes = Buffer.byteLength(text, 'utf8');
    });

    const capture = (chunk: unknown): void => {
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(typeof chunk === 'string' ? chunk : String(chunk ?? ''), 'utf8');
      resBytes += buf.length;
      if (captured < CAPTURE_BYTES) {
        const take = buf.subarray(0, CAPTURE_BYTES - captured);
        chunks.push(take);
        captured += take.length;
      }
    };
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    // writeHead 直写网络、不进 getHeader 缓存——content-type 从这里旁路记一份。
    let headType = '';
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = ((...args: unknown[]) => {
      const headers = args[1];
      if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
        const rec = headers as Record<string, unknown>;
        const t = rec['content-type'] ?? rec['Content-Type'];
        if (typeof t === 'string') headType = t;
      }
      return (origWriteHead as (...a: unknown[]) => unknown)(...args);
    }) as typeof res.writeHead;
    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      capture(chunk);
      return (origWrite as (...a: unknown[]) => unknown)(chunk, ...rest);
    }) as typeof res.write;
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (typeof chunk !== 'function' && chunk != null) capture(chunk);
      return (origEnd as (...a: unknown[]) => unknown)(chunk, ...rest);
    }) as typeof res.end;

    const finish = (): void => {
      if (done) return;
      done = true;
      const ctype = String(res.getHeader('content-type') ?? '') || headType;
      const stream = ctype.includes('event-stream');
      const entry: ApiLogEntry = {
        ts: new Date(start).toISOString(),
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        status: res.statusCode,
        durationMs: Date.now() - start,
        ip: (req.socket?.remoteAddress ?? '').replace(/^::ffff:/, ''),
        resBytes,
      };
      const ua = req.headers['user-agent'];
      if (typeof ua === 'string' && ua) entry.ua = ua.slice(0, 120);
      if (reqBytes) entry.req = shapeBody(reqText, reqBytes);
      if (stream) entry.stream = true;
      else if (resBytes) entry.res = shapeBody(Buffer.concat(chunks).toString('utf8'), resBytes);
      if (!res.writableEnded) entry.aborted = true;
      this.write(logFileFor(this.dir, new Date(start)), `${JSON.stringify(entry)}\n`);
    };
    res.on('finish', finish);
    res.on('close', finish);
  }

  /** 落盘恒异步：串行链保序，失败静默（日志不打扰请求路径）。 */
  private write(file: string, line: string): void {
    this.chain = this.chain.then(async () => {
      try {
        await mkdir(this.dir, { recursive: true });
        await appendFile(file, line, 'utf8');
        await this.purge();
      } catch {
        // 日志写失败不回抛
      }
    });
  }

  /** 只留最近 MAX_LOG_FILES 个小时文件（按文件名小时序）。 */
  private async purge(): Promise<void> {
    const names = (await readdir(this.dir)).filter((n) => hourOf(n) != null);
    if (names.length <= MAX_LOG_FILES) return;
    names.sort();
    for (const old of names.slice(0, names.length - MAX_LOG_FILES)) {
      await rm(path.join(this.dir, old), { force: true });
    }
  }

  /** 测试/关停用：等在写的链落地。 */
  onIdle(): Promise<void> {
    return this.chain;
  }

  /** 只读查询：按小时文件倒序扫，过滤后截到 limit。 */
  async query(q: ApiLogQuery): Promise<{ entries: ApiLogEntry[]; files: number }> {
    const names = (await readdir(this.dir).catch(() => [] as string[]))
      .filter((n) => hourOf(n) != null)
      .sort()
      .reverse();
    const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const from = q.from ? Date.parse(q.from) : NaN;
    const to = q.to ? Date.parse(q.to) : NaN;
    const entries: ApiLogEntry[] = [];
    for (const name of names) {
      if (entries.length >= limit) break;
      const text = await readFile(path.join(this.dir, name), 'utf8').catch(() => '');
      for (const line of text.split('\n').reverse()) {
        if (!line.trim()) continue;
        let entry: ApiLogEntry;
        try {
          entry = JSON.parse(line) as ApiLogEntry;
        } catch {
          continue;
        }
        const at = Date.parse(entry.ts);
        if (Number.isFinite(from) && at < from) continue;
        if (Number.isFinite(to) && at > to) continue;
        if (q.status != null && entry.status !== q.status) continue;
        if (q.method && entry.method.toUpperCase() !== q.method.toUpperCase()) continue;
        if (q.path && !entry.path.includes(q.path)) continue;
        entries.push(entry);
        if (entries.length >= limit) break;
      }
    }
    return { entries, files: names.length };
  }
}
