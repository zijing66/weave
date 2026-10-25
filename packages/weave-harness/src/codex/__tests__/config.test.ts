import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CODEX_CONFIG } from '../config.js';
import { CodexTomlCorruptError } from '../toml.js';

let home: string;
let project: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'weave-codex-cfg-'));
  project = await mkdtemp(path.join(tmpdir(), 'weave-codex-proj-'));
  // codexHome() 无 home 参数时读 CODEX_HOME——本机装了 codex 就会读到真配置
  process.env.CODEX_HOME = home;
});

afterEach(async () => {
  delete process.env.CODEX_HOME;
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

// ctx 每次现取（beforeEach 会换临时目录，模块顶层求值会拿到旧值）
const userCtx = () => ({ projectPath: null, homedir: home });
const projCtx = () => ({ projectPath: project, homedir: home });
const userFile = () => path.join(home, '.codex', 'config.toml');
/** 预置一份 config.toml（.codex 目录一并建好）。 */
const seedUser = async (text: string): Promise<void> => {
  await mkdir(path.join(home, '.codex'), { recursive: true });
  await writeFile(userFile(), text);
};

describe('CODEX_CONFIG files/catalog', () => {
  it('两档：user（支持快照）+ project（不支持）', () => {
    const files = CODEX_CONFIG.files(userCtx());
    expect(files.map((f) => f.id)).toEqual(['user', 'project']);
    expect(files[0]!.profiles).toBe(true);
    expect(files[1]!.profiles).toBe(false);
    expect(files[0]!.path(userCtx())).toBe(userFile());
    expect(files[1]!.path(projCtx())).toBe(path.join(project, '.codex', 'config.toml'));
  });

  it('project 档剥掉 DENYLIST 键，user 档全量', () => {
    const user = CODEX_CONFIG.catalog('user');
    const proj = CODEX_CONFIG.catalog('project');
    expect(user.keys.some((k) => k.key === 'model_providers')).toBe(true);
    expect(proj.keys.some((k) => k.key === 'model_providers')).toBe(false);
    expect(proj.keys.some((k) => k.key === 'model')).toBe(true);
    expect(user.envVars).toEqual([]);
  });

  it('rawFormat 是 toml', () => {
    expect(CODEX_CONFIG.rawFormat).toBe('toml');
  });
});

describe('CODEX_CONFIG read/write', () => {
  it('文件不存在 → 空对象；写后能读回', async () => {
    expect(await CODEX_CONFIG.read('user', userCtx())).toEqual({});
    await CODEX_CONFIG.write('user', userCtx(), { model: 'gpt-5.2', approval_policy: 'never' });
    const values = await CODEX_CONFIG.read('user', userCtx());
    expect(values['model']).toBe('gpt-5.2');
    expect(values['approval_policy']).toBe('never');
  });

  it('写只动词表内的顶层键，未知键原样保留（write 是全量语义：values 缺的词表键会被删）', async () => {
    await seedUser('custom_unknown_key = "keep me"\nmodel = "gpt-5"\n[tui]\nnotifications = true\n');
    await CODEX_CONFIG.write('user', userCtx(), {
      model: 'gpt-5.2',
      tui: { notifications: true },
    });
    const text = await readFile(userFile(), 'utf-8');
    expect(text).toContain('custom_unknown_key = "keep me"');
    const values = await CODEX_CONFIG.read('user', userCtx());
    expect(values['model']).toBe('gpt-5.2');
    expect((values['tui'] as Record<string, unknown>)['notifications']).toBe(true);
  });

  it('删除词表键：values 里没有的顶层键从文件里消失', async () => {
    await seedUser('model = "gpt-5"\napproval_policy = "never"\n');
    await CODEX_CONFIG.write('user', userCtx(), { model: 'gpt-5' });
    const values = await CODEX_CONFIG.read('user', userCtx());
    expect(values['approval_policy']).toBeUndefined();
    expect(values['model']).toBe('gpt-5');
  });

  it('损坏的 TOML：读抛 CodexTomlCorruptError，写也拒', async () => {
    await seedUser('model = [unclosed\n');
    await expect(CODEX_CONFIG.read('user', userCtx())).rejects.toBeInstanceOf(CodexTomlCorruptError);
    await expect(CODEX_CONFIG.write('user', userCtx(), { model: 'x' })).rejects.toBeInstanceOf(
      CodexTomlCorruptError,
    );
  });

  it('project 档读写各自的 .codex/config.toml', async () => {
    await CODEX_CONFIG.write('project', projCtx(), { model: 'gpt-5-mini' });
    expect((await CODEX_CONFIG.read('project', projCtx()))['model']).toBe('gpt-5-mini');
    expect(await CODEX_CONFIG.read('user', userCtx())).toEqual({});
  });
});

describe('CODEX_CONFIG managedKeys', () => {
  it('weave 装的 MCP server 标出来；没有就不标', () => {
    expect(CODEX_CONFIG.managedKeys({})).toEqual([]);
    expect(CODEX_CONFIG.managedKeys({ mcp_servers: { weave: { command: 'npx' } } })).toEqual([
      'mcp_servers.weave',
    ]);
    expect(CODEX_CONFIG.managedKeys({ mcp_servers: { other: { command: 'x' } } })).toEqual([]);
  });

  it('managedEntries 恒空（两扇门写同一个值，不上锁）', () => {
    expect(CODEX_CONFIG.managedEntries({ plugins: { 'a@weave': { enabled: true } } })).toEqual([]);
  });
});

describe('CODEX_CONFIG models', () => {
  it('没配 model_catalog_json → 诚实回空', async () => {
    const r = await CODEX_CONFIG.models({ values: {} });
    expect(r.models).toEqual([]);
    expect(r.credential).toBe('none');
  });

  it('配了就读文件里的 models 数组（slug/display_name）', async () => {
    const catalogFile = path.join(home, 'catalog.json');
    await writeFile(
      catalogFile,
      JSON.stringify({
        models: [
          { slug: 'gpt-5.2', display_name: 'GPT-5.2', description: 'flagship' },
          { slug: 'o5', display_name: 'O5' },
        ],
      }),
    );
    const r = await CODEX_CONFIG.models({ values: { model_catalog_json: catalogFile } });
    expect(r.models.map((m) => m.id)).toEqual(['gpt-5.2', 'o5']);
    expect(r.models[0]!.name).toBe('GPT-5.2');
  });

  it('相对路径按 CODEX_HOME 解析（对齐 codex-rs AbsolutePathBufGuard）', async () => {
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(
      path.join(home, '.codex', 'cc-switch-model-catalog.json'),
      JSON.stringify({ models: [{ slug: 'rel-model' }] }),
    );
    const r = await CODEX_CONFIG.models({
      values: { model_catalog_json: 'cc-switch-model-catalog.json' },
      homedir: home,
    });
    expect(r.models.map((m) => m.id)).toEqual(['rel-model']);
  });

  it('~ 前缀展开到用户主目录', async () => {
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(
      path.join(home, '.codex', 'tilde-catalog.json'),
      JSON.stringify({ models: [{ slug: 'tilde-model' }] }),
    );
    const r = await CODEX_CONFIG.models({
      values: { model_catalog_json: '~/.codex/tilde-catalog.json' },
      homedir: home,
    });
    expect(r.models.map((m) => m.id)).toEqual(['tilde-model']);
  });

  it('文件缺失/坏 JSON → 明确报错', async () => {
    await expect(
      CODEX_CONFIG.models({ values: { model_catalog_json: path.join(home, 'nope.json') } }),
    ).rejects.toThrow('读不到');
    const bad = path.join(home, 'bad.json');
    await writeFile(bad, '{oops');
    await expect(CODEX_CONFIG.models({ values: { model_catalog_json: bad } })).rejects.toThrow(
      '不是合法 JSON',
    );
  });
});

describe('CODEX_CONFIG parseRaw/serializeRaw', () => {
  it('TOML 文本 ↔ 值对象往返', () => {
    const text = 'model = "gpt-5"\n[sandbox_workspace_write]\nnetwork_access = true\n';
    const values = CODEX_CONFIG.parseRaw(text);
    expect(values['model']).toBe('gpt-5');
    const back = CODEX_CONFIG.serializeRaw(values);
    expect(CODEX_CONFIG.parseRaw(back)).toEqual(values);
  });

  it('serializeRaw 产出合法 TOML 且 Windows 路径不被吃', () => {
    const text = CODEX_CONFIG.serializeRaw({
      model: 'gpt-5',
      projects: { 'd:\\a b': { trust_level: 'trusted' } },
    });
    expect(CODEX_CONFIG.parseRaw(text)).toEqual({
      model: 'gpt-5',
      projects: { 'd:\\a b': { trust_level: 'trusted' } },
    });
  });

  it('非表顶层（数组/标量）parseRaw 拒绝', () => {
    expect(() => CODEX_CONFIG.parseRaw('[1, 2]')).toThrow();
  });
});
