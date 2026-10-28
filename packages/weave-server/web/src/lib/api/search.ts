/** 搜索域：全局 Ctrl+K 的三路聚合（会话名 / 聊天记录 / 项目文件）。 */

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

export interface SearchResult {
  q: string;
  sessions: Array<{ sessionId: string; projectId: number | null; title: string | null }>;
  messages: SearchMessageHit[];
  files: SearchFileHit[];
  truncated: { messages: boolean; files: boolean };
}

export const searchApi = {
  /** 三路聚合一次回；`signal` 透传给 fetch（防抖新一波掐上一波）。 */
  searchAll: (q: string, signal?: AbortSignal): Promise<SearchResult> =>
    apiFetch<SearchResult>(`/search?q=${encodeURIComponent(q)}`, signal ? { signal } : {}),
};
