import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../db/db.js';
import { HookRuleRepository } from '../../repositories/hook-rules.js';
import { PluginStateRepository } from '../../repositories/plugin-states.js';
import { HookRuleRegistry } from '../registry.js';
import { WeavePluginLoader, loadAllPlugins } from '../plugin-loader.js';

/**
 * 批 10：plugin-loader 深度扫描根（harness-tools / add-dir 树）。
 * depth-3 weave 成分装载、首见默认停用、浅层根与深度根互不误删、
 * 消失包级联摘除。既有 plugin-loader.test.ts 零改动（新用例独立成文件）。
 */

async function writeWeavePack(root: string, relDir: string, id: string): Promise<string> {
  const dir = path.join(root, ...relDir.split('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'weave-plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      id,
      name: id,
      version: '1.0.0',
      rules: ['rules.json'],
    }),
  );
  await writeFile(
    path.join(dir, 'rules.json'),
    JSON.stringify([
      {
        name: `${id} 规则`,
        source: { kind: 'claude-event', event: 'Stop' },
        handler: { type: 'manual', template: 'x' },
      },
    ]),
  );
  return dir;
}

describe('WeavePluginLoader 深度扫描根（批 10）', () => {
  let db: DatabaseSync;
  let rules: HookRuleRepository;
  let states: PluginStateRepository;
  let registry: HookRuleRegistry;
  let loader: WeavePluginLoader;
  let root: string;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    rules = new HookRuleRepository(db);
    states = new PluginStateRepository(db);
    registry = new HookRuleRegistry(rules);
    loader = new WeavePluginLoader({ rules, registry, states });
    root = await mkdtemp(path.join(tmpdir(), 'weave-tk-loader-'));
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('loadToolkitRoot：depth-3 weave 包装载 + 首见默认停用（opt-in）', async () => {
    await writeWeavePack(root, 'doc-hooks/md-lint', 'md-lint');

    const loaded = await loader.loadToolkitRoot(path.join(root, 'x'), 'builtin', null);
    expect(loaded).toHaveLength(0); // 根不存在 = 无包

    const tree = path.join(root, 'tools');
    await writeWeavePack(tree, 'doc-hooks/md-lint', 'md-lint');
    const fromTree = await loader.loadToolkitRoot(tree, 'builtin', null);
    expect(fromTree).toHaveLength(1);
    expect(fromTree[0]).toMatchObject({ id: 'md-lint', status: 'disabled', ruleCount: 1 });
    expect(states.get('md-lint')?.enabled).toBe(false);

    // 规则入库但被级联停用（plugin_states = 级联事实）
    const list = rules.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ enabled: false, pluginId: 'md-lint', origin: 'builtin' });

    // 开关级联到包
    expect(loader.setPluginEnabled('md-lint', true)).toBe(true);
    expect(rules.list()[0]!.enabled).toBe(true);
    expect(loader.list().find((p) => p.id === 'md-lint')?.status).toBe('active');
  });

  it('已有状态行（用户先开过）不被首见默认停用覆盖', async () => {
    states.setEnabled('md-lint', true);
    const tree = path.join(root, 'tools');
    await writeWeavePack(tree, 'doc-hooks/md-lint', 'md-lint');
    const loaded = await loader.loadToolkitRoot(tree, 'builtin', null);
    expect(loaded[0]).toMatchObject({ status: 'active' });
    expect(rules.list()[0]!.enabled).toBe(true);
  });

  it('仅 CC / 裸表面成分的包不进 loader（无 weave 成分零条目）', async () => {
    const cc = path.join(root, 'tools', 'skills-pack');
    await mkdir(path.join(cc, '.claude-plugin'), { recursive: true });
    await writeFile(
      path.join(cc, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'skills-pack', version: '0.1.0' }),
    );
    const loaded = await loader.loadToolkitRoot(path.join(root, 'tools'), 'global', null);
    expect(loaded).toHaveLength(0);
  });

  it('浅层根扫描跳过已登记深度根容器；深层包不被浅层重扫误删', async () => {
    const presets = path.join(root, 'presets');
    await writeWeavePack(presets, 'weave-plain', 'weave-plain');
    const harnessTools = path.join(presets, 'harness-tools');
    await writeWeavePack(harnessTools, 'doc-hooks/md-lint', 'md-lint');

    // 深度根先登记（与 loadAllPlugins 顺序一致）
    await loader.loadToolkitRoot(harnessTools, 'builtin', null);
    await loader.loadRoot(presets, 'builtin', null);

    const ids = loader.list().map((p) => p.id).sort();
    // 无 harness-tools 幽灵 rejected 条目；两根插件共存
    expect(ids).toEqual(['md-lint', 'weave-plain']);
    expect(rules.list().map((r) => r.pluginId).sort()).toEqual(['md-lint', 'weave-plain']);

    // 浅层再次重扫（热重载路径）——深度根插件仍在
    await loader.loadRoot(presets, 'builtin', null);
    expect(loader.list().map((p) => p.id).sort()).toEqual(['md-lint', 'weave-plain']);
    expect(rules.list()).toHaveLength(2);
  });

  it('深度根里的包目录消失 → 规则/条目级联摘除，浅层包不受影响', async () => {
    const presets = path.join(root, 'presets');
    await writeWeavePack(presets, 'weave-plain', 'weave-plain');
    const packDir = await writeWeavePack(
      path.join(presets, 'harness-tools'),
      'doc-hooks/md-lint',
      'md-lint',
    );

    await loader.loadToolkitRoot(path.join(presets, 'harness-tools'), 'builtin', null);
    await loader.loadRoot(presets, 'builtin', null);
    expect(rules.list()).toHaveLength(2);

    await rm(packDir, { recursive: true, force: true });
    await loader.loadToolkitRoot(path.join(presets, 'harness-tools'), 'builtin', null);

    expect(loader.list().map((p) => p.id)).toEqual(['weave-plain']);
    expect(rules.list().map((r) => r.pluginId)).toEqual(['weave-plain']);
  });

  it('loadAllPlugins 冒烟：内置 md-lint 注册且默认停用；presets 无 harness-tools 幽灵条目', async () => {
    const { loader: full, loaded } = await loadAllPlugins(
      { rules, registry, states },
      [],
    );
    const byId = new Map(loaded.map((p) => [p.id, p]));
    // 批 10 工具包树的 weave 成分进加载器，首见停用
    expect(byId.get('md-lint')).toMatchObject({ status: 'disabled', scope: 'builtin' });
    expect(states.get('md-lint')?.enabled).toBe(false);
    // 既有内置 presets 不受影响
    expect(byId.has('weave-doc-update-check')).toBe(true);
    // 浅层 presets 扫描不把 harness-tools 容器当插件位
    expect(full.list().some((p) => p.id === 'harness-tools')).toBe(false);
    expect(full.list().filter((p) => p.status === 'rejected' && p.dir.includes('harness-tools'))).toEqual([]);
  });
});
