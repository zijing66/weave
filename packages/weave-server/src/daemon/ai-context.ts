import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { builtinMarketDir } from '../market/builtin.js';

/**
 * AI 助手的系统上下文装配——精选三源：`docs/ARCHITECTURE.md` + `docs/FEATURES.md`
 * + 内置技能的 `SKILL.md`（经 `<dataDir>/market/weave` 运行时可达，不硬编码包路径）。
 *
 * 刻意**不做进程内缓存**：装配是几毫秒级的文件读，而一次 LLM 调用是秒级；
 * 不缓存恰好让「改了文档立刻生效」对开发态成立（失效面为零）。
 * docs 找不到（安装态 cwd 不落在仓库里）→ 降级只注入技能，不报错。
 */

/** 三源合计字符上限（安全网：远超精选预算就截断，防上下文被塞爆）。 */
const MAX_CONTEXT_CHARS = 60_000;
/** 技能文件数上限（内置市场多插件时兜底）。 */
const MAX_SKILL_FILES = 40;
/** docs 向上查找的层数上限。 */
const DOCS_SEARCH_DEPTH = 6;

export interface AiContextResult {
  /** 可直接作 system message 的全文。 */
  prompt: string;
  /** 实际注入的源标签（UI/日志可展示）。 */
  labels: string[];
  /** docs 是否命中（false = 已降级只注入技能）。 */
  docsFound: boolean;
}

/** 从 `start` 向上找含 `docs/FEATURES.md` 的仓库根，返回 docs 目录。 */
export function findDocsDir(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < DOCS_SEARCH_DEPTH; i++) {
    const candidate = path.join(dir, 'docs');
    if (existsSync(path.join(candidate, 'FEATURES.md'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 递归收集 `SKILL.md`（排序稳定；深度与数量双限）。 */
export function collectSkillFiles(root: string, limit = MAX_SKILL_FILES): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= limit || depth > 6) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === 'SKILL.md') out.push(full);
    }
  };
  walk(root, 0);
  return out.sort();
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 装配系统提示词（三源 + 固定前言）。 */
export function buildSystemPrompt(deps: { dataDir: string; cwd?: string }): AiContextResult {
  const sources: Array<{ label: string; text: string }> = [];

  const docsDir = findDocsDir(deps.cwd ?? process.cwd());
  if (docsDir) {
    for (const name of ['ARCHITECTURE.md', 'FEATURES.md']) {
      const file = path.join(docsDir, name);
      if (!existsSync(file)) continue;
      const text = readText(file);
      if (text) sources.push({ label: `docs/${name}`, text });
    }
  }

  const marketRoot = builtinMarketDir(deps.dataDir);
  for (const file of collectSkillFiles(marketRoot)) {
    const text = readText(file);
    if (text) {
      sources.push({
        label: path.relative(marketRoot, file).split(path.sep).join('/'),
        text,
      });
    }
  }

  const head = [
    '你是 weave 控制台内置的 AI 助手。weave 是一个本地自托管的 coding-agent harness',
    '（多 harness 能力槽装配、dashboard、CLI、hooks 事件采集、插件市场与资源三层管理）。',
    '',
    '下面注入的是 weave 的功能文档与内置技能定义。请优先依据这些资料回答；',
    '资料未覆盖时明确说「不确定」，不要编造 weave 的行为、命令或参数。',
    '回答使用与提问相同的语言；涉及操作时给出确切命令与路径。',
  ].join('\n');

  const body: string[] = [];
  let used = head.length;
  const labels: string[] = [];
  for (const source of sources) {
    const section = `\n\n## 注入资料：${source.label}\n\n${source.text}`;
    if (used + section.length > MAX_CONTEXT_CHARS) {
      const room = MAX_CONTEXT_CHARS - used;
      if (room > 500) {
        body.push(`\n\n## 注入资料：${source.label}（按预算截断）\n\n${source.text.slice(0, room)}`);
        labels.push(`${source.label}(截断)`);
      }
      break;
    }
    used += section.length;
    body.push(section);
    labels.push(source.label);
  }

  return { prompt: head + body.join(''), labels, docsFound: docsDir !== null };
}
