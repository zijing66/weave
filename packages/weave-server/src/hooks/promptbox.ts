import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hookShardId } from './mirror.js';

/**
 * prompt 通道的本地文件队列（消息域重塑）：`<dataDir>/hooks/promptbox/<shard>.jsonl`。
 * 与 outbox 严格分离——outbox 行由目标会话内 hook-handler 消费成 additionalContext
 * （跨端契约），prompt 行由 **daemon** 冲洗（中继 / 终端注入），handler 永不碰。
 * shard 与 outbox 同算法（项目 token 哈希前缀）；送达即删行，无 DB。
 */

export const PROMPTBOX_MAX_LINES = 200;

/** 队列行的随附图（引用上传件；路径也落盘，重启后冲洗才能重合成投递文本）。 */
export interface PromptboxImage {
  id: string;
  name: string;
  mediaType: string;
  path: string;
}

/** 队列行：id = 管道发号（MessageDeliverer 的 uuid），daemon 重启后仍可追溯。 */
export interface PromptboxEntry {
  id: string;
  sessionId: string;
  text: string;
  /** 单向注入（手动面）——随行落盘，重启后冲洗仍带「无需回复」注记。 */
  oneWay?: boolean;
  /** 发送人强制走层② 终端（下拉选的通道）——随行落盘，冲洗时同样不回落直投/中继。 */
  forceTerminal?: boolean;
  /** 随附图：`text` 恒为用户原文，投递文本由 harness `imageAttach` 现合成。 */
  images?: PromptboxImage[];
  at: string;
}

export function promptboxPathOf(hooksDir: string, shardId: string): string {
  return join(hooksDir, 'promptbox', `${shardId}.jsonl`);
}

function parseLines(text: string): PromptboxEntry[] {
  const out: PromptboxEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as Partial<PromptboxEntry>;
      if (typeof raw.id === 'string' && typeof raw.sessionId === 'string' && typeof raw.text === 'string') {
        const images = Array.isArray(raw.images)
          ? raw.images.filter(
              (i): i is PromptboxImage =>
                typeof i?.id === 'string' && typeof i?.name === 'string' && typeof i?.mediaType === 'string' && typeof i?.path === 'string',
            )
          : [];
        out.push({
          id: raw.id,
          sessionId: raw.sessionId,
          text: raw.text,
          oneWay: raw.oneWay === true,
          ...(raw.forceTerminal === true ? { forceTerminal: true } : {}),
          ...(images.length > 0 ? { images } : {}),
          at: typeof raw.at === 'string' ? raw.at : '',
        });
      }
    } catch {
      // 坏行跳过：队列是尽力递送面，不是记录系统
    }
  }
  return out;
}

/** 追加入队（有界：超上限丢最旧，与 outbox 同型）。 */
export function appendPromptbox(
  hooksDir: string,
  token: string,
  entries: Array<{
    id: string;
    sessionId: string;
    text: string;
    oneWay?: boolean;
    forceTerminal?: boolean;
    images?: PromptboxImage[];
  }>,
): void {
  if (entries.length === 0) return;
  try {
    const file = promptboxPathOf(hooksDir, hookShardId(token));
    mkdirSync(join(hooksDir, 'promptbox'), { recursive: true });
    let kept: string[] = [];
    try {
      kept = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    } catch {
      kept = [];
    }
    const at = new Date().toISOString();
    for (const entry of entries) kept.push(JSON.stringify({ ...entry, at }));
    const bounded = kept.slice(-PROMPTBOX_MAX_LINES);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, bounded.length ? bounded.join('\n') + '\n' : '');
    renameSync(tmp, file);
  } catch {
    // 队列写失败只损失一次 prompt 递送尝试（重发可补）
  }
}

/** 读一个项目的全部待递送行。 */
export function readPromptbox(hooksDir: string, token: string): PromptboxEntry[] {
  try {
    return parseLines(readFileSync(promptboxPathOf(hooksDir, hookShardId(token)), 'utf8'));
  } catch {
    return [];
  }
}

/** 删行（送达后）；ids 为空 = 不动文件。 */
export function removePromptboxEntries(hooksDir: string, token: string, ids: Set<string>): void {
  if (ids.size === 0) return;
  try {
    const file = promptboxPathOf(hooksDir, hookShardId(token));
    let kept: string[];
    try {
      kept = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    } catch {
      return;
    }
    const bounded = kept.filter((l) => {
      try {
        return !ids.has((JSON.parse(l) as Partial<PromptboxEntry>).id ?? '');
      } catch {
        return false; // 坏行顺手清掉
      }
    });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, bounded.length ? bounded.join('\n') + '\n' : '');
    renameSync(tmp, file);
  } catch {
    // 同 append：丢一次删除不影响正确性（送达幂等键在 id）
  }
}

/** 全库读行（扫所有项目分片）：队列索引与在途计数共用一份目录遍历。 */
export function readAllPromptbox(hooksDir: string): PromptboxEntry[] {
  const dir = join(hooksDir, 'promptbox');
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out: PromptboxEntry[] = [];
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    try {
      out.push(...parseLines(readFileSync(join(dir, file), 'utf8')));
    } catch {
      continue;
    }
  }
  return out;
}

/** 全库扫描：待递送行涉及哪些会话（启动重建队列索引 / 刷新器探活）。 */
export function scanQueuedSessionIds(hooksDir: string): Set<string> {
  return new Set(readAllPromptbox(hooksDir).map((e) => e.sessionId));
}

/** 按会话删行（会话被删/归档时的级联清理）。返回删除行数。 */
export function removePromptboxBySession(hooksDir: string, sessionId: string): number {
  const dir = join(hooksDir, 'promptbox');
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const target = join(dir, file);
    let lines: string[];
    try {
      lines = readFileSync(target, 'utf8').split('\n').filter((l) => l.trim());
    } catch {
      continue;
    }
    const kept = lines.filter((l) => {
      try {
        return (JSON.parse(l) as Partial<PromptboxEntry>).sessionId !== sessionId;
      } catch {
        return false;
      }
    });
    if (kept.length === lines.length) continue;
    removed += lines.length - kept.length;
    try {
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '');
      renameSync(tmp, target);
    } catch {
      // 写失败：清理尽力而为
    }
  }
  return removed;
}
