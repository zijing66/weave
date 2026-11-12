import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Harness } from '@weavecode/core';
import type { MemorySinkSurface } from '../driver.js';

/**
 * 项目记忆文件认领区块的写入手艺（claude CLAUDE.local.md / codex AGENTS.md 共用
 * 机械，文件身份与文法常量归各 adapter 一格）：
 * - 区块外用户内容字节不动；区块内是 weave 的地面——条目滑动窗口裁旧。
 * - 文件在但没有区块 = 用户文件：区块**追加**到文件尾（append-only 合并纪律，
 *   同 weave init 对用户 CLAUDE.md 的处理）；文件不存在 = 连区块一起新建。
 * - 读写失败（非 ENOENT）如实报错，绝不覆写。
 */

export interface ClaimBlockSpec {
  /** 认领区块起止标记（markdown 注释形态）。 */
  start: string;
  end: string;
  /** 区块首行声明（机器维护，重写时恒保留；条目窗口不含它）。 */
  header: string;
  /** 滑动窗口缺省保留条数。 */
  maxEntries?: number;
}

/** 判决条目行：`- [本地时间] 正文`——时间给读者排序语境，内容是站立规则。 */
function entryLine(text: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const oneLine = text.replace(/\s*\n\s*/g, ' ').trim();
  return `- [${stamp}] ${oneLine}`;
}

export function createClaimBlockMemorySink(
  harness: Harness,
  fileName: string,
  spec: ClaimBlockSpec,
): MemorySinkSurface {
  const defaultMax = spec.maxEntries ?? 20;
  return {
    harness,
    async appendVerdict({ projectPath, text }) {
      const body = text.trim();
      if (!body) return { ok: false, error: 'verdict text is empty' };
      const file = path.join(projectPath, fileName);
      let existing: string;
      try {
        existing = await readFile(file, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          return { ok: false, error: `cannot read ${fileName}: ${err instanceof Error ? err.message : String(err)}` };
        }
        existing = '';
      }
      const entry = entryLine(body);
      const startIdx = existing.indexOf(spec.start);
      const endIdx = existing.indexOf(spec.end);
      let next: string;
      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        const inner = existing.slice(startIdx + spec.start.length, endIdx);
        const lines = inner
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && l !== spec.header);
        lines.push(entry);
        const kept = lines.slice(-defaultMax);
        const block = [spec.start, spec.header, ...kept, spec.end].join('\n');
        next = existing.slice(0, startIdx) + block + existing.slice(endIdx + spec.end.length);
      } else {
        // 无区块（用户文件或新文件）：append-only——区块带一条声明追加在尾。
        const base = existing.replace(/\s+$/, '');
        const block = [spec.start, spec.header, entry, spec.end].join('\n');
        next = `${base ? `${base}\n\n` : ''}${block}\n`;
      }
      try {
        await writeFile(file, next, 'utf-8');
      } catch (err) {
        return { ok: false, error: `cannot write ${fileName}: ${err instanceof Error ? err.message : String(err)}` };
      }
      return { ok: true, file };
    },
  };
}
