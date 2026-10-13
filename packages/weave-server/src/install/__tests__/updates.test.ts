import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { detectSkillUpdates } from '../updates.js';
import { FingerprintCache } from '../fingerprint.js';
import { buildLibraryIndex } from '../library-index.js';
import { openDatabase } from '../../db/db.js';
import { LibraryRepository } from '../../repositories/libraries.js';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 全局 skill 更新检测的两个修复回归（M4）：
 * ① symlink 形式的全局安装（linkOrCopy 产物）要被列出——Dirent.isDirectory() 会漏；
 * ② codex 全局 current 根 ~/.agents/skills 要被扫描（原硬编码 ~/.codex/skills 是欠账）。
 */

let fakeHome: string;
let projectDir: string;
let srcRoot: string;
let origHome: string | undefined;
let origProfile: string | undefined;
let db: DatabaseSync;
let libs: LibraryRepository;
const tempDirs: string[] = [];

function makeSource(name: string, body: string): string {
  const dir = path.join(srcRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), body);
  return dir;
}

/** win32 无权限建普通 symlink → 用 junction（同为 Dirent.isSymbolicLink）。 */
function linkDir(target: string, link: string): void {
  mkdirSync(path.dirname(link), { recursive: true });
  try {
    symlinkSync(target, link, 'junction');
  } catch {
    symlinkSync(target, link, 'dir');
  }
}

beforeAll(() => {
  origHome = process.env.HOME;
  origProfile = process.env.USERPROFILE;
  fakeHome = mkdtempSync(path.join(tmpdir(), 'weave-upd-home-'));
  projectDir = mkdtempSync(path.join(tmpdir(), 'weave-upd-proj-'));
  srcRoot = mkdtempSync(path.join(tmpdir(), 'weave-upd-src-'));
  tempDirs.push(fakeHome, projectDir, srcRoot);
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  expect(homedir()).toBe(fakeHome); // 隔离确实生效
});
afterAll(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = origProfile;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  db = openDatabase(':memory:');
  libs = new LibraryRepository(db, fakeHome);
});

it('symlink 形式的 claude 全局 skill 出现在检测里，内容一致不 outdated', async () => {
  const src = makeSource('gskill', '# G v1');
  libs.add({ path: src, kind: 'skill' });
  const link = path.join(fakeHome, '.claude', 'skills', 'gskill');
  linkDir(src, link);

  const idx = await buildLibraryIndex(libs.list());
  const out = await detectSkillUpdates(projectDir, new FingerprintCache(), idx);
  const entry = out.find((s) => s.name === 'gskill' && s.scope === 'user' && s.agent === 'claude');
  expect(entry).toBeDefined();
  expect(entry!.custom).toBe(false);
  expect(entry!.outdated).toBe(false);
  db.close();
});

it('codex 全局 current 根（~/.agents/skills）内的 skill 被扫描到', async () => {
  const src = makeSource('cskill', '# C v1');
  libs.add({ path: src, kind: 'skill' });
  const installed = path.join(fakeHome, '.agents', 'skills', 'cskill');
  mkdirSync(installed, { recursive: true });
  writeFileSync(path.join(installed, 'SKILL.md'), '# C v1');

  const idx = await buildLibraryIndex(libs.list());
  const out = await detectSkillUpdates(projectDir, new FingerprintCache(), idx);
  const entry = out.find((s) => s.name === 'cskill' && s.scope === 'user' && s.agent === 'codex');
  expect(entry).toBeDefined();
  expect(entry!.outdated).toBe(false);
  db.close();
});
