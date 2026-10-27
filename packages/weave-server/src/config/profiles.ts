import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConfigFileId } from '@weavecode/harness';

/**
 * 配置快照的落盘面。`root` = `local/harness-config`（由调用方给，测试用临时目录）：
 * 快照里可能带 API key ⇒ 本机专属、不进 settings 表、不随迁移带走。
 */
export interface ConfigProfileMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigProfileState {
  activeId: string | null;
  profiles: ConfigProfileMeta[];
}

type FileState = ConfigProfileState;
type Store = Record<string, FileState>;

const MAX_BACKUPS = 20;

function harnessDir(root: string, harness: string): string {
  return path.join(root, harness);
}

function storePath(root: string, harness: string): string {
  return path.join(harnessDir(root, harness), 'profiles.json');
}

function snapshotPath(root: string, harness: string, file: ConfigFileId, id: string): string {
  return path.join(harnessDir(root, harness), `${file}-${id}.json`);
}

function backupDir(root: string, harness: string): string {
  return path.join(harnessDir(root, harness), 'backups');
}

function backupPath(root: string, harness: string, file: ConfigFileId, id: string): string {
  return path.join(backupDir(root, harness), `${file}-${id}.json`);
}

async function readJsonObject(target: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(target, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function writeJson(target: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, target);
}

async function readStore(root: string, harness: string): Promise<Store> {
  const parsed = await readJsonObject(storePath(root, harness));
  return (parsed ?? {}) as Store;
}

function emptyState(): FileState {
  return { activeId: null, profiles: [] };
}

function stateOf(store: Store, file: ConfigFileId): FileState {
  return store[file] ?? emptyState();
}

export async function listProfiles(
  root: string,
  harness: string,
  file: ConfigFileId,
): Promise<ConfigProfileState> {
  return stateOf(await readStore(root, harness), file);
}

async function mutate(
  root: string,
  harness: string,
  file: ConfigFileId,
  fn: (state: FileState) => void,
): Promise<FileState> {
  const store = await readStore(root, harness);
  const state = stateOf(store, file);
  fn(state);
  store[file] = state;
  await writeJson(storePath(root, harness), store);
  return state;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 落一份快照（整份 JSON）。 */
export async function writeSnapshot(
  root: string,
  harness: string,
  file: ConfigFileId,
  id: string,
  values: Record<string, unknown>,
): Promise<void> {
  await writeJson(snapshotPath(root, harness, file, id), values);
}

export async function readSnapshot(
  root: string,
  harness: string,
  file: ConfigFileId,
  id: string,
): Promise<Record<string, unknown> | null> {
  return readJsonObject(snapshotPath(root, harness, file, id));
}

export async function createProfile(
  root: string,
  harness: string,
  file: ConfigFileId,
  name: string,
  values: Record<string, unknown>,
): Promise<ConfigProfileMeta> {
  const meta: ConfigProfileMeta = {
    id: randomUUID().slice(0, 8),
    name,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await writeSnapshot(root, harness, file, meta.id, values);
  await mutate(root, harness, file, (state) => {
    state.profiles.push(meta);
  });
  return meta;
}

/** 覆盖某份快照的内容并刷新 updatedAt。 */
export async function saveProfile(
  root: string,
  harness: string,
  file: ConfigFileId,
  id: string,
  values: Record<string, unknown>,
): Promise<void> {
  await writeSnapshot(root, harness, file, id, values);
  await mutate(root, harness, file, (state) => {
    const meta = state.profiles.find((p) => p.id === id);
    if (meta) meta.updatedAt = nowIso();
  });
}

export async function renameProfile(
  root: string,
  harness: string,
  file: ConfigFileId,
  id: string,
  name: string,
): Promise<void> {
  await mutate(root, harness, file, (state) => {
    const meta = state.profiles.find((p) => p.id === id);
    if (meta) {
      meta.name = name;
      meta.updatedAt = nowIso();
    }
  });
}

export async function removeProfile(
  root: string,
  harness: string,
  file: ConfigFileId,
  id: string,
): Promise<void> {
  await mutate(root, harness, file, (state) => {
    state.profiles = state.profiles.filter((p) => p.id !== id);
    if (state.activeId === id) state.activeId = null;
  });
  await fs.rm(snapshotPath(root, harness, file, id), { force: true });
}

export async function setActive(
  root: string,
  harness: string,
  file: ConfigFileId,
  id: string | null,
): Promise<void> {
  await mutate(root, harness, file, (state) => {
    state.activeId = id;
  });
}

/**
 * 无活跃快照档位的自动基线（project/projectLocal 不支持快照、user/global 可能还没建）：
 * 首次查看立基线、写入口同步——没有它这些档位的外部改动永远判不出漂移。
 */
export const LASTSEEN_ID = '_lastseen';

/** 漂移基线：活跃快照优先，缺省落自动基线。 */
export async function baselineSnapshot(
  root: string,
  harness: string,
  file: ConfigFileId,
  state: ConfigProfileState,
): Promise<Record<string, unknown> | null> {
  if (state.activeId) {
    const active = await readSnapshot(root, harness, file, state.activeId);
    if (active) return active;
  }
  return readSnapshot(root, harness, file, LASTSEEN_ID);
}

/** 写入口同步基线：有活跃快照同步它；`_lastseen` 恒跟着写（删掉活跃快照后基线不复活旧值）。 */
export async function syncBaseline(
  root: string,
  harness: string,
  file: ConfigFileId,
  state: ConfigProfileState,
  values: Record<string, unknown>,
): Promise<void> {
  if (state.activeId) await saveProfile(root, harness, file, state.activeId, values);
  await writeSnapshot(root, harness, file, LASTSEEN_ID, values);
}

/** 备份 ID：本地时刻 `YYYY-MM-DD-HHmmss`（可读、可排序，与全局时刻戳同族）。 */
function backupIdOf(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  );
}

/** 写盘前把当前活配置存一份（每档留最新 20 份，超出按时间删旧）。 */
export async function pushBackup(
  root: string,
  harness: string,
  file: ConfigFileId,
  values: Record<string, unknown>,
): Promise<void> {
  // 秒级精度：同一秒内再备一份时追加序号（-2、-3…），别把前一份覆盖掉
  const base = backupIdOf(new Date());
  const existing = new Set(
    (await fs.readdir(backupDir(root, harness)).catch(() => [] as string[])).filter((n) =>
      n.startsWith(`${file}-${base}`),
    ),
  );
  let id = base;
  for (let seq = 2; existing.has(`${file}-${id}.json`); seq++) id = `${base}-${seq}`;
  await writeJson(backupPath(root, harness, file, id), values);
  const stale = (await listBackups(root, harness, file)).slice(MAX_BACKUPS);
  for (const old of stale) {
    await fs.rm(backupPath(root, harness, file, old), { force: true });
  }
}

/** 备份列表（新 → 旧）。同秒序号（`-2`）比无后缀的更新——按「时刻 + 序号」排，不按裸字典序。 */
export async function listBackups(root: string, harness: string, file: ConfigFileId): Promise<string[]> {
  const prefix = `${file}-`;
  const rank = (id: string): number => {
    const m = /^(\d{4}-\d{2}-\d{2}-\d{6})(?:-(\d+))?$/.exec(id);
    if (!m) return 0;
    return Number(`${m[1].replace(/-/g, '')}${m[2] ?? '1'}`);
  };
  const names = (await fs.readdir(backupDir(root, harness)).catch(() => [] as string[]))
    .filter((n) => n.startsWith(prefix) && n.endsWith('.json'))
    .map((n) => n.slice(prefix.length, -'.json'.length))
    .sort((a, b) => rank(a) - rank(b))
    .reverse();
  return names;
}

export async function readBackup(
  root: string,
  harness: string,
  file: ConfigFileId,
  id: string,
): Promise<Record<string, unknown> | null> {
  if (!/^[A-Za-z0-9-]+$/.test(id)) return null;
  return readJsonObject(backupPath(root, harness, file, id));
}
