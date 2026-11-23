import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { rgPath } from '@vscode/ripgrep';
import type { WeaveServerDeps } from '../server.js';
import { sendJson } from '../http.js';
import { matchPaths, peekCachedIndex } from '../project-files.js';

/**
 * 全局搜索（dashboard Ctrl+K）：会话名 + 聊天记录 + 项目文件三路聚合，一次请求
 * 全回（前端一次防抖一枪，不拆三个）。全部只读旁路查询——不碰 ingest、不建索引、
 * 不加 SSE；文件路只窥视就绪的索引（peekCachedIndex），冷项目跳过不阻塞。
 */

/** 每路结果上限（前端三组各渲染几条足够；更多靠细化关键词）。 */
const LIMIT_SESSIONS = 8;
const LIMIT_MESSAGES = 12;
const LIMIT_FILES_PER_PROJECT = 6;
const LIMIT_FILES_TOTAL = 18;

/** 文件路认陈旧快照的窗：文件名索引陈一天照样能用（git 指纹仍核），10 分钟硬窗
 *  是「粘贴认引用」的保真口径——不放宽它，搜索时快照基本全过期、文件路恒空。 */
const FILE_INDEX_MAX_STALE_MS = 24 * 60 * 60_000;

/** 聊天命中的展示窗口：命中点前后各留这么多字符（正文可能几千字，只给看得到的）。 */
const MESSAGE_CONTEXT_CHARS = 80;

/** rg 单文件命中上限与单枪超时（转录普遍 100MB+，实测 178MB 亚秒级——不设
 *  filesize 门：门只会静默把大会话排除出搜索）。 */
const RG_MAX_COUNT = 3;
const RG_TIMEOUT_MS = 8_000;
/** 单枪 argv 里的文件数上限（Windows 命令行 ~32k 字符，路径各百来字，256 稳妥）。 */
const RG_BATCH = 256;

/** transcriptSearch 依赖切片。 */
type SearchDeps = Pick<WeaveServerDeps, 'sessionProbe'> & {
  hookEvents: NonNullable<WeaveServerDeps['hookEvents']>;
  hookSessions: NonNullable<WeaveServerDeps['hookSessions']>;
};

export interface SearchMessageHit {
  eventId: number;
  sessionId: string | null;
  projectId: number;
  source: string;
  eventType: string;
  at: string;
  /** 命中窗口（命中点前后各 MESSAGE_CONTEXT_CHARS 字符；不足即全文）。 */
  text: string;
  /** 命中起点在 `text` 内的偏移（前端高亮用）。 */
  offset: number;
  /** 正文比窗口长（前端提示「截断」）。 */
  clipped: boolean;
}

export interface SearchFileHit {
  projectId: number;
  path: string;
  kind: 'file' | 'dir';
  /** 命中区间（对 `path` 而言），复用 PathHit 的形状。 */
  ranges: [number, number][];
}

export interface SearchResponse {
  q: string;
  sessions: Array<{ sessionId: string; projectId: number | null; title: string | null }>;
  messages: SearchMessageHit[];
  files: SearchFileHit[];
  truncated: { messages: boolean; files: boolean };
}

export async function handleSearchRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
  url: URL,
): Promise<boolean> {
  if (pathname !== '/search' || req.method !== 'GET') return false;
  if (!deps.hookEvents || !deps.hookSessions) {
    sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
    return true;
  }
  const q = (url.searchParams.get('q') ?? '').trim();
  sendJson(res, 200, await globalSearch(deps as Parameters<typeof globalSearch>[0], q));
  return true;
}

/**
 * 聊天转录路：`@vscode/ripgrep` 直扫已知转录路径集（完整原文，SQL LIKE 只搜得
 * 到 capFields 裁后的 4KB 残文）。清单 = 探针内存账 ∪ 库里最近登记的（daemon
 * 重启后内存账空，靠库账兜）；路径都是 hook 旁路上报的，非用户输入；分批防
 * argv 超限。null = rg 不可用（回落 SQL）。
 */
async function transcriptSearch(
  deps: SearchDeps,
  q: string,
): Promise<SearchMessageHit[] | null> {
  const byPath = new Map<string, { sessionId: string; projectId: number }>();
  const seed = (path: string, sessionId: string): void => {
    const key = normPath(path);
    if (byPath.has(key)) return;
    const session = deps.hookSessions.getBySessionId(sessionId);
    byPath.set(key, { sessionId, projectId: session?.projectId ?? -1 });
  };
  for (const { sessionId, path } of deps.hookEvents.recentTranscriptPaths()) seed(path, sessionId);
  for (const [sessionId, path] of deps.sessionProbe?.knownTranscripts() ?? []) seed(path, sessionId);
  if (byPath.size === 0) return null;
  const files = [...byPath.keys()];
  const hits: SearchMessageHit[] = [];
  for (let i = 0; i < files.length && hits.length < LIMIT_MESSAGES; i += RG_BATCH) {
    const out = await rgOnce(q, files.slice(i, i + RG_BATCH)).catch(() => null);
    if (out === null) return null; // rg 不可用：整路回落（不做半路混源）
    for (const line of out) {
      const hit = hitFromRgLine(byPath, line);
      if (hit) hits.push(hit);
      if (hits.length >= LIMIT_MESSAGES) break;
    }
  }
  return hits;
}

/** 路径归一（分隔符 + 大小写）——hook 上报反斜杠、rg 输出正斜杠，同文件两副面孔。 */
function normPath(p: string): string {
  return p.replaceAll('\\', '/').toLowerCase();
}

/** 一枪 rg：`--json` 流式取匹配行。失败（spawn 错/超时/退出码 >1）→ null。 */
function rgOnce(q: string, files: string[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    const child = spawn(
      rgPath,
      ['--json', '-i', '--max-count', String(RG_MAX_COUNT), '-e', q, ...files],
      { windowsHide: true },
    );
    let buf = '';
    const lines: string[] = [];
    const done = (v: string[] | null): void => {
      child.removeAllListeners();
      clearTimeout(timer);
      try { child.kill(); } catch { /* 已退出 */ }
      resolve(v);
    };
    const timer = setTimeout(() => done(null), RG_TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let at: number;
      while ((at = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 1);
        if (line.includes('"type":"match"')) lines.push(line);
      }
    });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 || code === 1 ? lines : null));
  });
}

interface RgMatch {
  data: {
    path: { text: string };
    line_number: number;
    lines: { text: string };
    submatches: Array<{ match: { text: string }; start: number; end: number }>;
  };
}

/** 一行 rg --json 输出 → 命中（文件清单账反查会话定位；正文裁窗口）。 */
function hitFromRgLine(
  byPath: Map<string, { sessionId: string; projectId: number }>,
  raw: string,
): SearchMessageHit | null {
  let m: RgMatch;
  try {
    m = JSON.parse(raw) as RgMatch;
  } catch {
    return null;
  }
  const d = m.data;
  const file = d?.path?.text;
  const text = d?.lines?.text ?? '';
  if (!file || !text.trim()) return null;
  // 转录行是整行 JSONL——命中窗口取 submatch 前后各一段，别把整行（可能几 MB）给前端
  const first = d?.submatches?.[0];
  const at = first ? first.start : 0;
  const start = Math.max(0, at - MESSAGE_CONTEXT_CHARS);
  const end = Math.min(text.length, at + (first ? first.match.text.length : 0) + MESSAGE_CONTEXT_CHARS);
  const loc = byPath.get(normPath(file));
  return {
    eventId: -1,
    sessionId: loc?.sessionId ?? null,
    projectId: loc?.projectId ?? -1,
    source: normPath(file).includes('/.claude/') ? 'claude' : 'codex',
    eventType: 'transcript',
    at: '',
    text: text.slice(start, end).trimEnd(),
    offset: at - start,
    clipped: start > 0 || end < text.length,
  };
}

/** 全局搜索查询核（HTTP 路由与联邦 call `search` 服务共用；caller 范围由 ALS 裁）。 */
export async function globalSearch(
  deps: Pick<WeaveServerDeps, 'projects' | 'sessionProbe'> & {
    hookEvents: NonNullable<WeaveServerDeps['hookEvents']>;
    hookSessions: NonNullable<WeaveServerDeps['hookSessions']>;
  },
  q: string,
): Promise<SearchResponse> {
  if (!q) {
    return {
      q,
      sessions: [],
      messages: [],
      files: [],
      truncated: { messages: false, files: false },
    };
  }

  // 会话名 + 聊天记录：聊天路先走 rg 扫转录（完整原文、比 SQL LIKE 快一个量级），
  // rg 不可用（二进制缺失/被杀软拦/超时）回落 SQL LIKE（capFields 残文）。
  const [sessions, textHits] = await Promise.all([
    deps.hookSessions.searchByTitle(q, LIMIT_SESSIONS),
    transcriptSearch(deps, q).then(
      (hits) => hits ?? deps.hookEvents.searchConversationTexts(q, LIMIT_MESSAGES),
    ),
  ]);

  // 项目文件：逐项目窥视就绪索引（不触发重建），并行匹配；冷项目跳过。
  const projects = deps.projects.list().filter((p) => !p.archivedAt);
  const perProject = await Promise.all(
    projects.map(async (p) => {
      const index = await peekCachedIndex(p.id, p.path, { maxStaleMs: FILE_INDEX_MAX_STALE_MS });
      if (!index) return [];
      const { hits } = await matchPaths(index, q, LIMIT_FILES_PER_PROJECT, '');
      return hits.map(
        (h): SearchFileHit => ({ projectId: p.id, path: h.path, kind: h.kind, ranges: h.ranges }),
      );
    }),
  );
  const files = perProject.flat().slice(0, LIMIT_FILES_TOTAL);

  return {
    q,
    sessions: sessions.map((s) => ({ sessionId: s.sessionId, projectId: s.projectId, title: s.title })),
    messages: textHits.map((h) => windowOf(h, q)),
    files,
    truncated: {
      messages: textHits.length >= LIMIT_MESSAGES,
      files: files.length >= LIMIT_FILES_TOTAL,
    },
  };
}

/** 命中窗口截取：命中点前后各留 MESSAGE_CONTEXT_CHARS 字符（首次命中为准）。 */
function windowOf(
  hit: import('../../repositories/hook-events.js').ConversationTextHit,
  q: string,
): SearchMessageHit {
  const lower = hit.text.toLowerCase();
  const at = lower.indexOf(q.toLowerCase());
  if (at < 0 || hit.text.length <= MESSAGE_CONTEXT_CHARS * 2) {
    return {
      eventId: hit.eventId,
      sessionId: hit.sessionId,
      projectId: hit.projectId,
      source: hit.source,
      eventType: hit.eventType,
      at: hit.at,
      text: hit.text,
      offset: Math.max(at, 0),
      clipped: false,
    };
  }
  const start = Math.max(0, at - MESSAGE_CONTEXT_CHARS);
  const end = Math.min(hit.text.length, at + q.length + MESSAGE_CONTEXT_CHARS);
  return {
    eventId: hit.eventId,
    sessionId: hit.sessionId,
    projectId: hit.projectId,
    source: hit.source,
    eventType: hit.eventType,
    at: hit.at,
    text: hit.text.slice(start, end),
    offset: at - start,
    clipped: start > 0 || end < hit.text.length,
  };
}
