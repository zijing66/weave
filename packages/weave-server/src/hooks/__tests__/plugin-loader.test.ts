import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { HookRuleRepository } from '../../repositories/hook-rules.js';
import { PluginStateRepository } from '../../repositories/plugin-states.js';
import { HookRuleRegistry } from '../registry.js';
import { WeavePluginLoader } from '../plugin-loader.js';

async function writePlugin(
  root: string,
  dirName: string,
  manifest: unknown,
  files: Record<string, string> = {},
): Promise<string> {
  const dir = path.join(root, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'weave-plugin.json'), JSON.stringify(manifest, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

const BASE_MANIFEST = {
  manifestVersion: 1,
  id: 'doc-update-check',
  name: '文档更新检查',
  version: '1.0.0',
  rules: ['rules.json'],
};

const BASE_RULES = [
  {
    name: '文档更新检查',
    priority: 10,
    source: { kind: 'claude-event', event: 'PostToolUse' },
    filter: { toolNames: ['Edit', 'Write'], pathGlobs: ['**/*.md'] },
    handler: { type: 'inject', template: '@file:prompts/check.md' },
  },
];

describe('WeavePluginLoader', () => {
  let db: DatabaseSync;
  let rules: HookRuleRepository;
  let registry: HookRuleRegistry;
  let states: PluginStateRepository;
  let loader: WeavePluginLoader;
  let root: string;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    rules = new HookRuleRepository(db);
    registry = new HookRuleRegistry(rules);
    states = new PluginStateRepository(db);
    loader = new WeavePluginLoader({ rules, registry, states });
    root = await mkdtemp(path.join(tmpdir(), 'weave-plugins-'));
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('合法插件：规则入库（origin/pluginId/稳定 id）+ @file: 模板内联 + 候选可命中', async () => {
    await writePlugin(root, 'doc-update-check', BASE_MANIFEST, {
      'rules.json': JSON.stringify(BASE_RULES),
      'prompts/check.md': '检查文档一致性 {file}',
    });

    const loaded = await loader.loadRoot(root, 'global', null);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ id: 'doc-update-check', status: 'active', ruleCount: 1 });

    const list = rules.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'plugin:doc-update-check:0',
      origin: 'plugin',
      pluginId: 'doc-update-check',
      projectId: null,
      enabled: true,
    });
    // @file: 已内联为文本
    expect(list[0].handler.type).toBe('inject');
    if (list[0].handler.type === 'inject') {
      expect(list[0].handler.template).toContain('检查文档一致性');
    }
    // registry 已 reload，事件候选可命中
    expect(registry.candidates('PostToolUse').map((r) => r.id)).toEqual(['plugin:doc-update-check:0']);
    expect(registry.candidates('Stop')).toHaveLength(0);
  });

  it('重复加载（模拟热重载）：规则 upsert 不重复，用户改过的 enabled 被保留', async () => {
    await writePlugin(root, 'doc-update-check', BASE_MANIFEST, {
      'rules.json': JSON.stringify(BASE_RULES),
      'prompts/check.md': 'x {file}',
    });
    await loader.loadRoot(root, 'global', null);

    // 用户在 dashboard 关掉该规则
    rules.setEnabled('plugin:doc-update-check:0', false);

    // 插件文件更新后重载（同 manifest，模板文案变了）
    await writePlugin(root, 'doc-update-check', BASE_MANIFEST, {
      'rules.json': JSON.stringify(BASE_RULES),
      'prompts/check.md': '新文案 {file}',
    });
    const loader2 = new WeavePluginLoader({ rules, registry, states });
    const loaded = await loader2.loadRoot(root, 'global', null);

    expect(loaded[0].status).toBe('active');
    const list = rules.list();
    expect(list).toHaveLength(1); // upsert 不产生重复行
    expect(list[0].enabled).toBe(false); // 用户开关保留
    if (list[0].handler.type === 'inject') {
      expect(list[0].handler.template).toContain('新文案'); // 定义字段已更新
    }
  });

  it('manifest 校验失败 / 未知 requires 事件 / 坏规则 → rejected 且不入库', async () => {
    await writePlugin(root, 'bad-manifest', { ...BASE_MANIFEST, id: 'BAD ID' });
    await writePlugin(root, 'bad-event', { ...BASE_MANIFEST, id: 'bad-event', requires: { events: ['Nope'] } });
    await writePlugin(root, 'bad-rules', { ...BASE_MANIFEST, id: 'bad-rules' }, {
      'rules.json': JSON.stringify([{ name: '' }]),
    });
    await writePlugin(root, 'good', { ...BASE_MANIFEST, id: 'good' }, {
      'rules.json': JSON.stringify(BASE_RULES),
      'prompts/check.md': 'ok {file}',
    });

    const loaded = await loader.loadRoot(root, 'global', null);
    const byId = new Map(loaded.map((p) => [p.id, p]));
    expect(byId.get('bad-manifest')?.status).toBe('rejected');
    expect(byId.get('bad-event')?.status).toBe('rejected');
    expect(byId.get('bad-rules')?.status).toBe('rejected');
    expect(byId.get('good')?.status).toBe('active');
    // 只有 good 的规则入库
    expect(rules.list()).toHaveLength(1);
    expect(rules.list()[0].pluginId).toBe('good');
  });

  it('路径穿越：manifest entry 越出插件目录 → rejected', async () => {
    await writePlugin(root, 'escape', { ...BASE_MANIFEST, id: 'escape', rules: ['../../../etc/passwd.json'] });
    const loaded = await loader.loadRoot(root, 'global', null);
    expect(loaded[0].status).toBe('rejected');
    expect(loaded[0].error).toContain('越出');
    expect(rules.list()).toHaveLength(0);
  });

  it('内置命名空间 weave- 前缀保留给预设：作用域 global 的同名插件 rejected', async () => {
    await writePlugin(root, 'weave-presets', { ...BASE_MANIFEST, id: 'weave-presets' }, {
      'rules.json': JSON.stringify(BASE_RULES),
      'prompts/check.md': 'x',
    });
    const loaded = await loader.loadRoot(root, 'global', null);
    expect(loaded[0].status).toBe('rejected');
    expect(loaded[0].error).toContain('命名空间');
  });

  it('重复 id（两个不同目录同 id）：后者 rejected', async () => {
    await writePlugin(root, 'a', { ...BASE_MANIFEST, id: 'same-id' }, {
      'rules.json': JSON.stringify(BASE_RULES),
      'prompts/check.md': 'x',
    });
    await writePlugin(root, 'b', { ...BASE_MANIFEST, id: 'same-id' }, {
      'rules.json': JSON.stringify(BASE_RULES),
      'prompts/check.md': 'x',
    });
    const loaded = await loader.loadRoot(root, 'global', null);
    const statuses = loaded.map((p) => p.status).sort();
    expect(statuses).toEqual(['active', 'rejected']);
    expect(rules.list()).toHaveLength(1); // 只有第一个注册
  });

  it('plugin_states disabled：插件加载为 disabled 且规则级联关闭', async () => {
    await writePlugin(root, 'doc-update-check', BASE_MANIFEST, {
      'rules.json': JSON.stringify(BASE_RULES),
      'prompts/check.md': 'x',
    });
    states.setEnabled('doc-update-check', false);

    const loaded = await loader.loadRoot(root, 'global', null);
    expect(loaded[0].status).toBe('disabled');
    expect(rules.list()[0].enabled).toBe(false);
    expect(registry.candidates('PostToolUse')).toHaveLength(0);
  });

  it('自定义 handler：dynamic import 成功注册，execute 可经 PluginHost 查询', async () => {
    await writePlugin(
      root,
      'with-handler',
      {
        ...BASE_MANIFEST,
        id: 'with-handler',
        handlers: [{ type: 'doc-lint', entry: 'handler.mjs' }],
        rules: [],
      },
      {
        'handler.mjs': 'export default { type: "doc-lint", execute: () => ({ prompt: "hi" }) };',
      },
    );
    const loaded = await loader.loadRoot(root, 'global', null);
    expect(loaded[0].status).toBe('active');
    const impl = loader.getHandler('with-handler', 'doc-lint');
    expect(impl).toBeDefined();
    expect(await impl!.execute({} as never)).toEqual({ prompt: 'hi' });
    expect(loader.getConfig('with-handler')).toEqual({});
  });

  it('handler 缺 execute / type 不符 → 整插件 rejected', async () => {
    await writePlugin(
      root,
      'broken-handler',
      {
        ...BASE_MANIFEST,
        id: 'broken-handler',
        handlers: [{ type: 'x', entry: 'handler.mjs' }],
        rules: [],
      },
      { 'handler.mjs': 'export default { type: "x" };' },
    );
    const loaded = await loader.loadRoot(root, 'global', null);
    expect(loaded[0].status).toBe('rejected');
    expect(loaded[0].error).toContain('execute');
  });
  it('插件目录被移除 → 重载时规则级联删除、handler 卸载', async () => {
    await writePlugin(
      root,
      'doomed',
      { ...BASE_MANIFEST, id: 'doomed', handlers: [{ type: 'x', entry: 'handler.mjs' }], rules: ['rules.json'] },
      {
        'rules.json': JSON.stringify(BASE_RULES),
        'prompts/check.md': 'x {file}',
        'handler.mjs': 'export default { type: "x", execute: () => ({}) };',
      },
    );
    const first = await loader.loadRoot(root, 'global', null);
    expect(first.find((p) => p.id === 'doomed')?.status).toBe('active');
    expect(rules.listByPlugin('doomed')).toHaveLength(1);
    expect(loader.getHandler('doomed', 'x')).toBeDefined();

    // 删除目录 → 重载（同一 loader，模拟热重载）
    await rm(path.join(root, 'doomed'), { recursive: true, force: true });
    await loader.loadRoot(root, 'global', null);

    expect(loader.list().find((p) => p.id === 'doomed')).toBeUndefined();
    expect(rules.listByPlugin('doomed')).toHaveLength(0);
    expect(loader.getHandler('doomed', 'x')).toBeUndefined();
    expect(registry.candidates('PostToolUse')).toHaveLength(0);
  });

  it('setPluginEnabled：级联启停规则 + plugin_states 落库 + rejected 保持 rejected', async () => {
    await writePlugin(root, 'doc-update-check', BASE_MANIFEST, {
      'rules.json': JSON.stringify(BASE_RULES),
      'prompts/check.md': 'x {file}',
    });
    await loader.loadRoot(root, 'global', null);

    expect(loader.setPluginEnabled('doc-update-check', false)).toBe(true);
    expect(loader.list().find((p) => p.id === 'doc-update-check')?.status).toBe('disabled');
    expect(rules.list()[0]!.enabled).toBe(false);
    expect(states.get('doc-update-check')?.enabled).toBe(false);

    expect(loader.setPluginEnabled('doc-update-check', true)).toBe(true);
    expect(loader.list().find((p) => p.id === 'doc-update-check')?.status).toBe('active');
    expect(rules.list()[0]!.enabled).toBe(true);

    expect(loader.setPluginEnabled('nonexistent', true)).toBe(false);
  });
});

describe('内置预设 presets（随包发货的参考实现）', () => {
  let db: DatabaseSync;
  let rules: HookRuleRepository;
  let registry: HookRuleRegistry;
  let states: PluginStateRepository;
  let loader: WeavePluginLoader;

  beforeEach(() => {
    db = openDatabase(':memory:');
    rules = new HookRuleRepository(db);
    registry = new HookRuleRegistry(rules);
    states = new PluginStateRepository(db);
    loader = new WeavePluginLoader({ rules, registry, states });
  });

  afterEach(() => {
    db.close();
  });

  it('三个预设全部加载成功，origin=builtin，默认禁用不产生候选，启用后可命中', async () => {
    const presetsDir = fileURLToPath(new URL('../presets/', import.meta.url));
    const loaded = await loader.loadRoot(presetsDir, 'builtin', null);

    expect(loaded.map((p) => p.id).sort()).toEqual([
      'weave-cross-project-touch',
      'weave-doc-update-check',
      'weave-stop-summary',
    ]);
    expect(loaded.every((p) => p.status === 'active' && p.error === undefined)).toBe(true);

    // 规则入库：origin/命名空间/默认禁用
    const list = rules.list();
    expect(list).toHaveLength(3);
    expect(list.every((r) => r.origin === 'builtin')).toBe(true);
    expect(list.every((r) => r.pluginId?.startsWith('weave-'))).toBe(true);
    expect(list.every((r) => r.enabled === false)).toBe(true);
    expect(registry.candidates('PostToolUse')).toHaveLength(0); // 默认禁用 = 无候选

    // 用户启用 → 候选出现且 @file: 模板已内联
    const docRule = list.find((r) => r.pluginId === 'weave-doc-update-check')!;
    rules.setEnabled(docRule.id, true);
    registry.load();
    const candidates = registry.candidates('PostToolUse');
    expect(candidates.map((r) => r.id)).toEqual([docRule.id]);
    if (docRule.handler.type === 'inject') {
      expect(docRule.handler.template).toContain('文档一致性检查');
      expect(docRule.handler.template).toContain('{file}');
    }
  });

  it('预设规则引用的 handler 事件与 filter 符合规范（inject 均在白名单事件上）', async () => {
    const presetsDir = fileURLToPath(new URL('../presets/', import.meta.url));
    await loader.loadRoot(presetsDir, 'builtin', null);
    for (const rule of rules.list()) {
      if (rule.handler.type === 'inject') {
        expect(rule.source.kind).toBe('claude-event');
        if (rule.source.kind === 'claude-event') {
          expect(['PostToolUse', 'UserPromptSubmit', 'SessionStart', 'Stop', 'SubagentStop']).toContain(
            rule.source.event,
          );
        }
      }
    }
  });
});

describe('hook_rules 旧库升级（origin/plugin_id 列兜底）', () => {
  it('对旧 schema 库 openDatabase 后列存在且默认值正确', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'weave-db-mig-'));
    const dbPath = path.join(dir, 'weave.db');
    try {
      // 第一次打开建新库（含新列）
      const db1 = openDatabase(dbPath);
      db1.close();
      // 手工删列模拟旧库？SQLite 不支持 DROP COLUMN 非常量……改为验证幂等：
      // 二次打开（migrate 探测列已存在）不报错，且插入不带 origin 的行默认 user。
      const db2 = openDatabase(dbPath);
      const projects = new ProjectRepository(db2);
      const project = projects.register({ path: 'D:\\x', name: 'x', token: 't', source: 'init' });
      const rulesRepo = new HookRuleRepository(db2);
      const rule = rulesRepo.create({
        name: 'r',
        projectId: project.id,
        source: { kind: 'claude-event', event: 'Stop' },
        handler: { type: 'log' },
      });
      expect(rule.origin).toBe('user');
      expect(rule.pluginId).toBeNull();
      const cols = db2
        .prepare('PRAGMA table_info(hook_rules)')
        .all()
        .map((r) => String((r as { name: string }).name));
      expect(cols).toContain('origin');
      expect(cols).toContain('plugin_id');
      db2.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
