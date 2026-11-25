/** 搜索域：全局 Ctrl+K 的四路聚合（会话名 / 聊天记录 / 文件名 / 文件内容）
 *  + 聊天命中的上下文预览。查询语法解析在服务端（search-query.ts）——web 只
 *  拼查询串（chips/下拉 → `in:xxx project:n` 形），不解析语义。 */

import { apiFetch } from './client';

/** 一条聊天正文命中（服务端已截好命中窗口）。 */
export interface SearchMessageHit {
  eventId: number;
  sessionId: string | null;
  projectId: number;
  source: string;
  eventType: string;
  at: string;
  text: string;
  /** 命中起点在 `text` 内的偏移。 */
  offset: number;
  /** 正文比窗口长。 */
  clipped: boolean;
}

/** 一条文件路径命中（`ranges` = 命中区间，对 `path` 而言）。 */
export interface SearchFileHit {
  projectId: number;
  path: string;
  kind: 'file' | 'dir';
  ranges: [number, number][];
}

/** 一条文件内容命中（rg 直扫项目目录；mirror of routes/search.ts）。 */
export interface SearchContentHit {
  projectId: number;
  /** 相对项目根、正斜杠。 */
  path: string;
  line: number;
  text: string;
  offset: number;
  clipped: boolean;
}

export interface SearchResult {
  q: string;
  sessions: Array<{ sessionId: string; projectId: number | null; title: string | null }>;
  messages: SearchMessageHit[];
  files: SearchFileHit[];
  content: SearchContentHit[];
  truncated: { messages: boolean; files: boolean; content: boolean };
}

/** 聊天命中的上下文预览（GET /search/context；mirror of routes/search.ts）。 */
export interface MessageContextResult {
  projectId: number;
  sessionId: string;
  q: string;
  /** false = 未在会话事件链中定位到该消息（前端降级只显示搜索窗口文本）。 */
  anchored: boolean;
  messages: Array<{ id: number; role: 'user' | 'assistant'; at: string; text: string; hit: boolean }>;
}

export const searchApi = {
  /** 四路聚合一次回；`signal` 透传给 fetch（防抖新一波掐上一波）。 */
  searchAll: (q: string, signal?: AbortSignal): Promise<SearchResult> =>
    apiFetch<SearchResult>(`/search?q=${encodeURIComponent(q)}`, signal ? { signal } : {}),
  /** 聊天命中的上下文预览（弹层行内展开用）。 */
  messageContext: (
    params: { projectId: number; sessionId: string; q: string },
    signal?: AbortSignal,
  ): Promise<MessageContextResult> => {
    const qs = new URLSearchParams({
      projectId: String(params.projectId),
      sessionId: params.sessionId,
      q: params.q,
    });
    return apiFetch<MessageContextResult>(`/search/context?${qs}`, signal ? { signal } : {});
  },
};
