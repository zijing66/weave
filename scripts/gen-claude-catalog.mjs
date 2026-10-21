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
    // 从句子里切开的半截链接（`](#anchor) 或尾部孤零零的 `[`）
    .replace(/\]\([^)]*\)/g, '')
    .replace(/\[\s*$/, '')
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

/** 一段文字里的引号取值（`"low"` → low）；超过 12 个视为散文，不当枚举。 */
function quotedValuesOf(text) {
  const quoted = [...text.matchAll(/`"([a-zA-Z0-9_.:/@-]{1,60})"`/g)].map((m) => m[1]);
  return quoted.length > 0 && quoted.length <= 12 ? [...new Set(quoted)] : undefined;
}

/**
 * Type 的项目符号：带引号的是**取值**（`* `"low"`: …`），不带引号的是**字段名**
 * （`* `effortLevel`: …`）。两种混成一个 options 会让 `modelSettings` 出成下拉框。
 */
function bulletsOf(typeText) {
  const out = [];
  for (const line of typeText.split(/\r?\n/)) {
    const m = /^\s*\* (?:\[`([^`]+)`\]\([^)]*\)|`([^`]+)`):\s*(.*)$/.exec(line);
    if (!m) continue;
    const token = m[1] ?? m[2];
    const quoted = token.startsWith('"');
    out.push({ name: token.replace(/^"|"$/g, ''), quoted, body: m[3] ?? '' });
  }
  return out;
}

/** 字段的上下文（"`x` as a Boolean" / "`x` array of strings"）→ 类型串。只看紧跟名字的那一小段。 */
function fieldTypeOf(context) {
  const t = context
    .trim()
    .replace(/^,\s*/, '')
    .replace(/^as\s+(?:an?\s+)?/i, '')
    .replace(/^an?\s+(?:optional\s+)?/i, '');
  if (/^Boolean\b/i.test(t)) return 'Boolean';
  if (/^arrays? of\b/i.test(t)) return 'array of strings';
  if (/^(?:number|integer)\b/i.test(t)) return 'number';
  return 'string';
}

/** 一个字段：名字 + 类型 + 取值枚举（有引号取值且说 one of 才算枚举）。 */
function fieldSpecOf(name, body, context) {
  const raw = body || context || '';
  const text = clean(raw);
  const options = /\bone of\b|\beither\b/i.test(text) ? quotedValuesOf(raw) : undefined;
  return {
    name,
    type: options ? 'enum' : fieldTypeOf(text),
    ...(options ? { options } : {}),
    ...(text ? { description: clip(text) } : {}),
  };
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
      const spec = {
        key: full,
        group: group,
        type: typeOf(row.type, optionsOf(row.type)),
        options: optionsOf(row.type),
        description: clip(clean(row.desc)),
        scope: 'any',
        nested: true,
      };
      upsert(spec);
    }
    fieldRows = [];
    fieldParent = null;
  };

  /** 同键只留一条：真条目与 Fields-for 表都能盖掉 Type 从句猜出来的占位。 */
  const upsert = (spec) => {
    const i = keys.findIndex((k) => k.key === spec.key);
    if (i < 0) keys.push(spec);
    else if (keys[i].nested) keys[i] = spec;
  };

  const pushNested = (parent, field, parentType = '') => {
    const full = `${parent}.${field.name}`;
    if (keys.some((k) => k.key === full)) return;
    keys.push({
      key: full,
      group,
      type: typeOf(field.type, field.options),
      options: field.options,
      default: undefined,
      // 文档只在 Type 从句里写「object with a, b, c」时子键没有自己的散文——退回父键那句
      description:
        field.description ||
        clip(`${parent}: ${parentType.replace(/[,;:]?\s*(?:one of|either)\b[\s\S]*$/i, '').trim()}`),
      scope: 'any',
      nested: true,
    });
  };

  /**
   * Type 文案里的结构：`array of …` / `object mapping …` / `object with …`。
   * 项目符号分流——带引号是取值，不带引号是字段；`each one of:` 前面的反引号名字
   * 是字段（`voice` 的 enabled/autoSubmit/mode），数组的值枚举则来自 `each one of`。
   */
  const structureOf = (typeRaw) => {
    const rawHead = typeRaw
      .split(/\r?\n/)
      .filter((l) => !/^\s*\* /.test(l))
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim();
    const head = clean(rawHead);
    const bullets = bulletsOf(typeRaw);
    const [rawBefore = '', rawAfter = ''] = rawHead.split(/\b(?:one of|either)\b/i);
    const enumTail = /\b(?:one of|either)\s*:?$/i.test(head);
    const bulletsEnum = bullets.length > 0 && (bullets.every((b) => b.quoted) || enumTail);
    const values = bulletsEnum ? [...new Set(bullets.map((b) => b.name))] : quotedValuesOf(rawAfter);

    const isArray = /^array\b/i.test(head);
    const isMap = /\bobject mapping\b|\bmap of\b/i.test(head);
    const isObject = !isArray && !isMap && /^object\b/i.test(head);
    // map 的「to」之前说的是键（模型名、插件 ID），之后才是值的字段
    const toIdx = isMap ? rawHead.search(/\bto\b/i) : -1;
    const fieldSource = toIdx >= 0 ? rawHead.slice(toIdx + 2) : rawBefore;
    const eachAll = /\beach\b/i.test(fieldSource);

    // 字段名只认 Type 从句里的反引号标识符；one of 之后是取值
    const windows = [];
    for (const m of fieldSource.matchAll(/`([^`]+)`/g)) {
      const name = m[1].replace(/^"|"$/g, '');
      if (name.startsWith('"')) continue;
      windows.push({ name, start: m.index, end: m.index + m[0].length });
    }
    // 「with `a`, `b`, and `c` arrays of prose rules」：只剩逗号的字段共用最后那句里的类型
    const contextOf = (i) =>
      clean(fieldSource.slice(windows[i].end, i + 1 < windows.length ? windows[i + 1].start : undefined));
    // 「… and `c` arrays of prose rules」里的类型说的是这一组，不是最后那个带自己类型的名字
    let groupType = 'string';
    for (let i = windows.length - 1; i >= 0; i--) {
      const c = contextOf(i);
      if (/^(?:arrays?|objects?|maps?)\b/i.test(c)) {
        groupType = fieldTypeOf(c);
        break;
      }
    }
    const inlineFields = windows.map((w, i) => {
      const ctx = contextOf(i);
      const isEnum = bulletsEnum && values && (eachAll || i === windows.length - 1);
      const bare = /^[,;]?(?:\s*(?:and|or))?[,;]?$/.test(ctx);
      return {
        name: w.name,
        type: isEnum ? 'enum' : bare ? groupType : fieldTypeOf(ctx),
        ...(isEnum ? { options: values } : {}),
      };
    });
    const bulletFields = bulletsEnum ? [] : bullets.map((b) => fieldSpecOf(b.name, b.body));
    const toClause = /\bto\s+([\s\S]*)$/i.exec(head)?.[1] ?? '';
    const valueType = /Boolean/i.test(toClause)
      ? 'Boolean'
      : /\barray of\b/i.test(toClause)
        ? 'array of strings'
        : 'string';
    return {
      head,
      shape: isArray ? 'array' : isMap ? 'map' : undefined,
      fields: isMap || isObject ? [...bulletFields, ...inlineFields] : [],
      values: isArray || isMap ? values : undefined,
      valueType: isArray || isMap ? valueType : undefined,
      isObject,
    };
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
    // env 单列（web 有自己的变量选择器），其余按结构记录形状
    const st =
      key === 'env'
        ? { head: clean(typeRaw), shape: undefined, fields: [], values: undefined, valueType: undefined, isObject: false }
        : structureOf(typeRaw);
    const typeFull = st.head || clean(typeRaw);
    if (!typeFull) {
      key = null;
      buf = [];
      return;
    }
    // 数组一律记形状：连标量数组也要逐行编辑（weave 的托管条目就锁在行上）
    const hasShape = st.shape === 'map' || st.shape === 'array';
    // 对象的取值枚举属于某个字段（voice 的 mode），不是这个键自己的 options
    const scalarOptions = hasShape || (st.isObject && st.fields.length > 0) ? undefined : optionsOf(typeRaw);
    upsert({
      key,
      group,
      type: typeOf(typeFull, scalarOptions),
      options: scalarOptions,
      default: defaultRaw ? clip(clean(defaultRaw)) : undefined,
      description,
      scope: scopeOf(scopeRaw),
      ...(deprecated ? { deprecated: true } : {}),
      ...(hasShape ? { shape: st.shape } : {}),
      ...(st.fields.length > 0 && !st.isObject ? { fields: st.fields } : {}),
      ...(hasShape && st.values ? { valueOptions: st.values } : {}),
      ...(hasShape && st.fields.length === 0 && st.values === undefined && st.valueType
        ? { valueType: st.valueType }
        : {}),
    });
    if (st.isObject) for (const f of st.fields) pushNested(key, f, st.head);
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
