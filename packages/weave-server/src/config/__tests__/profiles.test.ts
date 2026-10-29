import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import {
  createProfile,
  listBackups,
  listProfiles,
  profileKeyOf,
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

  it('备份列表新→旧，可回读；id 是本地时刻形 YYYY-MM-DD-HHmmss', async () => {
    const root = tmpRoot();
    await pushBackup(root, 'claude', 'user', { model: 'a' });
    await new Promise((r) => setTimeout(r, 5));
    await pushBackup(root, 'claude', 'user', { model: 'b' });
    const list = await listBackups(root, 'claude', 'user');
    expect(list).toHaveLength(2);
    expect(await readBackup(root, 'claude', 'user', list[0])).toEqual({ model: 'b' });
    expect(await readBackup(root, 'claude', 'user', list[1])).toEqual({ model: 'a' });
    // 本地时刻、秒级精度（同秒再备追加 -N 序号）
    expect(list[0]).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?$/);
  });

  it('备份 id 只认安全字符', async () => {
    const root = tmpRoot();
    expect(await readBackup(root, 'claude', 'user', '../../etc/passwd')).toBeNull();
  });

  it('profileKeyOf：project/projectLocal 带项目后缀，user/global 原样', () => {
    expect(profileKeyOf('user', null)).toBe('user');
    expect(profileKeyOf('global', null)).toBe('global');
    expect(profileKeyOf('user', 5)).toBe('user');
    expect(profileKeyOf('project', 3)).toBe('project@p3');
    expect(profileKeyOf('projectLocal', 3)).toBe('projectLocal@p3');
    // 防御性回落：project 档没拿到 projectId 时退回裸键（不隔离，但不炸）
    expect(profileKeyOf('project', null)).toBe('project');
  });

  it('项目隔离：同 root 下两个项目的快照/备份互不可见', async () => {
    const root = tmpRoot();
    const a = await createProfile(root, 'claude', 'project@p1', '甲', { model: 'opus' });
    await pushBackup(root, 'claude', 'project@p1', { model: 'opus' });
    const b = await createProfile(root, 'claude', 'project@p2', '乙', { model: 'haiku' });
    await pushBackup(root, 'claude', 'project@p2', { model: 'haiku' });

    expect((await listProfiles(root, 'claude', 'project@p1')).profiles.map((p) => p.name)).toEqual(['甲']);
    expect((await listProfiles(root, 'claude', 'project@p2')).profiles.map((p) => p.name)).toEqual(['乙']);
    expect(await readSnapshot(root, 'claude', 'project@p1', a.id)).toEqual({ model: 'opus' });
    expect(await readSnapshot(root, 'claude', 'project@p2', a.id)).toBeNull();
    expect(await readSnapshot(root, 'claude', 'project@p1', b.id)).toBeNull();

    expect(await listBackups(root, 'claude', 'project@p1')).toHaveLength(1);
    expect(await listBackups(root, 'claude', 'project@p2')).toHaveLength(1);
    // 同秒备份 id 可以同名（不同 scope 各自一份文件），内容必须互异
    expect(await readBackup(root, 'claude', 'project@p1', (await listBackups(root, 'claude', 'project@p1'))[0])).toEqual({ model: 'opus' });
    expect(await readBackup(root, 'claude', 'project@p2', (await listBackups(root, 'claude', 'project@p2'))[0])).toEqual({ model: 'haiku' });
  });
});
