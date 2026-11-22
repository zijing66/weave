import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * SKILL.md frontmatter 的 `description` 标量提取（列表摘要用）。
 * 只看 frontmatter 头部（16KB 内足够），解析失败/缺键 → undefined——
 * 摘要缺位是常态不是错误，绝不因它让任何列表调用失败。
 */

const HEAD_CAP = 16 * 1024;

/** 剥引号（'…' / "…"）；块标量指示符（> | 及其 chomp 变体）原样返回待块处理。 */
function scalarOf(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t;
}

export async function skillDescriptionOf(dir: string): Promise<string | undefined> {
  let head: string;
  try {
    head = (await readFile(path.join(dir, 'SKILL.md'), 'utf8')).slice(0, HEAD_CAP);
  } catch {
    return undefined;
  }
  const fm = head.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!fm) return undefined;
  const lines = fm[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^description:(.*)$/);
    if (!m) continue;
    const rest = m[1].trim();
    // 块标量（> / >- / | / |- 或空值接缩进块）：取后续更缩进的行折成一段
    if (!rest || /^[>|]/.test(rest)) {
      const out: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (!/^\s+\S/.test(lines[j])) break;
        out.push(lines[j].trim());
      }
      const joined = out.join(' ').trim();
      return joined || undefined;
    }
    const v = scalarOf(rest);
    return v || undefined;
  }
  return undefined;
}
