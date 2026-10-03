import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseSources,
  readSourcesFile,
  writeSourcesFile,
  addToolkitDir,
  removeToolkitDir,
  searchPlugins,
} from '../plugin-installer.js';

/**
 * sources.json schema 演进（批 10）：旧形 `string[]`（纯 index URL）与新形
 * `{ indexes, dirs }` 双形读取兼容；`searchPlugins` 只遍历 indexes、
 * 永不 fetch dirs（不污染远程搜索源）。
 */
describe('sources.json schema 演进', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'weave-tk-src-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('parseSources：旧 string[] 形兼容（dirs 为空）', () => {
    expect(parseSources(['https://a/index.json', 42, 'https://b/index.json'])).toEqual({
      indexes: ['https://a/index.json', 'https://b/index.json'],
      dirs: [],
    });
  });

  it('parseSources：新 {indexes, dirs} 形 + 坏输入回空', () => {
    expect(parseSources({ indexes: ['u'], dirs: ['/d'] })).toEqual({
      indexes: ['u'],
      dirs: ['/d'],
    });
    expect(parseSources({ indexes: ['u'] })).toEqual({ indexes: ['u'], dirs: [] });
    expect(parseSources('garbage')).toEqual({ indexes: [], dirs: [] });
    expect(parseSources(null)).toEqual({ indexes: [], dirs: [] });
  });

  it('读侧双形：旧文件直接读取；写侧统一落新形且保留旧 indexes', async () => {
    await writeFile(
      path.join(root, 'sources.json'),
      JSON.stringify(['https://old/index.json']),
      'utf8',
    );
    expect(await readSourcesFile(root)).toEqual({
      indexes: ['https://old/index.json'],
      dirs: [],
    });

    const dir = path.join(root, 'tools');
    await mkdir(dir, { recursive: true });
    const after = await addToolkitDir(dir, root);
    expect(after).toEqual({ indexes: ['https://old/index.json'], dirs: [path.resolve(dir)] });
    const raw = JSON.parse(await readFile(path.join(root, 'sources.json'), 'utf8')) as {
      indexes: string[];
      dirs: string[];
    };
    expect(raw.indexes).toEqual(['https://old/index.json']);
    expect(raw.dirs).toContain(path.resolve(dir));
  });

  it('add-dir 幂等 + 不存在的目录拒绝；remove-dir 只删 dirs 条目', async () => {
    const dir = path.join(root, 'tools');
    await mkdir(dir, { recursive: true });
    await writeSourcesFile({ indexes: ['https://x/i.json'], dirs: [] }, root);

    await addToolkitDir(dir, root);
    await addToolkitDir(dir, root);
    expect((await readSourcesFile(root)).dirs).toEqual([path.resolve(dir)]);

    await expect(addToolkitDir(path.join(root, 'missing'), root)).rejects.toThrow(/目录不存在/);

    const after = await removeToolkitDir(dir, root);
    expect(after).toEqual({ indexes: ['https://x/i.json'], dirs: [] });
    expect(await removeToolkitDir(dir, root)).toEqual({ indexes: ['https://x/i.json'], dirs: [] });
  });

  it('searchPlugins 只遍历 indexes、跳过 dirs（对 dirs 零 fetch）', async () => {
    // searchPlugins 读全局插件根 → 临时把 configDir 指到测试根（win 用 APPDATA）
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const savedAppdata = process.env.APPDATA;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.APPDATA = root;
    process.env.XDG_CONFIG_HOME = root;
    try {
      // 新形：dirs 里放一个「看似 URL」的条目——旧实现会 fetch 它
      await mkdir(path.join(root, 'weave', 'plugins'), { recursive: true });
      await writeFile(
        path.join(root, 'weave', 'plugins', 'sources.json'),
        JSON.stringify({ indexes: [], dirs: ['https://dir-as-url.example/index.json'] }),
        'utf8',
      );
      const results = await searchPlugins('');
      expect(results).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();

      // 旧形：string[] 整体视为 indexes（dirs 为空，兼容不断）
      await writeFile(
        path.join(root, 'weave', 'plugins', 'sources.json'),
        JSON.stringify(['https://old.example/index.json']),
        'utf8',
      );
      expect(await readSourcesFile()).toEqual({
        indexes: ['https://old.example/index.json'],
        dirs: [],
      });
    } finally {
      fetchSpy.mockRestore();
      if (savedAppdata === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = savedAppdata;
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
    }
  });
});
