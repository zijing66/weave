import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { load as yamlLoad } from 'js-yaml';

/**
 * 全局手法库（G6 批6，G线设计 §五「协调者本体 = 跨 house 记忆」）：什么套路在
 * 什么场景跑赢。**文件层即事实**（零表结构），落 `<data>/rpg/handbook/`（data 档
 * 随迁移整档带走 = 可迁移）；形态 = Claude Code memory 目录约定同款——
 * `MEMORY.md` 索引（单行一事实）+ 单事实单文件（frontmatter + 正文，`[[name]]`
 * 织网）。协调者分身经绝对路径直读直写（persona 写明路径与格式）；本仓端点
 * 只做外壳（观察面 learn/prune + 读）。
 */

export type HandbookSourceType = 'coordinator' | 'god' | 'review';

export interface HandbookEntry {
  name: string;
  description: string;
  /** 谁采集的（分身巡房收获 = coordinator；上帝手记 = god；复盘产出 = review）。 */
  source: HandbookSourceType | null;
  createdAt: string | null;
  body: string;
}

export interface HandbookListResult {
  entries: HandbookEntry[];
  /** 目录里 parse 不过的文件（坏 frontmatter）——如实列出名字，不在 entries 里伪造。 */
  broken: string[];
}

/** name 词表：小写 kebab-slug（= 文件名，防路径逃逸的第二道闸）。 */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const HANDBOOK_BODY_MAX = 8_000;
export const HANDBOOK_DESCRIPTION_MAX = 200;

function parseEntry(raw: string): { ok: true; entry: HandbookEntry } | { ok: false } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return { ok: false };
  let meta: Record<string, unknown>;
  try {
    meta = yamlLoad(m[1]!) as Record<string, unknown>;
  } catch {
    return { ok: false };
  }
  if (typeof meta !== 'object' || meta === null || typeof meta.name !== 'string') return { ok: false };
  const rawSource = (meta.metadata as Record<string, unknown> | undefined)?.source ?? meta.source;
  const source =
    typeof rawSource === 'string' && ['coordinator', 'god', 'review'].includes(rawSource)
      ? (rawSource as HandbookSourceType)
      : null;
  return {
    ok: true,
    entry: {
      name: meta.name,
      description: typeof meta.description === 'string' ? meta.description : '',
      source,
      createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : null,
      body: (m[2] ?? '').trim(),
    },
  };
}

function renderEntry(entry: HandbookEntry): string {
  const meta: Record<string, unknown> = {
    name: entry.name,
    description: entry.description,
    metadata: { type: 'rpg-handbook', source: entry.source },
    createdAt: entry.createdAt ?? new Date().toISOString(),
  };
  return `---\n${JSON.stringify(meta, null, 2)}\n---\n\n${entry.body}\n`;
}

export function sanitizeHandbookInput(input: {
  name?: unknown;
  description?: unknown;
  body?: unknown;
  source?: unknown;
}): { ok: true; entry: HandbookEntry } | { ok: false; error: string } {
  if (typeof input.name !== 'string' || !NAME_RE.test(input.name)) {
    return { ok: false, error: '"name" must be a lowercase kebab slug (e.g. "retry-then-flush")' };
  }
  const description = typeof input.description === 'string' ? input.description.trim().slice(0, HANDBOOK_DESCRIPTION_MAX) : '';
  if (typeof input.body !== 'string' || input.body.trim() === '') {
    return { ok: false, error: '"body" is required' };
  }
  if (input.body.length > HANDBOOK_BODY_MAX) {
    return { ok: false, error: `"body" over ${HANDBOOK_BODY_MAX} chars` };
  }
  const source =
    (input.source === 'coordinator' || input.source === 'god' || input.source === 'review') ? input.source : 'god';
  return {
    ok: true,
    entry: {
      name: input.name,
      description,
      source,
      createdAt: new Date().toISOString(),
      body: input.body.trim(),
    },
  };
}

export class RpgHandbookRepository {
  constructor(readonly root: string) {}

  private fileOf(name: string): string {
    return path.join(this.root, `${name}.md`);
  }

  /** 索引行（MEMORY.md）：单行一事实。 */
  private async regenIndex(entries: HandbookEntry[]): Promise<void> {
    const lines = ['# 全局手法库', '', '什么套路在什么场景跑赢（协调者本体跨 house 记忆；`[[name]]` 互链）。', ''];
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`- [${e.name}](${e.name}.md) — ${e.description}`);
    }
    await writeFile(path.join(this.root, 'MEMORY.md'), lines.join('\n') + '\n', 'utf-8');
  }

  /** 全量清点：扫目录 `*.md`（MEMORY.md 除外）；坏文件如实进 broken、不伪造。 */
  async list(): Promise<HandbookListResult> {
    const entries: HandbookEntry[] = [];
    const broken: string[] = [];
    let files: string[];
    try {
      files = await readdir(this.root);
    } catch {
      return { entries: [], broken: [] };
    }
    for (const f of files.sort()) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      try {
        const raw = await readFile(path.join(this.root, f), 'utf-8');
        const parsed = parseEntry(raw);
        if (parsed.ok) entries.push(parsed.entry);
        else broken.push(f);
      } catch {
        broken.push(f);
      }
    }
    return { entries, broken };
  }

  /** 落一条手法（同名 = 重写该文件——「巩固」语义：最近的认识胜旧文）。 */
  async learn(input: { name?: unknown; description?: unknown; body?: unknown; source?: unknown }): Promise<
    { ok: true; entry: HandbookEntry } | { ok: false; error: string }
  > {
    const sanitized = sanitizeHandbookInput(input);
    if (!sanitized.ok) return sanitized;
    // 同名巩固保留首记 createdAt（「什么时候跑赢的」是手法的一部分）。
    try {
      const old = parseEntry(await readFile(this.fileOf(sanitized.entry.name), 'utf-8'));
      if (old.ok) sanitized.entry.createdAt = old.entry.createdAt ?? sanitized.entry.createdAt;
    } catch {
      /* 新文件 */
    }
    try {
      await mkdir(this.root, { recursive: true });
      await writeFile(this.fileOf(sanitized.entry.name), renderEntry(sanitized.entry), 'utf-8');
    } catch (e) {
      return { ok: false, error: `write failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const listed = await this.list();
    await this.regenIndex(listed.entries).catch(() => {});
    return { ok: true, entry: sanitized.entry };
  }

  /** 剪枝（记忆剪枝走提案通道是复盘闭环的事；直删 = 上帝手删，如 PR 的 review）。 */
  async prune(name: string): Promise<boolean> {
    if (!NAME_RE.test(name)) return false;
    try {
      await rm(this.fileOf(name));
    } catch {
      return false;
    }
    const listed = await this.list();
    await this.regenIndex(listed.entries).catch(() => {});
    return true;
  }
}
