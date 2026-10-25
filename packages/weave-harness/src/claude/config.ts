import fs from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';
import type {
  ConfigCatalog,
  ConfigFileId,
  ConfigFileSpec,
  ConfigKeySpec,
  ConfigManagedEntry,
  ConfigModelOption,
  ConfigSurface,
} from '../driver.js';
import { CONFIG_SHAPE_OVERRIDES } from './config-shapes.js';
import { WEAVE_MARKETPLACE } from './plugins.js';
import {
  CLAUDE_ENV_VARS,
  CLAUDE_SETTINGS_GROUPS,
  CLAUDE_SETTINGS_KEYS,
} from './settings-catalog.generated.js';
import {
  WEAVE_PERMISSIONS_ALLOW,
  WEAVE_PERMISSIONS_DENY,
  statusLineIsWeave,
} from './settings-gen.js';

const MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * 表单只读的 weave 托管键（点号路径）。`statusLine` 另按「命令是否指向 weave」判。
 * `permissions` 不在这里：weave 只往它的 allow/deny 里加几条，判据见 {@link managedEntries}。
 * `enabledPlugins` 也不整键托管：weave 只写 `name@weave`（weave 市场的插件），
 * 用户从官方市场装的（`figma@claude-plugins-official`…）是自己的，判据见 {@link managedEntries}。
 */
const MANAGED_PATHS = ['$comment', 'hooks', 'env.WEAVE_ENABLED'];

type FileCtx = { projectPath: string | null; homedir: string };

const FILES: ReadonlyArray<{ id: ConfigFileId; profiles: boolean }> = [
  { id: 'user', profiles: true },
  { id: 'project', profiles: false },
  { id: 'projectLocal', profiles: false },
  { id: 'global', profiles: true },
];

function pathOf(id: ConfigFileId, ctx: FileCtx): string {
  switch (id) {
    case 'user':
      return path.join(ctx.homedir, '.claude', 'settings.json');
    case 'project':
      return ctx.projectPath ? path.join(ctx.projectPath, '.claude', 'settings.json') : '';
    case 'projectLocal':
      return ctx.projectPath ? path.join(ctx.projectPath, '.claude', 'settings.local.json') : '';
    case 'global':
      return path.join(ctx.homedir, '.claude.json');
  }
}

/** 文档的 Scope 词表 → 文件档位（`local` 即项目本地那份）。 */
function scopeKeyOf(file: ConfigFileId): string {
  return file === 'projectLocal' ? 'local' : file;
}

/** 某档可见的键：global 档只要 global 键；其余档 = any 键 + 本档专属键。 */
function keysOf(file: ConfigFileId): readonly ConfigKeySpec[] {
  if (file === 'global') return CLAUDE_SETTINGS_KEYS.filter((k) => k.scope === 'global');
  const own = scopeKeyOf(file);
  return CLAUDE_SETTINGS_KEYS.filter((k) => k.scope === 'any' || k.scope === own);
}

/** 生成器抽不出的值形状（数组元素字段、少数 map 的值）由覆盖表补上。 */
function withShapes(keys: readonly ConfigKeySpec[]): ConfigKeySpec[] {
  return keys.map((k) => (k.key in CONFIG_SHAPE_OVERRIDES ? { ...k, ...CONFIG_SHAPE_OVERRIDES[k.key] } : k));
}

function topKeysOf(file: ConfigFileId): Set<string> {
  return new Set(keysOf(file).map((k) => k.key.split('.')[0]));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDangerousSegment(seg: string): boolean {
  return seg === '__proto__' || seg === 'constructor' || seg === 'prototype';
}

/** 点号路径 → 值（逐段走，只在普通对象上走）。 */
function readPath(root: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = root;
  for (const seg of dotted.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** 点号路径 → 写入（空段/危险段一律拒绝，避免 __proto__ 注入）。 */
function assignPath(root: Record<string, unknown>, dotted: string, value: unknown): void {
  const segs = dotted.split('.');
  if (segs.some((s) => !s || isDangerousSegment(s))) throw new Error(`非法配置键：${dotted}`);
  let cur = root;
  for (const seg of segs.slice(0, -1)) {
    if (!isPlainObject(cur[seg])) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]] = value;
}

async function readRawObject(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_BYTES) throw new Error(`配置文件超过 ${MAX_BYTES} 字节：${file}`);
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const body = text.replace(/^﻿/, '').trim();
  if (!body) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`配置文件不是合法 JSON：${file}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`配置文件顶层不是对象：${file}`);
  return parsed;
}

async function writeRawObject(file: string, values: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(values, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

function resolveFile(file: ConfigFileId, ctx: FileCtx): string {
  const p = pathOf(file, ctx);
  if (!p) throw new Error(`配置档位 ${file} 需要项目路径`);
  return p;
}

function credentialOf(values: Record<string, unknown>, input: { apiKey?: string | null; authToken?: string | null }): {
  header: Record<string, string>;
  credential: string;
} {
  const env = isPlainObject(values['env']) ? values['env'] : {};
  const apiKey = input.apiKey || (typeof env['ANTHROPIC_API_KEY'] === 'string' ? env['ANTHROPIC_API_KEY'] : '');
  const authToken =
    input.authToken || (typeof env['ANTHROPIC_AUTH_TOKEN'] === 'string' ? env['ANTHROPIC_AUTH_TOKEN'] : '');
  if (apiKey) return { header: { 'x-api-key': apiKey }, credential: 'apiKey' };
  if (authToken) return { header: { authorization: `Bearer ${authToken}` }, credential: 'authToken' };
  return { header: {}, credential: 'none' };
}

/**
 * 预写文件夹信任（init 时替用户答掉 claude 首开的「是否信任该文件夹」）：
 * `~/.claude.json` 顶层 `projects` 里该目录的 `hasTrustDialogAccepted: true`。
 *
 * 键形是 claude 自己的归一（本机 2.1.296 实测）：正斜杠绝对路径、保留原大小写。
 * 就着原对象改、只动这一个布尔，其余键（含其他项目条目）原位保留；已信任即
 * no-op 不重写。原子写（tmp+rename）；文件损坏/超限抛错，由调用方捕获。
 */
export async function ensureTrustAccepted(projectPath: string): Promise<void> {
  const file = pathOf('global', { projectPath: null, homedir: osHomedir() });
  const raw = await readRawObject(file);
  const key = path.resolve(projectPath).replace(/\\/g, '/');
  const projects = isPlainObject(raw['projects']) ? raw['projects'] : {};
  const entry = isPlainObject(projects[key]) ? projects[key] : {};
  if (entry['hasTrustDialogAccepted'] === true) return;
  projects[key] = { ...entry, hasTrustDialogAccepted: true };
  raw['projects'] = projects;
  await writeRawObject(file, raw);
}

export const CLAUDE_CONFIG: ConfigSurface = {
  harness: 'claude',

  files(): ConfigFileSpec[] {
    return FILES.map((f) => ({ id: f.id, profiles: f.profiles, path: (c) => pathOf(f.id, c) }));
  },

  catalog(file): ConfigCatalog {
    const keys = withShapes(keysOf(file));
    return {
      groups: CLAUDE_SETTINGS_GROUPS.filter((g) => keys.some((k) => k.group === g)),
      keys,
      envVars: file === 'global' ? [] : CLAUDE_ENV_VARS,
    };
  },

  async read(file, ctx) {
    const raw = await readRawObject(resolveFile(file, ctx));
    const tops = topKeysOf(file);
    const out: Record<string, unknown> = {};
    for (const k of tops) if (k in raw) assignPath(out, k, raw[k]);
    return out;
  },

  async write(file, ctx, values) {
    const target = resolveFile(file, ctx);
    const current = await readRawObject(target);
    const tops = topKeysOf(file);
    // 就着原对象改：未知键与「没动过的键」保持原位，只在末尾追加新键（少制造 diff 噪声）
    const next: Record<string, unknown> = { ...current };
    for (const key of Object.keys(current)) {
      if (tops.has(key) && !(key in values)) delete next[key];
    }
    for (const [k, v] of Object.entries(values)) {
      if (!tops.has(k.split('.')[0])) continue;
      assignPath(next, k, v);
    }
    await writeRawObject(target, next);
  },

  managedKeys(values) {
    const out = MANAGED_PATHS.filter((p) => readPath(values, p) !== undefined);
    if (values['statusLine'] !== undefined && statusLineIsWeave(values['statusLine'])) out.push('statusLine');
    return out;
  },

  managedEntries(values) {
    const out: ConfigManagedEntry[] = [];
    for (const [path, entries] of [
      ['permissions.allow', WEAVE_PERMISSIONS_ALLOW],
      ['permissions.deny', WEAVE_PERMISSIONS_DENY],
    ] as const) {
      const list = readPath(values, path);
      if (!Array.isArray(list)) continue;
      for (const entry of entries) if (list.includes(entry)) out.push({ path, entry });
    }
    // weave 市场的插件（`name@weave`）是装/停面板写进去的；其他市场的键是用户自己的
    const ep = readPath(values, 'enabledPlugins');
    if (isPlainObject(ep)) {
      for (const key of Object.keys(ep)) {
        if (key.endsWith(`@${WEAVE_MARKETPLACE}`)) out.push({ path: 'enabledPlugins', entry: key });
      }
    }
    return out;
  },

  async models(input) {
    const env = isPlainObject(input.values['env']) ? input.values['env'] : {};
    const configured = typeof env['ANTHROPIC_BASE_URL'] === 'string' ? env['ANTHROPIC_BASE_URL'] : '';
    // baseUrl 有人会把 `/v1` 一起填进来，按 SDK 的根口径收齐后再拼 `/v1/models`
    const baseUrl = (input.baseUrl || configured || DEFAULT_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/, '');
    const { header, credential } = credentialOf(input.values, input);
    const res = await fetch(`${baseUrl}/v1/models?limit=1000`, {
      headers: { 'anthropic-version': ANTHROPIC_VERSION, ...header },
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`模型列表请求失败：HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
    }
    const body = (await res.json()) as { data?: unknown };
    const models: ConfigModelOption[] = [];
    if (Array.isArray(body.data)) {
      for (const item of body.data) {
        if (!isPlainObject(item) || typeof item['id'] !== 'string') continue;
        models.push({
          id: item['id'],
          ...(typeof item['display_name'] === 'string' ? { name: item['display_name'] } : {}),
          ...(typeof item['created_at'] === 'string' ? { createdAt: item['created_at'] } : {}),
        });
      }
    }
    return { models, baseUrl, credential };
  },

  rawFormat: 'json',

  parseRaw(text) {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('顶层必须是对象');
    }
    return parsed as Record<string, unknown>;
  },

  serializeRaw(values) {
    return `${JSON.stringify(values, null, 2)}\n`;
  },
};
