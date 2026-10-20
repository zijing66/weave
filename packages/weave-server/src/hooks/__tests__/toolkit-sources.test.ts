import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSources, readSourcesFile, writeSourcesFile, searchPlugins } from '../plugin-installer.js';

/**
 * sources.json schema 演进（批 10）：旧形 `string[]`（纯 index URL）与新形
 * `{ indexes }` 双形读取兼容；`searchPlugins` 只遍历 indexes，未知字段不入源。
 */
describe('sources.json schema 演进', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'weave-tk-src-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('parseSources：旧 string[] 形兼容', () => {
    expect(parseSources(['https://a/index.json', 42, 'https://b/index.json'])).toEqual({
      indexes: ['https://a/index.json', 'https://b/index.json'],
    });
  });

  it('parseSources：新 {indexes} 形 + 坏输入回空（未知字段忽略）', () => {
    expect(parseSources({ indexes: ['u'], dirs: ['/d'] })).toEqual({ indexes: ['u'] });
    expect(parseSources({ indexes: ['u'] })).toEqual({ indexes: ['u'] });
    expect(parseSources('garbage')).toEqual({ indexes: [] });
    expect(parseSources(null)).toEqual({ indexes: [] });
  });

  it('读侧双形：旧文件直接读取；写侧统一落对象形且保留旧 indexes', async () => {
    await writeFile(
      path.join(root, 'sources.json'),
      JSON.stringify(['https://old/index.json']),
      'utf8',
    );
    expect(await readSourcesFile(root)).toEqual({ indexes: ['https://old/index.json'] });

    await writeSourcesFile({ indexes: ['https://old/index.json'] }, root);
    const raw = JSON.parse(await readFile(path.join(root, 'sources.json'), 'utf8')) as {
      indexes: string[];
    };
    expect(raw.indexes).toEqual(['https://old/index.json']);
  });

  it('searchPlugins 只遍历 indexes（未知字段零 fetch）', async () => {
    // searchPlugins 读全局插件根 → 临时把 configDir 指到测试根（win 用 APPDATA）
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const savedAppdata = process.env.APPDATA;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.APPDATA = root;
    process.env.XDG_CONFIG_HOME = root;
    try {
      // 未知字段里放一个「看似 URL」的条目——解析不得把它当索引源
      await mkdir(path.join(root, 'weave', 'data', 'plugins'), { recursive: true });
      await writeFile(
        path.join(root, 'weave', 'data', 'plugins', 'sources.json'),
        JSON.stringify({ indexes: [], dirs: ['https://dir-as-url.example/index.json'] }),
        'utf8',
      );
      const results = await searchPlugins('');
      expect(results).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();

      // 旧形：string[] 整体视为 indexes（兼容不断）
      await writeFile(
        path.join(root, 'weave', 'data', 'plugins', 'sources.json'),
        JSON.stringify(['https://old.example/index.json']),
        'utf8',
      );
      expect(await readSourcesFile()).toEqual({ indexes: ['https://old.example/index.json'] });
    } finally {
      fetchSpy.mockRestore();
      if (savedAppdata === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = savedAppdata;
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
    }
  });
});
