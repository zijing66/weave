import fs from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import type {
  ConfigCatalog,
  ConfigFileId,
  ConfigFileSpec,
  ConfigKeySpec,
  ConfigModelOption,
  ConfigSurface,
} from '../driver.js';
import { CODEX_CONFIG_GROUPS, CODEX_CONFIG_KEYS } from './config-catalog.generated.js';
import { codexHome } from './home.js';
import { CodexTomlCorruptError, setTomlValueInText } from './toml.js';

type FileCtx = { projectPath: string | null; homedir: string };

const FILES: ReadonlyArray<{ id: ConfigFileId; profiles: boolean }> = [
  { id: 'user', profiles: true },
  { id: 'project', profiles: false },
];

function pathOf(id: ConfigFileId, ctx: FileCtx): string {
  switch (id) {
    case 'user':
      return path.join(codexHome(ctx.homedir), 'config.toml');
    case 'project':
      return path.join(ctx.projectPath ?? '', '.codex', 'config.toml');
    default:
      return '';
  }
}

/** 某档可见的键：project 档剥掉 DENYLIST（写了也被 codex 无视），user 档全量。 */
function keysOf(file: ConfigFileId): readonly ConfigKeySpec[] {
  if (file === 'project') return CODEX_CONFIG_KEYS.filter((k) => k.scope !== 'user');
  return CODEX_CONFIG_KEYS;
}

function topKeysOf(file: ConfigFileId): Set<string> {
  return new Set(keysOf(file).map((k) => k.key.split('.')[0]));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * weave 写进 config.toml 的键（按当前值判）。codex 的写入有两扇门——weave 的
 * MCP 安装（`[mcp_servers.weave]`）与插件启停（`[plugins."<key>"] enabled`）——
 * 用户在 codex 里手编同一张表是合法操作，两边写同一个值谁后写谁生效，所以
 * v1 不上锁：只把「weave 装的那个 MCP server」标出来提示，不阻止编辑。
 */
function managedKeysOf(values: Record<string, unknown>): readonly string[] {
  const out: string[] = [];
  const servers = values['mcp_servers'];
  if (isPlainObject(servers) && 'weave' in servers) out.push('mcp_servers.weave');
  return out;
}

/**
 * `model_catalog_json` 的路径解析对齐 codex-rs（AbsolutePathBufGuard）：
 * 相对路径按 CODEX_HOME 解析、`~` 前缀展开到用户主目录，绝对路径原样。
 */
function resolveCatalogPath(raw: string, home: string): string {
  let p = raw.trim();
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(home, p.slice(2));
  if (path.isAbsolute(p)) return p;
  return path.join(codexHome(home), p);
}

/**
 * 模型列表：codex 没有可匿名调的 HTTP 模型接口——`model_catalog_json` 指向的
 * 本地 JSON（`{models:[{slug,display_name,…}]}`，codex-rs ModelsResponse）是
 * 自定义 provider 场景下唯一可靠的词表源；没配就诚实回空（宿主自己有内置
 * 目录，weave 不猜）。
 */
async function modelsOf(input: {
  values: Record<string, unknown>;
  homedir?: string;
}): Promise<{ models: ConfigModelOption[]; baseUrl: string; credential: string }> {
  const catalogPath = input.values['model_catalog_json'];
  if (typeof catalogPath !== 'string' || !catalogPath.trim()) {
    return { models: [], baseUrl: '', credential: 'none' };
  }
  const target = resolveCatalogPath(catalogPath, input.homedir ?? osHomedir());
  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf-8');
  } catch {
    throw new Error(`model_catalog_json 指向的文件读不到：${target}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`model_catalog_json 不是合法 JSON：${target}`);
  }
  const modelsList = isPlainObject(parsed) ? parsed['models'] : null;
  if (!Array.isArray(modelsList)) throw new Error('model catalog 缺 models 数组');
  const models: ConfigModelOption[] = [];
  for (const item of modelsList) {
    if (!isPlainObject(item) || typeof item['slug'] !== 'string') continue;
    models.push({
      id: item['slug'],
      ...(typeof item['display_name'] === 'string' ? { name: item['display_name'] } : {}),
      ...(typeof item['description'] === 'string' ? { createdAt: item['description'] } : {}),
    });
  }
  return { models, baseUrl: '', credential: 'none' };
}

/**
 * 预写文件夹信任（init 时替用户答掉 codex 首开的「是否信任该文件夹」）：
 * `~/.codex/config.toml` 的 `[projects.'<dir>'] trust_level = "trusted"`。
 *
 * 键形是 codex 自己的归一（本机 0.164 实测）：win32 = 全小写 + 反斜杠、
 * literal string；posix = 原样。已有 `projects` 节时先按「忽略大小写与分隔符
 * 等值」找既有键沿用其键形——codex 打开过的项目它自己已经写过一份，weave
 * 再造一份异形键宿主不认。行级编辑保用户注释；损坏抛 `CodexTomlCorruptError`。
 */
export async function ensureTrustAccepted(projectPath: string): Promise<void> {
  const target = path.join(codexHome(), 'config.toml');
  let text = '';
  try {
    text = await fs.readFile(target, 'utf-8');
  } catch {
    /* 新文件 */
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new CodexTomlCorruptError(
      `${target} is not valid TOML — refusing to write: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const resolved = path.resolve(projectPath);
  const projects = isPlainObject(parsed['projects']) ? parsed['projects'] : {};
  const eq = (a: string, b: string) =>
    process.platform === 'win32'
      ? a.toLowerCase().replaceAll('/', '\\') === b.toLowerCase().replaceAll('/', '\\')
      : a === b;
  const existing = Object.keys(projects).find((k) => eq(k, resolved));
  const dirKey = existing ?? codexProjectKey(resolved);
  const next = setTomlValueInText(text, ['projects', dirKey, 'trust_level'], 'trusted');
  if (next === text) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, next, 'utf-8');
}

/** codex 归一的 projects 键（win32 = 小写反斜杠；posix = 原样）。 */
function codexProjectKey(dir: string): string {
  return process.platform === 'win32' ? dir.toLowerCase() : dir;
}

export const CODEX_CONFIG: ConfigSurface = {
  harness: 'codex',

  files(_ctx): ConfigFileSpec[] {
    return FILES.map((f) => ({ id: f.id, profiles: f.profiles, path: (c) => pathOf(f.id, c) }));
  },

  catalog(file): ConfigCatalog {
    const keys = keysOf(file);
    return {
      groups: CODEX_CONFIG_GROUPS.filter((g) => keys.some((k) => k.group === g)),
      keys,
      envVars: [],
    };
  },

  async read(file, ctx) {
    const target = pathOf(file, ctx);
    let text: string;
    try {
      text = await fs.readFile(target, 'utf-8');
    } catch {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = parse(text);
    } catch (e) {
      throw new CodexTomlCorruptError(
        `${target} is not valid TOML — refusing to read: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!isPlainObject(parsed)) return {};
    const tops = topKeysOf(file);
    const out: Record<string, unknown> = {};
    for (const k of tops) if (k in parsed) out[k] = parsed[k];
    return out;
  },

  async write(file, ctx, values) {
    const target = pathOf(file, ctx);
    // 读原文（缺 = 空文档），把词表内的顶层键并回去，其余键原样保留
    let text = '';
    try {
      text = await fs.readFile(target, 'utf-8');
    } catch {
      /* 新文件 */
    }
    let current: Record<string, unknown>;
    try {
      current = parse(text) as Record<string, unknown>;
    } catch (e) {
      throw new CodexTomlCorruptError(
        `${target} is not valid TOML — refusing to write: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const tops = topKeysOf(file);
    const next: Record<string, unknown> = { ...current };
    for (const key of Object.keys(current)) {
      if (tops.has(key) && !(key in values)) delete next[key];
    }
    for (const [k, v] of Object.entries(values)) {
      if (!tops.has(k.split('.')[0])) continue;
      next[k] = v;
    }
    const serialized = serializeToml(next);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, serialized, 'utf-8');
  },

  managedKeys: managedKeysOf,

  managedEntries() {
    // codex 的 weave 写入（MCP 安装 / 插件启停）与用户手编同一张表是两扇门写
    // 同一个值，v1 不上锁——没有行级托管条目
    return [];
  },

  models: modelsOf,

  rawFormat: 'toml',

  parseRaw(text) {
    const parsed = parse(text) as unknown;
    if (!isPlainObject(parsed)) throw new Error('顶层必须是表');
    return parsed;
  },

  serializeRaw(values) {
    return serializeToml(values);
  },
};

/**
 * 值对象 → TOML 原文。标量/数组/嵌套表按「父表头 + 平铺键」落（codex 自己的
 * 写法），map 值里的对象值用 inline table。键序跟对象插入序。
 */
function serializeToml(values: Record<string, unknown>): string {
  const lines: string[] = [];
  const emitTable = (prefix: readonly string[], table: Record<string, unknown>): void => {
    const scalars: string[] = [];
    const subs: Array<[string, Record<string, unknown>]> = [];
    for (const [k, v] of Object.entries(table)) {
      if (isPlainObject(v) && !isEmptyInlineTable(v)) subs.push([k, v]);
      else scalars.push(`${renderKey(k)} = ${renderValue(v)}`);
    }
    if (prefix.length > 0 && (scalars.length > 0 || subs.length === 0)) {
      if (lines.length > 0) lines.push('');
      lines.push(`[${prefix.map(renderKey).join('.')}]`);
    }
    lines.push(...scalars);
    for (const [k, v] of subs) emitTable([...prefix, k], v);
  };
  emitTable([], values);
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/** 空对象落 `{}`（inline），避免给每个空 map 发一个空节。 */
function isEmptyInlineTable(v: Record<string, unknown>): boolean {
  return Object.keys(v).length === 0;
}

function renderKey(part: string): string {
  return /^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part);
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return '""';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '""';
  if (typeof v === 'string') return renderStringValue(v);
  if (Array.isArray(v)) return `[${v.map(renderValue).join(', ')}]`;
  const body = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .map(([k, x]) => `${renderKey(k)} = ${renderValue(x)}`)
    .join(', ');
  return `{ ${body} }`;
}

/** 含反斜杠且无单引号的字符串走 literal string（Windows 路径不被吃）。 */
function renderStringValue(s: string): string {
  const hasBackslash = s.includes('\\');
  const literalSafe = !s.includes("'") && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\n]/.test(s);
  if (hasBackslash && literalSafe) return `'${s}'`;
  return JSON.stringify(s);
}
