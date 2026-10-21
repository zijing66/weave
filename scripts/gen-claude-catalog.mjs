#!/usr/bin/env node
/**
 * 生成 claude 配置词表（settings.json 键 + env 变量）：
 *   抓官方文档 markdown（或 `--from <dir>` 读本地副本）→ 解析 → 落
 *   `packages/weave-harness/src/claude/settings-catalog.generated.ts`。
 *
 * 文档源（唯一事实源，勿手改生成物）：
 *   https://code.claude.com/docs/en/settings-reference.md   每个键的 Scope/Type/Default/示例
 *   https://code.claude.com/docs/en/env-vars.md             settings 的 env 块可写变量
 *
 * 用法：
 *   node scripts/gen-claude-catalog.mjs            # 联网抓取
 *   node scripts/gen-claude-catalog.mjs --from /tmp/docs   # 读本地 settings-reference.md / env-vars.md
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'packages/weave-harness/src/claude/settings-catalog.generated.ts');
const SOURCES = {
  settings: 'https://code.claude.com/docs/en/settings-reference.md',
  env: 'https://code.claude.com/docs/en/env-vars.md',
};

/** 说明文案上限（英文原文截断；UI 只摆一行到两行，全文靠 title）。 */
const DESC_MAX = 320;

const fromIdx = process.argv.indexOf('--from');
const fromDir = fromIdx >= 0 ? process.argv[fromIdx + 1] : null;

async function loadSource(key, file) {
  if (fromDir) return readFile(path.join(fromDir, file), 'utf8');
  const res = await fetch(SOURCES[key], { redirect: 'follow' });
  if (!res.ok) throw new Error(`${SOURCES[key]} → HTTP ${res.status}`);
  return res.text();
}

/** markdown 行内杂音剥掉：链接留文字、去粗体/代码反引号、折叠空白。 */
function clean(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\\\[/g, '[')
    .replace(/\\\]/g, ']')
    .replace(/\*\*|__/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 截到 DESC_MAX，尽量在句末断开。 */
function clip(text) {
  if (text.length <= DESC_MAX) return text;
  const window = text.slice(0, DESC_MAX);
  const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('; '), window.lastIndexOf(', '));
  return `${(cut > DESC_MAX * 0.6 ? window.slice(0, cut) : window.slice(0, DESC_MAX)).trimEnd()}…`;
}

/** 文档里的 Scope 行 → 四个档位判定（Any file / Managed / 具体文件 / Global config）。 */
function scopeOf(raw) {
  if (!raw) return 'any';
  if (/Global config/.test(raw)) return 'global';
  if (/Any file/.test(raw)) return 'any';
  if (/`Managed`/.test(raw)) return 'managed';
  if (/`User`/.test(raw) && !/`Project`|`Local`/.test(raw)) return 'user';
  return 'any';
}

/**
 * Type 文案里的取值枚举：只认「one of」/「either」句与 `* `value`: …」项目符号——
 * 模型族这类「别名或完整 ID」也进 options，web 侧始终给「自定义」逃生口，猜窄了不致命。
 */
function optionsOf(typeText) {
  if (/^\s*Boolean\b/i.test(typeText)) return undefined;
  const bullets = [...typeText.matchAll(/^\s*\* `"?([a-zA-Z0-9_.-]+)"?`:/gm)].map((m) => m[1]);
  if (bullets.length > 0) return [...new Set(bullets)];
  if (/\bone of\b|\beither\b/i.test(typeText)) {
    const quoted = [...typeText.matchAll(/`"([a-zA-Z0-9_.-]{1,40})"`/g)].map((m) => m[1]);
    if (quoted.length > 0 && quoted.length <= 12) return [...new Set(quoted)];
  }
  return undefined;
}

/** Type 文案收敛成一行短标签——枚举明细已经在 options 里，正文不进表单。 */
function typeOf(full, options) {
  let t = full.replace(/[:,]?\s*(?:one of|either)\b[\s\S]*$/i, '');
  if (/^\s*Boolean\b/i.test(t)) t = 'Boolean';
  else if (options) t = t.split(/;\s*/)[0];
  t = t.replace(/[,;:\s]+$/, '').trim();
  if (!t) t = options ? 'enum' : 'string';
  if (t.length > 100) {
    const w = t.slice(0, 100);
    const cut = Math.max(w.lastIndexOf('; '), w.lastIndexOf(', '));
    t = `${(cut > 60 ? w.slice(0, cut) : w).trimEnd()}…`;
  }
  return t;
}

const FIELD_ROW = /^\| `([^`]+)` \| ([^|]+) \| (.*?) \|$/;

/** settings-reference.md → { groups, keys }。 */
function parseSettings(md) {
  const lines = md.split(/\r?\n/);
  const keys = [];
  const groups = [];
  let group = null;
  let key = null;
  let buf = [];
  /** 当前条目后面跟的 "Fields for X" 表：parent → [{field,type,desc}] */
  let fieldParent = null;
  let fieldRows = [];

  const flushFields = () => {
    for (const row of fieldRows) {
      const full = `${fieldParent}.${row.field}`;
      if (keys.some((k) => k.key === full)) continue;
      keys.push({
        key: full,
        group: group,
        type: typeOf(row.type, optionsOf(row.type)),
        options: optionsOf(row.type),
        default: undefined,
        description: clip(clean(row.desc)),
        scope: 'any',
        nested: true,
      });
    }
    fieldRows = [];
    fieldParent = null;
  };

  const flush = () => {
    if (!key) return;
    const text = buf.join('\n');
    const scopeRaw = /^\* \*\*Scope\*\*: (.+)$/m.exec(text)?.[1] ?? '';
    const typeRaw =
      /^\* \*\*Type\*\*: ([\s\S]*?)(?=^\* \*\*(?:Default|Per-session overrides)\*\*)/m.exec(text)?.[1]?.trim() ??
      '';
    const defaultRaw = /^\* \*\*Default\*\*: (.+)$/m.exec(text)?.[1] ?? '';
    const prose = text
      .split(/^\* \*\*Scope\*\*/m)[0]
      .replace(/^####.*$/gm, '')
      .trim();
    const description = clip(clean(prose));
    const deprecated = /\bdeprecated\b|\[DEPRECATED\]|Removed in v/i.test(prose);
    const options = optionsOf(typeRaw);
    const typeFull = clean(typeRaw).replace(/\s*;?\s*\* /g, '; ');
    if (!typeFull) {
      key = null;
      buf = [];
      return;
    }
    keys.push({
      key,
      group,
      type: typeOf(typeFull, options),
      options,
      default: defaultRaw ? clip(clean(defaultRaw)) : undefined,
      description,
      scope: scopeOf(scopeRaw),
      ...(deprecated ? { deprecated: true } : {}),
    });
    key = null;
    buf = [];
  };

  for (const line of lines) {
    const topic = /^## (.+)$/.exec(line);
    if (topic) {
      flush();
      flushFields();
      group = clean(topic[1]);
      if (!groups.includes(group)) groups.push(group);
      continue;
    }
    const fields = /^#### Fields for `([^`]+)`/.exec(line);
    if (fields) {
      flush();
      fieldParent = fields[1];
      continue;
    }
    const row = FIELD_ROW.exec(line);
    if (fieldParent && row) {
      fieldRows.push({ field: row[1], type: clean(row[2]), desc: row[3] });
      continue;
    }
    const heading = /^### `([^`]+)`/.exec(line);
    if (heading) {
      flush();
      flushFields();
      key = heading[1];
      continue;
    }
    if (key) buf.push(line);
  }
  flush();
  flushFields();

  // 嵌套补全：`sandbox.filesystem` 有独立条目、子键也有——父键保持对象控件即可。
  for (const k of keys) {
    if (!k.group) k.group = 'Other';
  }
  // 「Settings index」「See also」这类章节不是配置主题，只有真揣着键的组才留下。
  const used = groups.filter((g) => keys.some((k) => k.group === g));
  if (keys.some((k) => k.group === 'Other')) used.push('Other');
  return { groups: used.length > 0 ? used : ['Other'], keys };
}

/** env-vars.md 的 Variables 表 → [{ name, description, kind, options? }]。 */
function parseEnv(md) {
  const start = md.indexOf('## Variables');
  const end = md.indexOf('## What the subprocess environment scrub removes');
  const body = md.slice(start, end > start ? end : undefined);
  const out = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^\| `([A-Z][A-Z0-9_]*)` \| (.*?) \|$/.exec(line);
    if (!m) continue;
    const description = clip(clean(m[2]));
    const raw = m[2];
    let kind = 'string';
    if (/`(0|1)`/.test(raw) && /(set to|turn|on or off|enables?|disables?|forces?)/i.test(raw)) kind = 'boolean';
    else if (/comma-separated/i.test(raw)) kind = 'list';
    else if (/milliseconds|timeout|token (budget|count)|percentage|number of/i.test(raw)) kind = 'number';
    else if (/one of\b/i.test(raw)) kind = 'enum';
    else if (/\bpath\b|file path|directory/i.test(raw)) kind = 'path';
    const options = kind === 'enum' ? (optionsOf(raw) ?? undefined) : undefined;
    out.push({ name: m[1], description, kind, ...(options ? { options } : {}) });
  }
  return out;
}

const HEADER = `/**
 * claude 配置词表（settings.json 键 + env 变量）——**生成物，勿手改**。
 * 重新生成：\`node scripts/gen-claude-catalog.mjs\`（\`pnpm gen:catalog\`）。
 *
 * 源：${SOURCES.settings}
 *     ${SOURCES.env}
 * 生成日期：${new Date().toISOString().slice(0, 10)}
 */
import type { ConfigEnvVarSpec, ConfigKeySpec } from '../driver.js';

`;

function emit({ groups, keys, env }) {
  const body = keys
    .map((k) => `  ${JSON.stringify(k)},`)
    .join('\n');
  const envBody = env.map((e) => `  ${JSON.stringify(e)},`).join('\n');
  return (
    HEADER +
    `export const CLAUDE_SETTINGS_GROUPS: readonly string[] = ${JSON.stringify(groups)};\n\n` +
    `export const CLAUDE_SETTINGS_KEYS: readonly ConfigKeySpec[] = [\n${body}\n];\n\n` +
    `export const CLAUDE_ENV_VARS: readonly ConfigEnvVarSpec[] = [\n${envBody}\n];\n`
  );
}

const settingsMd = await loadSource('settings', 'settings-reference.md');
const envMd = await loadSource('env', 'env-vars.md');
const parsed = parseSettings(settingsMd);
const env = parseEnv(envMd);
if (parsed.keys.length < 200) throw new Error(`settings 键只解析出 ${parsed.keys.length} 条，文档格式可能变了`);
if (env.length < 300) throw new Error(`env 变量只解析出 ${env.length} 条，文档格式可能变了`);
await writeFile(OUT, emit({ ...parsed, env }), 'utf8');
console.log(
  `wrote ${path.relative(ROOT, OUT)} — ${parsed.keys.length} keys / ${parsed.groups.length} groups / ${env.length} env vars`,
);
