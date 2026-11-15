import { statSync } from 'node:fs';
import path from 'node:path';
import { parseVisualizationRef, VISUALIZATION_PROTOCOL } from '@weavecode/core';

/** 一条引用行（原文 + fragment 绝对路径）。 */
export interface VisualRef {
  /** 引用行原文：注入时原样照抄，绝不重新生成、规范化或裁剪。 */
  line: string;
  path: string;
  at: string;
}

/**
 * 文本里的渲染块引用行（行级判据唯一实现 = core `parseVisualizationRef`，与
 * web `visualizeSegments` 同源）。行内空白先 trim——屏上复制来的行常带尾空格。
 */
export function visualizeRefsIn(text: string): Array<{ line: string; path: string }> {
  const out: Array<{ line: string; path: string }> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const ref = parseVisualizationRef(trimmed);
    if (ref) out.push({ line: trimmed, path: path.resolve(ref.path) });
  }
  return out;
}

/** 引用行 → fragment 绝对路径（fragment 端点用）。 */
export function visualizePathsIn(text: string): string[] {
  return visualizeRefsIn(text).map((ref) => ref.path);
}

function stopTextOf(row: { payload: string }): string | null {
  try {
    const payload = JSON.parse(row.payload) as { raw?: { last_assistant_message?: unknown } };
    const text = payload.raw?.last_assistant_message;
    return typeof text === 'string' && text.trim() ? text : null;
  } catch {
    return null;
  }
}

/**
 * 会话最近一次「展示过渲染块」的最终回复：从最新 Stop 往前翻，取第一条带引用行
 * 的文本。本轮没写引用行不覆盖上一轮学到的（粘性）——否则 mirror 只要因别的
 * 由头重写（规则变更、改名、daemon 重启），续投就会凭空断掉。
 */
export function lastStopTextOf(
  hookEvents: {
    listBySession(
      sessionId: string,
      limit?: number,
      beforeId?: number,
      types?: readonly string[],
    ): Array<{ id: number; payload: string }>;
  },
  sessionId: string,
  pageSize = 50,
  maxPages = 20,
): string | null {
  let beforeId: number | undefined;
  for (let page = 0; page < maxPages; page++) {
    const rows = hookEvents.listBySession(sessionId, pageSize, beforeId, ['Stop']);
    if (rows.length === 0) return null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const text = stopTextOf(rows[i]!);
      if (text && visualizeRefsIn(text).length > 0) return text;
    }
    beforeId = rows[0]!.id;
  }
  return null;
}

/**
 * 会话最终回复里仍然可用的渲染块引用：取最后一条，且 fragment 必须还在、
 * 不超过端点同款上限（文件被删 = 不再展示，也就不再续投）。
 */
export function activeVisualRefOf(
  text: string,
  at = new Date().toISOString(),
): VisualRef | null {
  const refs = visualizeRefsIn(text);
  const last = refs[refs.length - 1];
  if (!last) return null;
  try {
    const stat = statSync(last.path);
    if (!stat.isFile() || stat.size > VISUALIZATION_PROTOCOL.maxFragmentBytes) return null;
  } catch {
    return null;
  }
  return { line: last.line, path: last.path, at };
}
