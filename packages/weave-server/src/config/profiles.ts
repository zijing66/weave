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

/** 写盘前把当前活配置存一份（每档留最新 20 份，超出按时间删旧）。 */
export async function pushBackup(
  root: string,
  harness: string,
  file: ConfigFileId,
  values: Record<string, unknown>,
): Promise<void> {
  const id = nowIso().replace(/[:.]/g, '-');
  await writeJson(backupPath(root, harness, file, id), values);
  const prefix = `${file}-`;
  const names = (await fs.readdir(backupDir(root, harness)).catch(() => [] as string[]))
    .filter((n) => n.startsWith(prefix) && n.endsWith('.json'))
    .sort()
    .reverse();
  for (const stale of names.slice(MAX_BACKUPS)) {
    await fs.rm(path.join(backupDir(root, harness), stale), { force: true });
  }
}

/** 备份列表（新 → 旧）。 */
export async function listBackups(root: string, harness: string, file: ConfigFileId): Promise<string[]> {
  const prefix = `${file}-`;
  const names = (await fs.readdir(backupDir(root, harness)).catch(() => [] as string[]))
    .filter((n) => n.startsWith(prefix) && n.endsWith('.json'))
    .sort()
    .reverse();
  return names.map((n) => n.slice(prefix.length, -'.json'.length));
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
