#!/usr/bin/env node
/**
 * 生成 codex 配置词表（config.toml 键）：
 *   抓 codex-rs 的 config.schema.json（或 `--from <dir>` 读本地 checkout）→
 *   遍历顶层 properties 展开 → 落
 *   `packages/weave-harness/src/codex/config-catalog.generated.ts`。
 *
 * 词表源（唯一事实源，勿手改生成物）：
 *   https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/config.schema.json
 *   schema 与 codex-rs 同仓提交，枚举/说明/默认值都是官方原文。
 *
 * 用法：
 *   node scripts/gen-codex-catalog.mjs                  # 联网抓取
 *   node scripts/gen-codex-catalog.mjs --from <codex-rs-dir>   # 读本地 core/config.schema.json
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'packages/weave-harness/src/codex/config-catalog.generated.ts');
const SOURCE_URL =
  'https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/config.schema.json';

/** 说明文案上限（英文原文截断；UI 只摆一行到两行，全文靠 title）。 */
const DESC_MAX = 320;

/** 对象属性展开的深度上限（更深的结构由 fields / JSON 控件承接）。 */
const MAX_DEPTH = 4;

/**
 * 整棵折叠不展开的子树（键本身保留，值按 JSON 编辑）：
 * - `tui.keymap`：171 叶的键位绑定表，逐键出条目只有噪声；
 * - `notice`：宿主自己的状态记账（迁移提示去过哪），不该手编。
 */
const COLLAPSED = new Set(['tui.keymap', 'notice']);

/**
 * project 层剥掉的键（codex-rs config/src/loader/mod.rs 的
 * PROJECT_LOCAL_CONFIG_DENYLIST）——project 档写了也被 codex 无视，只归 user 档。
 */
const PROJECT_DENYLIST = new Set([
  'openai_base_url',
  'chatgpt_base_url',
  'apps_mcp_product_sku',
  'responses_api_metadata',
  'model_provider',
  'model_providers',
  'notify',
  'profile',
  'profiles',
  'experimental_realtime_webrtc_call_base_url',
  'experimental_realtime_ws_base_url',
  'otel',
]);

/** 分组归属（未列出的键落 General）。顺序即面板分组顺序。 */
const GROUP_ORDER = [
  'Model',
  'Approvals & sandbox',
  'Profiles',
  'MCP servers',
  'Plugins & marketplaces',
  'Projects & docs',
  'Hooks',
  'Features',
  'TUI',
  'Shell & execution',
  'Tools',
  'Agents & automation',
  'Skills & memories',
  'Apps & integrations',
  'Auth & network',
  'Updates & telemetry',
  'General',
];

const GROUP_OF = {
  model: 'Model',
  model_provider: 'Model',
  model_providers: 'Model',
  model_catalog_json: 'Model',
  model_context_window: 'Model',
  model_auto_compact_token_limit: 'Model',
  model_auto_compact_token_limit_scope: 'Model',
  model_post_turn_compact_threshold_percent: 'Model',
  model_instructions_file: 'Model',
  model_reasoning_effort: 'Model',
  model_reasoning_summary: 'Model',
  model_verbosity: 'Model',
  review_model: 'Model',
  oss_provider: 'Model',
  service_tier: 'Model',
  plan_mode_reasoning_effort: 'Model',

  approval_policy: 'Approvals & sandbox',
  approvals_reviewer: 'Approvals & sandbox',
  default_permissions: 'Approvals & sandbox',
  permissions: 'Approvals & sandbox',
  sandbox_mode: 'Approvals & sandbox',
  sandbox_workspace_write: 'Approvals & sandbox',

  profile: 'Profiles',
  profiles: 'Profiles',

  mcp_servers: 'MCP servers',
  mcp_enterprise_managed_auth: 'MCP servers',
  mcp_oauth_callback_port: 'MCP servers',
  mcp_oauth_callback_url: 'MCP servers',
  mcp_oauth_credentials_store: 'MCP servers',
  mcp_optional_startup_grace_ms: 'MCP servers',

  plugins: 'Plugins & marketplaces',
  marketplaces: 'Plugins & marketplaces',

  projects: 'Projects & docs',
  project_doc_fallback_filenames: 'Projects & docs',
  project_doc_max_bytes: 'Projects & docs',
  project_root_markers: 'Projects & docs',

  hooks: 'Hooks',
  features: 'Features',
  tui: 'TUI',

  allow_login_shell: 'Shell & execution',
  shell_environment_policy: 'Shell & execution',
  background_terminal_max_timeout: 'Shell & execution',
  experimental_use_unified_exec_tool: 'Shell & execution',

  tools: 'Tools',
  tool_output_token_limit: 'Tools',
  tool_suggest: 'Tools',
  web_search: 'Tools',
  computer_use: 'Tools',
  browser_use: 'Tools',

  agents: 'Agents & automation',
  goals: 'Agents & automation',
  memories: 'Agents & automation',
  orchestrator: 'Agents & automation',
  auto_review: 'Agents & automation',

  skills: 'Skills & memories',

  apps: 'Apps & integrations',
  desktop: 'Apps & integrations',
  audio: 'Apps & integrations',
  realtime: 'Apps & integrations',
  ghost_snapshot: 'Apps & integrations',
  daybreak: 'Apps & integrations',

  openai_base_url: 'Auth & network',
  chatgpt_base_url: 'Auth & network',
  forced_chatgpt_workspace_id: 'Auth & network',
  forced_login_method: 'Auth & network',
  cli_auth_credentials_store: 'Auth & network',

  check_for_update_on_startup: 'Updates & telemetry',
  analytics: 'Updates & telemetry',
  cloud: 'Updates & telemetry',
  feedback: 'Updates & telemetry',
};

const fromIdx = process.argv.indexOf('--from');
const fromDir = fromIdx >= 0 ? process.argv[fromIdx + 1] : null;

async function loadSchema() {
  if (fromDir) return readFile(path.join(fromDir, 'core', 'config.schema.json'), 'utf8');
  const res = await fetch(SOURCE_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${SOURCE_URL} → HTTP ${res.status}`);
  return res.text();
}

/** markdown 行内杂音剥掉：链接留文字、去粗体/代码反引号、折叠空白。 */
function clean(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\]\([^)]*\)/g, '')
    .replace(/\[\s*$/g, '')
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

/** 解开 `$ref`（裸引用与 `allOf: [{$ref}]` 包装两种外壳），描述取包装层的优先。 */
function deref(node, defs) {
  if (!node || typeof node !== 'object') return node;
  const ref = typeof node.$ref === 'string' ? node.$ref : null;
  const allOfRef =
    Array.isArray(node.allOf) && node.allOf.length === 1 && node.allOf[0]?.$ref
      ? node.allOf[0].$ref
      : null;
  const target = ref ?? allOfRef;
  if (target) {
    const def = defs[target.split('/').pop()];
    if (def) return { ...def, description: node.description ?? def.description };
  }
  return node;
}

const TYPE_WORDS = {
  boolean: 'Boolean',
  string: 'String',
  integer: 'Integer',
  number: 'Number',
  object: 'Object',
};

/** web 控件文法的类型词形（config-form.ts 的 controlOf 按这些词分发）。
 *  混合 anyOf 取「带枚举的分支 > 第一个有类型的分支」——另一形态走 raw 视图。 */
function typeName(node, defs) {
  const r = deref(node, defs) ?? {};
  if (r.type === 'array') return `Array of ${typeName(r.items, defs)}`;
  if (r.type) return TYPE_WORDS[r.type] ?? 'String';
  const branches = r.oneOf ?? r.anyOf;
  if (Array.isArray(branches)) {
    const withEnum = branches.find((b) => Array.isArray(deref(b, defs)?.enum));
    const pick = withEnum ?? branches.find((b) => deref(b, defs)?.type);
    if (pick) return typeName(pick, defs);
  }
  return 'String';
}

/** 从 enum / oneOf / anyOf 里收字符串枚举值（对象分支忽略——自由填写兜底）。 */
function enumOptions(node, defs) {
  const r = deref(node, defs) ?? {};
  const branches = r.oneOf ?? r.anyOf ?? [r];
  const out = [];
  for (const b of branches) {
    const rb = deref(b, defs) ?? {};
    if (Array.isArray(rb.enum)) for (const v of rb.enum) if (typeof v === 'string') out.push(v);
  }
  return out.length > 0 ? [...new Set(out)] : null;
}

function defaultText(node) {
  const d = node.default;
  if (d === undefined || d === null) return undefined;
  const s = JSON.stringify(d);
  if (s === '{}' || s === '[]' || s.length > 160) return undefined;
  return s;
}

/** 对象节点的字段表（ConfigFieldSpec，一层；更深由 JSON 控件承接）。null = 不是固定属性对象。 */
function objectFields(node, defs) {
  if (!node || node.type !== 'object' || !node.properties) return null;
  const fields = [];
  for (const [name, child] of Object.entries(node.properties)) {
    const resolved = deref(child, defs) ?? {};
    const options = enumOptions(resolved, defs);
    fields.push({
      name,
      type: typeName(resolved, defs),
      ...(options ? { options } : {}),
      ...(resolved.description ? { description: clip(clean(resolved.description)) } : {}),
    });
  }
  return fields;
}

/**
 * 展开一个属性节点为词表条目（`path` 为点号路径）。对象按 properties 递归；
 * `additionalProperties: <schema>` 是 map（键名用户起）→ shape:'map' + 值字段；
 * 数组 → shape:'array' + 元素字段/标量类型。固定属性与 map 并存的键（agents /
 * apps / plugins）两面都出：父键标 map，固定属性照常递归成子键。
 */
function emitKey({ path: dotted, node, defs, depth, group, descriptionFallback, out }) {
  const resolved = deref(node, defs) ?? {};
  const description = clean(resolved.description ?? '');
  const options = enumOptions(resolved, defs);
  const scope = PROJECT_DENYLIST.has(dotted.split('.')[0]) ? 'user' : 'any';
  const base = (extra) => ({
    key: dotted,
    group,
    ...(defaultText(resolved) ? { default: defaultText(resolved) } : {}),
    description: clip(description || descriptionFallback || ''),
    scope,
    ...(node.deprecated ? { deprecated: true } : {}),
    ...extra,
  });

  const ap = resolved.additionalProperties;
  const hasFixedProps = !!resolved.properties;

  // 纯标量（可能带枚举；混合 anyOf 的对象形态走 raw 视图）
  if (
    options &&
    resolved.type !== 'object' &&
    resolved.type !== 'array' &&
    !hasFixedProps &&
    !(ap && typeof ap === 'object')
  ) {
    out.push(base({ type: typeName(resolved, defs), options }));
    return;
  }

  // map：additionalProperties 是 schema → 值的定义
  if (resolved.type === 'object' && ap && typeof ap === 'object') {
    const valueNode = deref(ap, defs) ?? {};
    const fields = objectFields(valueNode, defs);
    const valueOptions = enumOptions(valueNode, defs);
    out.push(
      base({
        type: 'Object',
        shape: 'map',
        ...(fields
          ? { fields }
          : valueNode.type
            ? { valueType: typeName(valueNode, defs), ...(valueOptions ? { valueOptions } : {}) }
            : {}),
      }),
    );
    if (hasFixedProps && depth < MAX_DEPTH) {
      for (const [name, child] of Object.entries(resolved.properties)) {
        emitKey({
          path: `${dotted}.${name}`,
          node: child,
          defs,
          depth: depth + 1,
          group,
          descriptionFallback: description || descriptionFallback,
          out,
        });
      }
    }
    return;
  }

  // 数组：元素是对象 → 元素字段；标量 → valueType（+枚举）
  if (resolved.type === 'array' && resolved.items) {
    const itemNode = deref(resolved.items, defs) ?? {};
    const itemOptions = enumOptions(itemNode, defs);
    const fields = objectFields(itemNode, defs);
    out.push(
      base({
        type: typeName(resolved, defs),
        shape: 'array',
        ...(fields
          ? { fields }
          : { valueType: typeName(itemNode, defs), ...(itemOptions ? { valueOptions: itemOptions } : {}) }),
      }),
    );
    return;
  }

  // 固定属性对象：深度未到顶且未折叠 → 递归展开（父键不单出，子键全权代表；
  // 子键无描述时回退父描述——与 claude 词表同一范式，嵌套键不空转）
  if (hasFixedProps && depth < MAX_DEPTH && !COLLAPSED.has(dotted)) {
    const kids = Object.entries(resolved.properties);
    if (kids.length > 0) {
      for (const [name, child] of kids) {
        emitKey({
          path: `${dotted}.${name}`,
          node: child,
          defs,
          depth: depth + 1,
          group,
          descriptionFallback: description || descriptionFallback,
          out,
        });
      }
      return;
    }
  }

  // 其余：不透明整键（折叠子树、超深对象、无类型标注的空对象）
  out.push(base({ type: typeName(resolved, defs) }));
}

const schema = JSON.parse(await loadSchema());
const defs = schema.definitions ?? {};
const props = schema.properties ?? {};
if (Object.keys(props).length < 80) {
  throw new Error(`顶层键只解析出 ${Object.keys(props).length} 条，schema 格式可能变了`);
}

const keys = [];
for (const [name, node] of Object.entries(props)) {
  emitKey({
    path: name,
    node,
    defs,
    depth: 1,
    group: GROUP_OF[name] ?? 'General',
    descriptionFallback: null,
    out: keys,
  });
}

const groups = GROUP_ORDER.filter((g) => keys.some((k) => k.group === g));
const groupRank = new Map(groups.map((g, i) => [g, i]));
keys.sort((a, b) => (groupRank.get(a.group) ?? 99) - (groupRank.get(b.group) ?? 99) || a.key.localeCompare(b.key));

const HEADER = `/**
 * codex 配置词表（config.toml 键）——**生成物，勿手改**。
 * 重新生成：\`node scripts/gen-codex-catalog.mjs\`（\`pnpm gen:codex-catalog\`）。
 *
 * 源：${SOURCE_URL}
 * 生成日期：${new Date().toISOString().slice(0, 10)}
 */
import type { ConfigKeySpec } from '../driver.js';

`;

const body = keys.map((k) => `  ${JSON.stringify(k)},`).join('\n');
const content =
  HEADER +
  `export const CODEX_CONFIG_GROUPS: readonly string[] = ${JSON.stringify(groups)};\n\n` +
  `export const CODEX_CONFIG_KEYS: readonly ConfigKeySpec[] = [\n${body}\n];\n`;

await writeFile(OUT, content, 'utf8');
console.log(
  `wrote ${path.relative(ROOT, OUT)} — ${keys.length} keys / ${groups.length} groups`,
);
