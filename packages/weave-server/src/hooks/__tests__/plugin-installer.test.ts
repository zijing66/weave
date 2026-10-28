import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// pruneInstallTmp 读 getTmpDir()：指到临时目录，别碰真数据目录的 cache/tmp。
const tmpRoot = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../db/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/paths.js')>()),
  getTmpDir: () => tmpRoot.dir,
}));

import { installPlugin, uninstallPlugin, exportPlugin, isGitSource, pruneInstallTmp } from '../plugin-installer.js';

async function writeSourcePlugin(root: string, id: string, extra: Record<string, unknown> = {}): Promise<string> {
  const dir = path.join(root, id);
  await mkdir(path.join(dir, 'prompts'), { recursive: true });
  await writeFile(
    path.join(dir, 'weave-plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      id,
      name: `插件 ${id}`,
      version: '1.0.0',
      rules: ['rules.json'],
      ...extra,
    }),
  );
  await writeFile(
    path.join(dir, 'rules.json'),
    JSON.stringify([
      {
        name: 'r',
        source: { kind: 'claude-event', event: 'Stop' },
        handler: { type: 'manual', template: 'x' },
      },
    ]),
  );
  await writeFile(path.join(dir, 'README.md'), '# readme');
  await mkdir(path.join(dir, 'node_modules', 'junk'), { recursive: true });
  await writeFile(path.join(dir, 'node_modules', 'junk', 'x.js'), 'junk');
  return dir;
}

describe('plugin-installer', () => {
  let srcRoot: string;
  let destRoot: string;

  beforeEach(async () => {
    srcRoot = await mkdtemp(path.join(tmpdir(), 'weave-pi-src-'));
    destRoot = await mkdtemp(path.join(tmpdir(), 'weave-pi-dest-'));
    tmpRoot.dir = mkdtempSync(path.join(tmpdir(), 'weave-pi-tmp-'));
  });

  afterEach(async () => {
    await rm(srcRoot, { recursive: true, force: true });
    await rm(destRoot, { recursive: true, force: true });
    await rm(tmpRoot.dir, { recursive: true, force: true });
  });

  it('isGitSource：识别 URL，拒绝普通路径', () => {
    expect(isGitSource('https://github.com/x/y')).toBe(true);
    expect(isGitSource('git@github.com:x/y.git')).toBe(true);
    expect(isGitSource('/local/dir')).toBe(false);
    expect(isGitSource('C:\\local\\dir')).toBe(false);
  });

  it('installPlugin（本地目录）：复制进目标根、剔除 node_modules、写 installed.json', async () => {
    const src = await writeSourcePlugin(srcRoot, 'demo-a');
    const result = await installPlugin(src, { root: destRoot });

    expect(result.installed).toHaveLength(1);
    expect(result.installed[0]).toMatchObject({ id: 'demo-a', version: '1.0.0' });
    expect(existsSync(path.join(destRoot, 'demo-a', 'weave-plugin.json'))).toBe(true);
    expect(existsSync(path.join(destRoot, 'demo-a', 'node_modules'))).toBe(false);
    expect(result.warnings).toHaveLength(0); // 本地来源无风险警告

    const manifest = JSON.parse(await readFile(path.join(destRoot, 'installed.json'), 'utf8')) as Array<{
      id: string;
      source: string;
    }>;
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({ id: 'demo-a', source: src });
  });

  it('installPlugin：源目录含多个插件子目录时全部安装；重复安装覆盖更新', async () => {
    await writeSourcePlugin(srcRoot, 'multi-a');
    await writeSourcePlugin(srcRoot, 'multi-b');
    const result = await installPlugin(srcRoot, { root: destRoot });
    expect(result.installed.map((p) => p.id).sort()).toEqual(['multi-a', 'multi-b']);

    // 再装一次 = 幂等覆盖
    const again = await installPlugin(srcRoot, { root: destRoot });
    expect(again.installed).toHaveLength(2);
    const manifest = JSON.parse(await readFile(path.join(destRoot, 'installed.json'), 'utf8')) as unknown[];
    expect(manifest).toHaveLength(2);
  });

  it('installPlugin：非法源（不存在 / 无 manifest）报错', async () => {
    await expect(installPlugin(path.join(srcRoot, 'nope'), { root: destRoot })).rejects.toThrow(/不存在/);
    await mkdir(path.join(srcRoot, 'empty'), { recursive: true });
    await expect(installPlugin(path.join(srcRoot, 'empty'), { root: destRoot })).rejects.toThrow(/weave-plugin/);
  });

  it('uninstallPlugin：删目录 + 清清单；无清单的目录扫描安装按 id 删', async () => {
    const src = await writeSourcePlugin(srcRoot, 'gone');
    await installPlugin(src, { root: destRoot });
    expect(existsSync(path.join(destRoot, 'gone'))).toBe(true);

    expect(await uninstallPlugin('gone', { root: destRoot })).toBe(true);
    expect(existsSync(path.join(destRoot, 'gone'))).toBe(false);
    const manifest = JSON.parse(await readFile(path.join(destRoot, 'installed.json'), 'utf8')) as unknown[];
    expect(manifest).toHaveLength(0);

    expect(await uninstallPlugin('never-existed', { root: destRoot })).toBe(false);
  });

  it('exportPlugin：导出可分发目录（剔除 node_modules），目标已存在则覆盖', async () => {
    const src = await writeSourcePlugin(srcRoot, 'share-me');
    await installPlugin(src, { root: destRoot });

    const out = path.join(srcRoot, 'out');
    const dest = await exportPlugin('share-me', out, { root: destRoot });
    expect(dest).toBe(path.join(out, 'share-me'));
    expect(existsSync(path.join(dest, 'rules.json'))).toBe(true);
    expect(existsSync(path.join(dest, 'node_modules'))).toBe(false);

    // 覆盖导出不报错
    await exportPlugin('share-me', out, { root: destRoot });
    await expect(exportPlugin('missing', out, { root: destRoot })).rejects.toThrow(/不存在/);
  });

  it('pruneInstallTmp：只清 install-* 残留，别的 tmp 内容不动', () => {
    mkdirSync(path.join(tmpRoot.dir, 'install-123'), { recursive: true });
    writeFileSync(path.join(tmpRoot.dir, 'install-123', 'repo'), 'x');
    mkdirSync(path.join(tmpRoot.dir, 'install-456'), { recursive: true });
    mkdirSync(path.join(tmpRoot.dir, 'uploads'), { recursive: true });
    writeFileSync(path.join(tmpRoot.dir, 'keep.txt'), 'x');

    pruneInstallTmp();

    expect(existsSync(path.join(tmpRoot.dir, 'install-123'))).toBe(false);
    expect(existsSync(path.join(tmpRoot.dir, 'install-456'))).toBe(false);
    expect(existsSync(path.join(tmpRoot.dir, 'uploads'))).toBe(true);
    expect(existsSync(path.join(tmpRoot.dir, 'keep.txt'))).toBe(true);
  });

  it('pruneInstallTmp：tmp 区不存在时静默返回', () => {
    tmpRoot.dir = path.join(tmpRoot.dir, 'no-such-dir');
    expect(() => pruneInstallTmp()).not.toThrow();
  });
});
