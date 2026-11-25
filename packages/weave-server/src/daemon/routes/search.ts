import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { rgPath } from '@vscode/ripgrep';
import type { WeaveServerDeps } from '../server.js';
import { sendJson } from '../http.js';
import { matchPaths, peekCachedIndex } from '../project-files.js';
import { parseSearchQuery, type ParsedQuery } from '../search-query.js';

/**
 * 全局搜索（dashboard Ctrl+K）：会话名 + 聊天记录 + 项目文件名 + 文件内容四路
 * 聚合，一次请求全回（前端一次防抖一枪，不拆四个）。查询语法解析归
 * search-query.ts 一处（本路由与联邦 call `search` 共用；纯文本查询行为不变）。
 * 全部只读旁路查询——不碰 ingest、不建索引、不加 SSE；文件名路只窥视就绪的
 * 索引（peekCachedIndex），冷项目跳过不阻塞。
 */

/** 每路结果上限（前端各组各渲染几条足够；更多靠细化关键词）。 */
const LIMIT_SESSIONS = 8;
const LIMIT_MESSAGES = 12;
const LIMIT_FILES_PER_PROJECT = 6;
const LIMIT_FILES_TOTAL = 18;
const LIMIT_CONTENT_PER_PROJECT = 4;
const LIMIT_CONTENT_TOTAL = 12;

/** 文件路认陈旧快照的窗：文件名索引陈一天照样能用（git 指纹仍核），10 分钟硬窗
 *  是「粘贴认引用」的保真口径——不放宽它，搜索时快照基本全过期、文件路恒空。 */
const FILE_INDEX_MAX_STALE_MS = 24 * 60 * 60_000;

/** 聊天命中的展示窗口：命中点前后各留这么多字符（正文可能几千字，只给看得到的）。 */
const MESSAGE_CONTEXT_CHARS = 80;

/** rg 单文件命中上限与两档单枪超时（转录普遍 100MB+，实测 178MB 亚秒级；项目
 *  目录内容扫逐项目限时，慢项目不拖其他项目）。 */
const RG_MAX_COUNT = 3;
const RG_TIMEOUT_MS = 8_000;
const RG_CONTENT_TIMEOUT_MS = 3_000;
/** 单枪 argv 里的文件数上限（Windows 命令行 ~32k 字符，路径各百来字，256 稳妥）。 */
const RG_BATCH = 256;

/** 内容扫排除目录（与 project-files.ts 的 SKIP_DIRS 同清单——文件浏览器看得
 *  到的文件与内容路搜得到的文件同一口径）。 */
const CONTENT_EXCLUDE_GLOBS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'target',
  'coverage',
  '.turbo',
].map((d) => `!${d}/**`);

/** 预览上下文的锚点前后各取几条消息。 */
const CONTEXT_AROUND = 3;

/** transcriptSearch / contentSearch 依赖切片。 */
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

/** 一条文件内容命中（rg 直扫项目目录；path 相对项目根、正斜杠）。 */
export interface SearchContentHit {
  projectId: number;
  path: string;
  line: number;
  /** 命中行窗口（命中点前后各 MESSAGE_CONTEXT_CHARS 字符）。 */
  text: string;
  /** 命中起点在 `text` 内的偏移（前端高亮用）。 */
  offset: number;
  /** 行比窗口长。 */
  clipped: boolean;
}

export interface SearchResponse {
  q: string;
  sessions: Array<{ sessionId: string; projectId: number | null; title: string | null }>;
  messages: SearchMessageHit[];
  files: SearchFileHit[];
  content: SearchContentHit[];
  truncated: { messages: boolean; files: boolean; content: boolean };
}

export async function handleSearchRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
  url: URL,
): Promise<boolean> {
  if (!deps.hookEvents || !deps.hookSessions) {
    sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
    return true;
  }
  if (pathname === '/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').trim();
    sendJson(res, 200, await globalSearch(deps as Parameters<typeof globalSearch>[0], q));
    return true;
  }
  // 聊天命中的上下文预览（弹层行内展开；服务端按事件链现场找，web 不解事件语义）。
  if (pathname === '/search/context' && req.method === 'GET') {
    const projectId = Number(url.searchParams.get('projectId'));
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const q = (url.searchParams.get('q') ?? '').trim();
    if (!Number.isInteger(projectId) || projectId <= 0 || !sessionId || !q) {
      sendJson(res, 400, { error: 'projectId, sessionId and q are required' });
      return true;
    }
    sendJson(res, 200, messageContext(deps as SearchDeps, projectId, sessionId, q));
    return true;
  }
  return false;
}

/** 多词 AND 的过滤判据：每词都命中且不含任一排除词（大小写不敏感）。 */
function linePasses(needle: string, terms: readonly string[], excludes: readonly string[]): boolean {
  const lower = needle.toLowerCase();
  return (
    terms.every((t) => lower.includes(t.toLowerCase())) &&
    !excludes.some((x) => lower.includes(x.toLowerCase()))
  );
}

/**
 * 聊天转录路：`@vscode/ripgrep` 直扫已知转录路径集（完整原文，SQL LIKE 只搜得
 * 到 capFields 裁后的 4KB 残文）。清单 = 探针内存账 ∪ 库里最近登记的（daemon
 * 重启后内存账空，靠库账兜）；路径都是 hook 旁路上报的，非用户输入；分批防
 * argv 超限。多词 = rg OR 收候选 + JS 逐行 AND（rg 多 -e 是 OR，正则层做不了
 * AND）。session/project 过滤在 seed 阶段做（不属过滤集的文件不进 rg）。
 * null = rg 不可用（回落 SQL）。
 */
async function transcriptSearch(
  deps: SearchDeps,
  parsed: ParsedQuery,
): Promise<SearchMessageHit[] | null> {
  const sessionIds = await resolveSessionFilter(deps, parsed);
  const byPath = new Map<string, { sessionId: string; projectId: number }>();
  const seed = (path: string, sessionId: string): void => {
    const key = normPath(path);
    if (byPath.has(key)) return;
    if (sessionIds && !sessionIds.has(sessionId)) return;
    const session = deps.hookSessions.getBySessionId(sessionId);
    const projectId = session?.projectId ?? -1;
    if (parsed.projectId != null && projectId !== parsed.projectId) return;
    byPath.set(key, { sessionId, projectId });
  };
  for (const { sessionId, path } of deps.hookEvents.recentTranscriptPaths()) seed(path, sessionId);
  for (const [sessionId, path] of deps.sessionProbe?.knownTranscripts() ?? []) seed(path, sessionId);
  if (byPath.size === 0) return null;
  const files = [...byPath.keys()];
  const terms = parsed.terms;
  const argvTerms = terms.flatMap((t) => ['-e', t]);
  const hits: SearchMessageHit[] = [];
  for (let i = 0; i < files.length && hits.length < LIMIT_MESSAGES; i += RG_BATCH) {
    const out = await rgOnce(
      ['--json', '-i', '--max-count', String(RG_MAX_COUNT), ...argvTerms, ...files.slice(i, i + RG_BATCH)],
      RG_TIMEOUT_MS,
    ).catch(() => null);
    if (out === null) return null; // rg 不可用：整路回落（不做半路混源）
    for (const line of out) {
      const hit = hitFromRgLine(byPath, line, terms);
      if (hit && linePasses(hit.text, terms, parsed.excludes)) hits.push(hit);
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
function rgOnce(args: string[], timeoutMs: number): Promise<string[] | null> {
  return new Promise((resolve) => {
    const child = spawn(rgPath, args, { windowsHide: true });
    let buf = '';
    const lines: string[] = [];
    const done = (v: string[] | null): void => {
      child.removeAllListeners();
      clearTimeout(timer);
      try { child.kill(); } catch { /* 已退出 */ }
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
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

/** 命中窗口截取（命中点前后各 MESSAGE_CONTEXT_CHARS 字符，首次命中为准）。 */
function clipWindow(text: string, at: number, matchLen: number): { text: string; offset: number; clipped: boolean } {
  const start = Math.max(0, at - MESSAGE_CONTEXT_CHARS);
  const end = Math.min(text.length, at + matchLen + MESSAGE_CONTEXT_CHARS);
  return {
    text: text.slice(start, end).trimEnd(),
    offset: at - start,
    clipped: start > 0 || end < text.length,
  };
}

/** 一行 rg --json 输出 → 命中（文件清单账反查会话定位；正文裁窗口）。
 *  多词 AND：terms 非单词时逐行 JS 复核（rg OR 只收候选）。 */
function hitFromRgLine(
  byPath: Map<string, { sessionId: string; projectId: number }>,
  raw: string,
  terms: readonly string[] = [],
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
  const win = clipWindow(text, at, first ? first.match.text.length : 0);
  if (terms.length > 1 && !linePasses(text, terms, [])) return null;
  const loc = byPath.get(normPath(file));
  return {
    eventId: -1,
    sessionId: loc?.sessionId ?? null,
    projectId: loc?.projectId ?? -1,
    source: normPath(file).includes('/.claude/') ? 'claude' : 'codex',
    eventType: 'transcript',
    at: '',
    ...win,
  };
}

/** session: 过滤值 → sessionId 集（id 形精确一发；标题形搜候选取集）。
 *  null = 无会话过滤。标题形零候选返回空集（结果必空，不是不过滤）。 */
async function resolveSessionFilter(
  deps: SearchDeps,
  parsed: ParsedQuery,
): Promise<Set<string> | null> {
  if (parsed.sessionId) return new Set([parsed.sessionId]);
  if (!parsed.sessionTitle) return null;
  const rows = deps.hookSessions.searchByTitle(parsed.sessionTitle, 50);
  return new Set(rows.map((r) => r.sessionId));
}

/** project: 过滤值 → 允许的项目 id 集（name 对项目名/path 末段小写包含）。
 *  null = 无项目过滤；空集 = 过滤词没命中任何项目（结果必空）。 */
function resolveProjectFilter(
  projects: Array<{ id: number; name: string; path: string }>,
  parsed: ParsedQuery,
): Set<number> | null {
  if (parsed.projectId != null) return new Set([parsed.projectId]);
  if (!parsed.projectName) return null;
  const needle = parsed.projectName.toLowerCase();
  const out = new Set<number>();
  for (const p of projects) {
    if (p.name.toLowerCase().includes(needle) || p.path.replaceAll('\\', '/').split('/').pop()?.toLowerCase().includes(needle)) {
      out.add(p.id);
    }
  }
  return out;
}

/** 项目内容扫单项目命中上限内的一枪 rg。失败/超时/目录缺席 → 空。 */
async function contentSearchProject(
  root: string,
  projectId: number,
  terms: readonly string[],
  excludes: readonly string[],
): Promise<SearchContentHit[]> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];
  const argvTerms = terms.flatMap((t) => ['-e', t]);
  const out = await rgOnce(
    [
      '--json',
      '-i',
      '--max-count',
      String(RG_MAX_COUNT),
      '--glob',
      `!{${CONTENT_EXCLUDE_GLOBS.map((g) => g.slice(1)).join(',')}}`,
      ...argvTerms,
      root,
    ],
    RG_CONTENT_TIMEOUT_MS,
  ).catch(() => null);
  if (out === null) return [];
  const hits: SearchContentHit[] = [];
  for (const raw of out) {
    let m: RgMatch;
    try {
      m = JSON.parse(raw) as RgMatch;
    } catch {
      continue;
    }
    const d = m.data;
    const file = d?.path?.text;
    const text = d?.lines?.text ?? '';
    if (!file || !text.trim()) continue;
    if (terms.length > 1 && !linePasses(text, terms, [])) continue;
    const first = d?.submatches?.[0];
    const at = first ? first.start : 0;
    const win = clipWindow(text, at, first ? first.match.text.length : 0);
    if (!linePasses(win.text, terms, excludes)) continue;
    hits.push({
      projectId,
      path: path.relative(root, file).replaceAll('\\', '/'),
      line: d.line_number ?? 0,
      ...win,
    });
    if (hits.length >= LIMIT_CONTENT_PER_PROJECT) break;
  }
  return hits;
}

/** 文件内容路：逐项目 rg 扫项目根（排除口径与文件浏览器 SKIP_DIRS 同清单）。
 *  并发全开（项目数几十级），总量早停。 */
async function contentSearch(
  projects: Array<{ id: number; path: string }>,
  terms: readonly string[],
  excludes: readonly string[],
): Promise<SearchContentHit[]> {
  if (terms.length === 0) return [];
  const perProject = await Promise.all(
    projects.map((p) => contentSearchProject(p.path, p.id, terms, excludes)),
  );
  return perProject.flat().slice(0, LIMIT_CONTENT_TOTAL);
}

/** 聊天命中上下文预览：按会话事件链现场找含 q 的对话条目，回其前后各
 *  CONTEXT_AROUND 条（role 由开/闭轮类型判）。找不到（转录内容 DB 没有）
 *  → anchored:false，前端降级显示搜索窗口文本。 */
function messageContext(deps: SearchDeps, projectId: number, sessionId: string, q: string) {
  const events = deps.hookEvents.listBySession(sessionId, 300);
  const needle = q.toLowerCase();
  const conv = events
    .map((e) => {
      let payload: { raw?: { prompt?: unknown; last_assistant_message?: unknown } };
      try {
        payload = JSON.parse(String(e.payload)) as typeof payload;
      } catch {
        return null;
      }
      const text = strOf(payload.raw?.prompt) ?? strOf(payload.raw?.last_assistant_message);
      if (text == null) return null;
      const isUser = text === strOf(payload.raw?.prompt);
      return { id: e.id, eventType: e.eventType, at: e.createdAt, text, role: isUser ? ('user' as const) : ('assistant' as const) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const hitAt = conv.findIndex((m) => m.text.toLowerCase().includes(needle));
  if (hitAt < 0) return { projectId, sessionId, q, anchored: false, messages: [] };
  const start = Math.max(0, hitAt - CONTEXT_AROUND);
  const end = Math.min(conv.length, hitAt + CONTEXT_AROUND + 1);
  return {
    projectId,
    sessionId,
    q,
    anchored: true,
    messages: conv.slice(start, end).map((m) => ({ ...m, hit: conv.indexOf(m) === hitAt })),
  };
}

function strOf(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** 全局搜索查询核（HTTP 路由与联邦 call `search` 服务共用；caller 范围由 ALS 裁）。 */
export async function globalSearch(
  deps: Pick<WeaveServerDeps, 'projects' | 'sessionProbe'> & {
    hookEvents: NonNullable<WeaveServerDeps['hookEvents']>;
    hookSessions: NonNullable<WeaveServerDeps['hookSessions']>;
  },
  q: string,
): Promise<SearchResponse> {
  const empty: SearchResponse = {
    q,
    sessions: [],
    messages: [],
    files: [],
    content: [],
    truncated: { messages: false, files: false, content: false },
  };
  const parsed = parseSearchQuery(q);
  // 无词（空 q 或只有过滤词）：过滤词没有可搜的主体，直接空（首版不定义列举语义）。
  if (!q || parsed.terms.length === 0) return empty;

  const projects = deps.projects.list().filter((p) => !p.archivedAt);
  const projectFilter = resolveProjectFilter(projects, parsed);
  const sessionFilter = await resolveSessionFilter(deps as SearchDeps, parsed);
  const allowedProjects = projectFilter
    ? projects.filter((p) => projectFilter.has(p.id))
    : projects;
  if (projectFilter !== null && projectFilter.size === 0) return empty;
  if (sessionFilter !== null && sessionFilter.size === 0) return empty;

  const main = parsed.text;
  // 会话名 + 聊天记录 + 文件内容：聊天路先走 rg 扫转录（完整原文、比 SQL LIKE
  // 快一个量级），rg 不可用（二进制缺失/被杀软拦/超时）回落 SQL LIKE（残文）。
  const sessions = parsed.scopes.sessions
    ? deps.hookSessions
        .searchByTitle(main, LIMIT_SESSIONS)
        .filter(
          (s) =>
            (projectFilter === null || (s.projectId != null && projectFilter.has(s.projectId))) &&
            (sessionFilter === null || sessionFilter.has(s.sessionId)),
        )
    : [];
  const [textHits, content] = await Promise.all([
    parsed.scopes.messages
      ? transcriptSearch(deps as SearchDeps, parsed).then(
          (hits) =>
            hits ??
            deps.hookEvents
              .searchConversationTexts(main, LIMIT_MESSAGES)
              .filter(
                (h) =>
                  (projectFilter === null || projectFilter.has(h.projectId)) &&
                  (sessionFilter === null || (h.sessionId != null && sessionFilter.has(h.sessionId))) &&
                  linePasses(h.text, parsed.terms, parsed.excludes),
              )
              .map((h) => windowOf(h, parsed.terms)),
        )
      : Promise.resolve([]),
    parsed.scopes.content ? contentSearch(allowedProjects, parsed.terms, parsed.excludes) : Promise.resolve([]),
  ]);

  // 项目文件：逐项目窥视就绪索引（不触发重建），并行匹配；冷项目跳过。
  const perProject = parsed.scopes.files
    ? await Promise.all(
        allowedProjects.map(async (p) => {
          const index = await peekCachedIndex(p.id, p.path, { maxStaleMs: FILE_INDEX_MAX_STALE_MS });
          if (!index) return [];
          const { hits } = await matchPaths(index, main, LIMIT_FILES_PER_PROJECT, '');
          return hits
            .filter((h) => linePasses(h.path, parsed.terms, parsed.excludes))
            .map(
              (h): SearchFileHit => ({ projectId: p.id, path: h.path, kind: h.kind, ranges: h.ranges }),
            );
        }),
      )
    : [];
  const files = perProject.flat().slice(0, LIMIT_FILES_TOTAL);

  return {
    q,
    sessions: sessions.map((s) => ({ sessionId: s.sessionId, projectId: s.projectId, title: s.title })),
    messages: textHits,
    files,
    content,
    truncated: {
      messages: textHits.length >= LIMIT_MESSAGES,
      files: files.length >= LIMIT_FILES_TOTAL,
      content: content.length >= LIMIT_CONTENT_TOTAL,
    },
  };
}

/** SQL 路命中的窗口截取：terms 全词 AND 已由 linePasses 复核过，这里按首个
 *  命中词定位窗口（命中点前后各留 MESSAGE_CONTEXT_CHARS 字符）。 */
function windowOf(
  hit: import('../../repositories/hook-events.js').ConversationTextHit,
  terms: readonly string[],
): SearchMessageHit {
  const lower = hit.text.toLowerCase();
  let at = -1;
  let len = 0;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) {
      at = i;
      len = t.length;
    }
  }
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
  const end = Math.min(hit.text.length, at + len + MESSAGE_CONTEXT_CHARS);
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
