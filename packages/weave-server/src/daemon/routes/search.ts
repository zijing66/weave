import type { IncomingMessage, ServerResponse } from 'node:http';
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
  if (!q) {
    sendJson(res, 200, {
      q,
      sessions: [],
      messages: [],
      files: [],
      truncated: { messages: false, files: false },
    } satisfies SearchResponse);
    return true;
  }

  // 会话名 + 聊天记录：两条 SQL 并行（各自毫秒级~几十毫秒）。
  const [sessions, textHits] = await Promise.all([
    deps.hookSessions.searchByTitle(q, LIMIT_SESSIONS),
    deps.hookEvents.searchConversationTexts(q, LIMIT_MESSAGES),
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

  sendJson(res, 200, {
    q,
    sessions: sessions.map((s) => ({ sessionId: s.sessionId, projectId: s.projectId, title: s.title })),
    messages: textHits.map((h) => windowOf(h, q)),
    files,
    truncated: {
      messages: textHits.length >= LIMIT_MESSAGES,
      files: files.length >= LIMIT_FILES_TOTAL,
    },
  } satisfies SearchResponse);
  return true;
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
