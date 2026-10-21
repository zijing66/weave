import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import {
  createProfile,
  listBackups,
  listProfiles,
  pushBackup,
  readBackup,
  readSnapshot,
  removeProfile,
  renameProfile,
  saveProfile,
  setActive,
} from '../profiles.js';

const roots: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-profiles-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('配置快照', () => {
  it('创建 → 列表 → 改名 → 删除，激活态随之清空', async () => {
    const root = tmpRoot();
    const meta = await createProfile(root, 'claude', 'user', '网关 A', { env: { A: '1' } });
    let state = await listProfiles(root, 'claude', 'user');
    expect(state.profiles.map((p) => p.name)).toEqual(['网关 A']);
    expect(await readSnapshot(root, 'claude', 'user', meta.id)).toEqual({ env: { A: '1' } });

    await renameProfile(root, 'claude', 'user', meta.id, '网关 B');
    await setActive(root, 'claude', 'user', meta.id);
    state = await listProfiles(root, 'claude', 'user');
    expect(state.profiles[0].name).toBe('网关 B');
    expect(state.activeId).toBe(meta.id);

    await removeProfile(root, 'claude', 'user', meta.id);
    state = await listProfiles(root, 'claude', 'user');
    expect(state.profiles).toEqual([]);
    expect(state.activeId).toBeNull();
    expect(await readSnapshot(root, 'claude', 'user', meta.id)).toBeNull();
  });

  it('不同档位互不串味', async () => {
    const root = tmpRoot();
    await createProfile(root, 'claude', 'user', 'U', { model: 'opus' });
    await createProfile(root, 'claude', 'global', 'G', { theme: 'dark' });
    expect((await listProfiles(root, 'claude', 'user')).profiles).toHaveLength(1);
    expect((await listProfiles(root, 'claude', 'global')).profiles[0].name).toBe('G');
    expect((await listProfiles(root, 'claude', 'project')).profiles).toEqual([]);
  });

  it('saveProfile 覆盖快照内容并刷新 updatedAt', async () => {
    const root = tmpRoot();
    const meta = await createProfile(root, 'claude', 'user', 'P', { model: 'opus' });
    await saveProfile(root, 'claude', 'user', meta.id, { model: 'sonnet' });
    expect(await readSnapshot(root, 'claude', 'user', meta.id)).toEqual({ model: 'sonnet' });
    const state = await listProfiles(root, 'claude', 'user');
    expect(state.profiles[0].updatedAt >= state.profiles[0].createdAt).toBe(true);
  });

  it('备份列表新→旧，可回读', async () => {
    const root = tmpRoot();
    await pushBackup(root, 'claude', 'user', { model: 'a' });
    await new Promise((r) => setTimeout(r, 5));
    await pushBackup(root, 'claude', 'user', { model: 'b' });
    const list = await listBackups(root, 'claude', 'user');
    expect(list).toHaveLength(2);
    expect(await readBackup(root, 'claude', 'user', list[0])).toEqual({ model: 'b' });
    expect(await readBackup(root, 'claude', 'user', list[1])).toEqual({ model: 'a' });
  });

  it('备份 id 只认安全字符', async () => {
    const root = tmpRoot();
    expect(await readBackup(root, 'claude', 'user', '../../etc/passwd')).toBeNull();
  });
});
