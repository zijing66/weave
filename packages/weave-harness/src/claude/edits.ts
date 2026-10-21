import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { EditHunk, EditsSurface, FileEdit } from '../driver.js';

/**
 * 会话改动（claude）：改文件只有工具调用一条路——`Edit` / `Write` / `MultiEdit`
 * 的 tool_input 就是改动本身（`old_string` → `new_string`、整份 `content`），
 * 转录是这些东西的唯一全量账本。
 *
 * 为什么绕到转录：库里的 hook 事件把 tool_input 逐字段裁到 4KB（`capFields`），
 * 大一点的 Write 只剩前半份——拿它拼 diff 是错的；而转录一行不裁。
 */

/** 会改文件的工具。`NotebookEdit` 不算：它改的是 cell 源，没有可比对的整份文本。 */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** 一次工具调用里带的改动（认不出 → 空数组）。 */
function hunksOf(toolName: string, input: Record<string, unknown>): EditHunk[] {
  if (toolName === 'Write') {
    const content = str(input.content);
    return content === null ? [] : [{ before: '', after: content }];
  }
  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return edits.flatMap((raw) => {
      const edit = obj(raw);
      const before = str(edit.old_string);
      const after = str(edit.new_string);
      return before === null || after === null ? [] : [{ before, after }];
    });
  }
  const before = str(input.old_string);
  const after = str(input.new_string);
  return before === null || after === null ? [] : [{ before, after }];
}

export const CLAUDE_EDITS: EditsSurface = {
  async sessionEdits({ transcriptPath }) {
    if (!transcriptPath) return null;
    const out: FileEdit[] = [];
    // 中断/重开后同一批 assistant 条目会被重放，工具调用 id 是它自己的身份
    const seen = new Set<string>();
    const rl = createInterface({
      input: createReadStream(transcriptPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        if (!line.includes('"tool_use"')) continue;
        let entry: { message?: { content?: unknown }; timestamp?: unknown };
        try {
          entry = JSON.parse(line) as typeof entry;
        } catch {
          continue;
        }
        const content = entry.message?.content;
        if (!Array.isArray(content)) continue;
        for (const raw of content) {
          const part = obj(raw);
          if (part.type !== 'tool_use') continue;
          const toolName = str(part.name);
          if (!toolName || !EDIT_TOOLS.has(toolName)) continue;
          const id = str(part.id);
          if (id) {
            if (seen.has(id)) continue;
            seen.add(id);
          }
          const input = obj(part.input);
          const path = str(input.file_path);
          if (!path) continue;
          const at = str(entry.timestamp);
          for (const hunk of hunksOf(toolName, input)) out.push({ path, hunk, at });
        }
      }
    } catch {
      return null; // 读到一半断了（文件被清、编码坏了）：不交半份
    } finally {
      rl.close();
    }
    return out;
  },
};
