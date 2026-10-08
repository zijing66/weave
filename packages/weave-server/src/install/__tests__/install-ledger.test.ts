import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installSkill, uninstallSkill } from '../installer.js';
import { readInstalledLedger, recordInstalled } from '../install-ledger.js';
import { detectUpdates } from '../updates.js';
import { syncAll } from '../apply-update.js';
import { FingerprintCache } from '../fingerprint.js';
import { openDatabase } from '../../db/db.js';
import { LibraryRepository } from '../../repositories/libraries.js';

/**
 * 自动同步"补齐"回归：
 * ① 账本登记 = 安装意图，被删（手工 rm）后必须报 missing 并能被 syncAll 装回；
 * ② 显式卸载同时删账目 —— 主动卸载不该被补齐逆回；
 * ③ 账本损坏当空、重复登记幂等。
 */

let fakeHome: string;
let projectDir: string;
let srcRoot: string;
let origHome: string | undefined;
let origProfile: string | undefined;
let libs: LibraryRepository;
let db: ReturnType<typeof openDatabase>;

beforeEach(() => {
  origHome = process.env.HOME;
  origProfile = process.env.USERPROFILE;
  fakeHome = mkdtempSync(path.join(tmpdir(), 'weave-led-home-'));
  projectDir = mkdtempSync(path.join(tmpdir(), 'weave-led-proj-'));
  srcRoot = mkdtempSync(path.join(tmpdir(), 'weave-led-src-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  db = openDatabase(':memory:');
  libs = new LibraryRepository(db, fakeHome);
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = origProfile;
  for (const dir of [fakeHome, projectDir, srcRoot]) rmSync(dir, { recursive: true, force: true });
  db.close();
});

const makeSkillSource = (name: string, body: string): string => {
  const dir = path.join(srcRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), body);
  return dir;
};

const report = () => detectUpdates(projectDir, libs.list(), new FingerprintCache());

it('安装登记账目；文件在盘时不算可更新', async () => {
  const src = makeSkillSource('demo', '# v1');
  libs.add({ path: src, kind: 'skill' });
  const target = await installSkill(projectDir, src, 'demo');

  expect(await readInstalledLedger(projectDir)).toEqual([
    { category: 'skill', name: 'demo', agent: 'claude' },
  ]);
  const r = await report();
  expect(r.skills.find((s) => s.name === 'demo')).toMatchObject({ outdated: false, custom: false });
  expect(r.available).toBe(0);
  expect(existsSync(path.join(target, 'SKILL.md'))).toBe(true);
});

it('盘上被删 → 报 missing + outdated，syncAll 装回（补齐）', async () => {
  const src = makeSkillSource('demo', '# v1');
  libs.add({ path: src, kind: 'skill' });
  const target = await installSkill(projectDir, src, 'demo');
  rmSync(target, { recursive: true, force: true }); // 模拟被删除

  const r = await report();
  expect(r.skills.find((s) => s.name === 'demo')).toMatchObject({
    outdated: true,
    missing: true,
    custom: false,
  });
  expect(r.available).toBe(1);

  const { updated } = await syncAll(projectDir, libs.list(), new FingerprintCache());
  expect(updated).toContainEqual({
    category: 'skill',
    name: 'demo',
    scope: 'project',
    agent: 'claude',
  });
  expect(existsSync(path.join(target, 'SKILL.md'))).toBe(true);
  expect((await report()).available).toBe(0);
});

it('显式卸载删账目 → 不会被补齐逆回', async () => {
  const src = makeSkillSource('demo', '# v1');
  libs.add({ path: src, kind: 'skill' });
  await installSkill(projectDir, src, 'demo');
  await uninstallSkill(projectDir, 'demo');

  expect(await readInstalledLedger(projectDir)).toEqual([]);
  const r = await report();
  expect(r.skills.find((s) => s.name === 'demo')).toBeUndefined();
  expect(r.available).toBe(0);
});

it('账本损坏当空；重复登记幂等', async () => {
  await recordInstalled(projectDir, { category: 'skill', name: 'demo', agent: 'claude' });
  await recordInstalled(projectDir, { category: 'skill', name: 'demo', agent: 'claude' });
  expect(await readInstalledLedger(projectDir)).toHaveLength(1);

  writeFileSync(path.join(projectDir, '.weave', 'installed.json'), '{ not json');
  expect(await readInstalledLedger(projectDir)).toEqual([]);
});
