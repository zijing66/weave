import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { linkOrCopy, removeInstalled } from '../install-link.js';

// 假 symlink：只在 EPERM 回退分支用例里替换为拒绝，其余走真实实现（R9 双分支）。
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, symlink: vi.fn(actual.symlink) };
});

let root: string;
let src: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'weave-link-'));
  src = path.join(root, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(path.join(src, 'SKILL.md'), '# src');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('linkOrCopy（symlink 优先）', () => {
  it('成功分支：junction/symlink 指向源，内容经链接可读', async () => {
    const target = path.join(root, 'skills-link', 'alpha');
    const mode = await linkOrCopy(src, target);
    expect(mode).toBe('link');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(target, 'SKILL.md'), 'utf-8')).toBe('# src');
  });

  it('EPERM → 回退复制（copy 分支，非链接）', async () => {
    vi.mocked(symlink).mockRejectedValueOnce(
      Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }),
    );
    const target = path.join(root, 'skills-copy', 'beta');
    const mode = await linkOrCopy(src, target);
    expect(mode).toBe('copy');
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(target, 'SKILL.md'), 'utf-8')).toBe('# src');
    // 复制体与源独立
    writeFileSync(path.join(src, 'new.md'), 'x');
    expect(existsSync(path.join(target, 'new.md'))).toBe(false);
  });

  it('白名单外错误不吞（原样抛出）', async () => {
    vi.mocked(symlink).mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    );
    await expect(linkOrCopy(src, path.join(root, 'skills-err', 'gamma'))).rejects.toThrow(
      /EACCES/,
    );
  });
});

describe('removeInstalled（lstat 区分，防删穿源）', () => {
  it('链接 → 只 unlink，市场源仍在', async () => {
    const target = path.join(root, 'rm-link', 'delta');
    expect(await linkOrCopy(src, target)).toBe('link');
    expect(await removeInstalled(target)).toBe('link');
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(path.join(src, 'SKILL.md'), 'utf-8')).toBe('# src');
  });

  it('复制体 → 递归删，源仍在', async () => {
    const target = path.join(root, 'rm-copy', 'epsilon');
    vi.mocked(symlink).mockRejectedValueOnce(
      Object.assign(new Error('EPERM'), { code: 'EPERM' }),
    );
    expect(await linkOrCopy(src, target)).toBe('copy');
    expect(await removeInstalled(target)).toBe('removed');
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(path.join(src, 'SKILL.md'), 'utf-8')).toBe('# src');
  });

  it('不存在 → absent（no-op）', async () => {
    expect(await removeInstalled(path.join(root, 'rm-missing', 'zeta'))).toBe('absent');
  });
});
