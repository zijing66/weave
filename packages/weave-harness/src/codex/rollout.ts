import { mkdir, open as openFile, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LogHealth, LogPollOptions, LogRecord, LogSource } from '../driver.js';
import { CodexTurnBuffer, metaOfLine, type CodexLine } from './event-source.js';
import { readUserCapture } from './capture.js';
import { codexHome } from './home.js';

/**
 * codex 的会话采集：**尾读 rollout JSONL**（`logs` 槽的唯一实现）。
 *
 * codex 没有按项目可用的 hook / notify 面（`notify` 是全局单命令、拿不到项目维度），
 * 但它把每个会话 durable 地写在 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`。
 * 会话身份 = 首行 `session_meta.session_id`（文件名里的 uuid 同值）。实测 `codex resume`
 * **接着写同一个文件**（`ordinal` 续号、不重发 `session_meta`），但子线程 / 归档仍可能
 * 让一个 id 跨多个文件，故游标按**文件字节偏移**记、不假设一 id 一文件。
 *
 * 卷控三道：白名单（只认 `event_msg` 的几类行，见 `CodexTurnBuffer`）、单行上限、
 * 单拍预算；回填只给刚发现的文件一个尾窗，几个月前的老会话只登记不读。
 */

/** 单行上限：实测最大单行 4.98MB（一条塞满上下文的 user_message），再大的行不解析。 */
const MAX_LINE_CHARS = 512 * 1024;
/** 首次发现一个老文件时的回填窗（daemon 关着时跑的那段能看到，更早的不翻）。 */
const TAIL_WINDOW_BYTES = 256 * 1024;
/** 「正在长」判据：2 分钟内写过且不大 → 从 0 读（刚开的会话一条不漏）。 */
const FRESH_MS = 2 * 60_000;
const FRESH_MAX_BYTES = 1024 * 1024;
/** 更老的日志文件只登记不读。 */
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** 单拍预算缺省值（到顶返回，下一拍续）。 */
const DEFAULT_MAX_RECORDS = 400;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
/** 读文件头拿 `session_meta` 的窗口（该行实测 ~22KB，`base_instructions` 排在 cwd 之后）。 */
const HEAD_BYTES = 128 * 1024;

const CURSOR_FILE = 'cursors.json';
const LOCK_FILE = '.lock';
/** 心跳节流：持有者每拍都刷 mtime 是每秒一次无谓写盘。 */
const LOCK_TOUCH_MS = 60_000;

interface FileState {
  /** 已消费到的字节偏移（恒落在行边界）。 */
  offset: number;
  sessionId: string | null;
  /** `session_meta` 的工作目录；不在白名单 = 这个文件不采。 */
  cwd: string | null;
}

interface CursorState {
  at: string | null;
  files: Record<string, FileState>;
}

interface RolloutFile {
  path: string;
  size: number;
  mtimeMs: number;
}


/** 日志根下的两个会话目录（归档会话也读：`archived_sessions/` 是同一批文件挪过去的）。 */
function sessionRoots(): string[] {
  const home = codexHome();
  return [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
}

/** 路径比对键：win32 大小写不敏感，POSIX 不。 */
function dirKey(dir: string): string {
  const abs = path.resolve(dir);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function parseJsonLine(text: string): CodexLine | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as CodexLine;
  } catch {
    return null;
  }
}

async function listRollouts(): Promise<RolloutFile[]> {
  const out: RolloutFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不在（本机没跑过 codex / 还没归档过）就不采
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      const st = await stat(abs).catch(() => null);
      if (st) out.push({ path: abs, size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  for (const root of sessionRoots()) await walk(root, 0);
  return out;
}

/**
 * 读文件头一行拿会话身份（老文件也只需要开头一截）。
 * `'pending'` = 首行还没写完（文件刚创建、半行未落的竞态窗口），下一拍重试；
 * `null` = 真读不出身份（头一行超窗 / 坏行），登记后永不采。
 */
async function readMeta(
  filePath: string,
): Promise<{ sessionId: string; cwd: string | null } | 'pending' | null> {
  const handle = await openFile(filePath, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const newline = text.indexOf('\n');
    // 窗口没读满还没有换行 = 文件就这么大且首行未完（半行 / 空，多半还在写）；
    // 窗口读满仍无换行才是头一行真超窗
    if (newline < 0) return bytesRead < HEAD_BYTES ? 'pending' : null;
    const line = parseJsonLine(text.slice(0, newline));
    return line ? metaOfLine(line) : null;
  } finally {
    await handle.close();
  }
}

async function readChunk(filePath: string, offset: number, length: number): Promise<{ text: string; bytes: number } | null> {
  const handle = await openFile(filePath, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, offset);
    return { text: buf.subarray(0, bytesRead).toString('utf8'), bytes: bytesRead };
  } finally {
    await handle.close();
  }
}

async function readState(dir: string): Promise<CursorState> {
  try {
    const raw = await readFile(path.join(dir, CURSOR_FILE), 'utf8');
    const value = JSON.parse(raw) as CursorState;
    if (value && typeof value === 'object' && value.files && typeof value.files === 'object') {
      return value;
    }
  } catch {
    // 首次 / 文件损坏：从空状态起（重采一次比猜强）
  }
  return { at: null, files: {} };
}

async function writeState(dir: string, state: CursorState): Promise<void> {
  state.at = new Date().toISOString();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, CURSOR_FILE), JSON.stringify(state));
}

/** 锁里的 pid 还活着吗（`EPERM` = 活着只是不归我们管）。 */
function pidAlive(pid: string): boolean {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

/**
 * 单实例锁：dev-entry 与 start 可能共用同一份数据目录与库，不锁就会双写同一批
 * 事件（会话里一条消息出现两遍）。持有者按 pid 认自己，下一拍只刷心跳；别人活着
 * 就让开，死了／pid 认不出即接管（daemon 被 kill 时锁文件留在盘上）。
 */
async function acquireLock(dir: string): Promise<boolean> {
  await mkdir(dir, { recursive: true });
  const lockPath = path.join(dir, LOCK_FILE);
  const mine = `${process.pid}`;
  try {
    await writeFile(lockPath, mine, { flag: 'wx' });
    return true;
  } catch {
    // 已存在：往下判归属
  }
  const holder = (await readFile(lockPath, 'utf8').catch(() => '')).trim();
  if (holder === mine) {
    const st = await stat(lockPath).catch(() => null);
    if (!st || Date.now() - st.mtimeMs > LOCK_TOUCH_MS) {
      const now = new Date();
      await utimes(lockPath, now, now).catch(() => {});
    }
    return true;
  }
  if (holder && pidAlive(holder)) return false;
  return writeFile(lockPath, mine).then(
    () => true,
    () => false,
  );
}

/** hook 接管判据的缓存窗：hooks.json 不会在 10s 里反复变，每秒读一遍是白读。 */
const CAPTURE_CHECK_MS = 10_000;

export class CodexLogSource implements LogSource {
  readonly harness = 'codex' as const;
  /** 每文件的行转换器（含「本轮最终 assistant 消息」缓存，必须跨拍留着）。 */
  private readonly buffers = new Map<string, CodexTurnBuffer>();
  private lastError: string | null = null;
  private capture: { root: string; at: number; on: boolean } | null = null;

  /**
   * 采集装上就由 hooks 主供事件——rollout 再读一遍，同一条用户输入 / 回合收尾会
   * 入库两次。但 hooks 的 SessionStart 是**懒触发**（首条消息才发，实测 0.164），
   * 「TUI 开着还没说话」的会话 hooks 一条都不发，rollout 若也让位，这段窗口里
   * 会话列表就没有行。故让位是**部分的**：capture 已装时只采 `session_meta`
   * （会话启动信号，hooks 懒触发期间唯一漏掉的行型），其余行型照旧让位。
   * codex 还没信任 hooks 的那段时间看不到任何 hook 事件——那不是本槽的锅，
   * `scriptHealth` 与 `weave doctor` 是明说这一点的诊断面。
   */
  private async captureInstalled(): Promise<boolean> {
    const now = Date.now();
    const root = codexHome();
    if (this.capture && this.capture.root === root && now - this.capture.at < CAPTURE_CHECK_MS) {
      return this.capture.on;
    }
    const on = (await readUserCapture()).installed;
    this.capture = { root, at: now, on };
    return on;
  }

  async poll(options: LogPollOptions): Promise<LogRecord[]> {
    const captureOn = await this.captureInstalled();
    if (!(await acquireLock(options.stateDir))) return [];
    const files = (await listRollouts()).sort((a, b) => a.mtimeMs - b.mtimeMs);
    const state = await readState(options.stateDir);
    if (files.length === 0 && Object.keys(state.files).length === 0) return [];
    // 键 → 原文：命中回原文，调用方不必再做平台相关的大小写归一
    const whitelist = new Map(options.cwdWhitelist.map((dir) => [dirKey(dir), dir]));
    const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    let budget = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const out: LogRecord[] = [];
    let dirty = false;

    for (const file of files) {
      if (out.length >= maxRecords || budget <= 0) break;
      let entry = state.files[file.path];
      /** 从尾窗进来时首块可能落在行中间，那半行要丢掉。 */
      let partial = false;
      if (!entry) {
        const meta = await readMeta(file.path);
        if (meta === 'pending') continue; // 半行未落：什么都不记，下一拍重试
        if (!meta) {
          // 读不到身份（头一行超窗 / 坏行）：登记但永不采，不每拍重试
          state.files[file.path] = { offset: file.size, sessionId: null, cwd: null };
          dirty = true;
          continue;
        }
        entry = { offset: 0, sessionId: meta.sessionId, cwd: meta.cwd };
        state.files[file.path] = entry;
        dirty = true;
        if (Date.now() - file.mtimeMs > MAX_AGE_MS) {
          entry.offset = file.size; // 几个月前的老会话：登记但不读（之后再长起来照常采）
        } else if (Date.now() - file.mtimeMs < FRESH_MS && file.size < FRESH_MAX_BYTES) {
          entry.offset = 0; // 刚开的会话：从头读，一条不漏
        } else {
          entry.offset = Math.max(0, file.size - TAIL_WINDOW_BYTES);
          partial = true;
        }
      }
      const projectCwd = entry.cwd ? whitelist.get(dirKey(entry.cwd)) : undefined;
      if (!projectCwd) {
        // 不在白名单：记住「此刻到此为止」但不读（项目后加入白名单从此刻起采，不回填）
        if (entry.offset !== file.size) {
          entry.offset = file.size;
          dirty = true;
        }
        continue;
      }
      if (file.size < entry.offset) {
        // 文件被换掉 / 截断：从头再来（本轮的缓存也一并作废）
        entry.offset = 0;
        partial = false;
        this.buffers.delete(file.path);
        dirty = true;
      }
      if (file.size === entry.offset) continue;

      const chunk = await readChunk(file.path, entry.offset, Math.min(file.size - entry.offset, budget));
      if (!chunk) {
        this.lastError = `read failed: ${file.path}`;
        continue;
      }
      budget -= chunk.bytes;
      let text = chunk.text;
      let cursor = entry.offset;
      if (partial) {
        const newline = text.indexOf('\n');
        if (newline < 0) {
          entry.offset = cursor + chunk.bytes; // 整块都在半行里：跳过
          dirty = true;
          continue;
        }
        cursor += Buffer.byteLength(text.slice(0, newline + 1), 'utf8');
        text = text.slice(newline + 1);
      }
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline < 0) {
        if (text.length > MAX_LINE_CHARS) {
          // 一条装满上下文的巨型行：整块丢掉（不重读同一处卡死）
          entry.offset = cursor + chunk.bytes;
          this.lastError = `oversized line skipped: ${path.basename(file.path)}`;
          dirty = true;
        }
        continue;
      }
      // 游标**逐行**推进：预算到顶时剩下的行必须留给下一拍（一次跳到文件尾等于静默丢事件）
      let consumed = cursor;
      const buffer = this.bufferOf(file.path);
      for (const raw of text.slice(0, lastNewline).split('\n')) {
        if (out.length >= maxRecords) break;
        consumed += Buffer.byteLength(raw, 'utf8') + 1;
        if (!raw || raw.length > MAX_LINE_CHARS) continue;
        const line = parseJsonLine(raw);
        if (!line) continue;
        // capture 已装时只认 session_meta（hooks 懒触发漏掉的启动信号）；
        // 其余行型归 hooks，读了就重复。buffer 的轮内缓存（last agent message）
        // 因此缺料也无妨——那些行型本就不产出。
        if (captureOn && line.type !== 'session_meta') continue;
        const report = buffer.report(line);
        if (!report) continue;
        report.sessionId = entry.sessionId ?? undefined;
        report.cwd = projectCwd;
        out.push({ report, at: atOfLine(line, file.mtimeMs) });
      }
      entry.offset = consumed;
      dirty = true;
    }

    // 攒着不用的条目（文件已删 / 会话被归档后删掉）顺手清掉，游标文件不随时间胀大
    const live = new Set(files.map((f) => f.path));
    for (const key of Object.keys(state.files)) {
      if (live.has(key)) continue;
      delete state.files[key];
      this.buffers.delete(key);
      dirty = true;
    }

    if (dirty) await writeState(options.stateDir, state).catch(() => {});
    return out;
  }

  async health(options: { stateDir: string }): Promise<LogHealth> {
    const state = await readState(options.stateDir);
    const root = codexHome();
    let files = 0;
    for (const entry of Object.values(state.files)) if (entry.cwd) files++;
    return { root, files, lastPollAt: state.at, lastError: this.lastError };
  }

  private bufferOf(filePath: string): CodexTurnBuffer {
    let buffer = this.buffers.get(filePath);
    if (!buffer) {
      buffer = new CodexTurnBuffer();
      this.buffers.set(filePath, buffer);
    }
    return buffer;
  }
}

/** 事件真实时刻：行自带时间戳优先，缺了用文件 mtime（回填历史不能印成插入时刻）。 */
function atOfLine(line: CodexLine, mtimeMs: number): string {
  if (typeof line.timestamp === 'string' && line.timestamp) {
    const parsed = Date.parse(line.timestamp);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(mtimeMs).toISOString();
}

export const CODEX_LOG_SOURCE: LogSource = new CodexLogSource();
