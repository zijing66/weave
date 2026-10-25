import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { CONFIG_SHAPE_OVERRIDES } from '../config-shapes.js';
import { CLAUDE_CONFIG, ensureTrustAccepted } from '../config.js';

const tmpDirs: string[] = [];

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-config-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function ctxOf(homedir: string, projectPath: string | null = null): { projectPath: string | null; homedir: string } {
  return { projectPath, homedir };
}

describe('claude 配置面', () => {
  it('四个档位的落点', () => {
    const home = tmpHome();
    const project = path.join(home, 'proj');
    const files = CLAUDE_CONFIG.files(ctxOf(home, project));
    const byId = Object.fromEntries(files.map((f) => [f.id, f.path(ctxOf(home, project))]));
    expect(byId['user']).toBe(path.join(home, '.claude', 'settings.json'));
    expect(byId['project']).toBe(path.join(project, '.claude', 'settings.json'));
    expect(byId['projectLocal']).toBe(path.join(project, '.claude', 'settings.local.json'));
    expect(byId['global']).toBe(path.join(home, '.claude.json'));
    const noProject = Object.fromEntries(files.map((f) => [f.id, f.path(ctxOf(home))]));
    expect(noProject['project']).toBe('');
  });

  it('global 档只给文档里的 global 键，且不摆 env 变量', () => {
    const catalog = CLAUDE_CONFIG.catalog('global');
    expect(catalog.keys.length).toBeGreaterThan(0);
    expect(catalog.keys.every((k) => k.scope === 'global')).toBe(true);
    expect(catalog.envVars).toEqual([]);
    expect(CLAUDE_CONFIG.catalog('user').envVars.length).toBeGreaterThan(300);
  });

  it('值形状：对象/数组类键不再把字段名当成分支选项', () => {
    const keys = [...CLAUDE_CONFIG.catalog('user').keys, ...CLAUDE_CONFIG.catalog('global').keys];
    const conflated = keys.filter((k) => k.shape === undefined && /object|array of|map of/i.test(k.type) && k.options?.length);
    expect(conflated.map((k) => k.key)).toEqual([]);

    const modelSettings = keys.find((k) => k.key === 'modelSettings');
    expect(modelSettings?.shape).toBe('map');
    expect(modelSettings?.fields?.find((f) => f.name === 'effortLevel')?.options).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('值形状：文档里写成「array of … each with …」的键都被覆盖表补上元素字段', () => {
    const keys = [...CLAUDE_CONFIG.catalog('user').keys, ...CLAUDE_CONFIG.catalog('global').keys];
    const rows = keys.filter((k) => /^array of (objects|rows)/i.test(k.type));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((k) => k.shape !== 'array' || !k.fields?.length).map((k) => k.key)).toEqual([]);

    // 覆盖表里的每个键都得在词表里真存在——文档改名时要在这里炸，而不是静默失效
    const byKey = new Map(keys.map((k) => [k.key, k]));
    expect(Object.keys(CONFIG_SHAPE_OVERRIDES).filter((key) => !byKey.has(key))).toEqual([]);
    for (const [key, override] of Object.entries(CONFIG_SHAPE_OVERRIDES)) {
      const spec = byKey.get(key);
      expect(spec?.shape ?? override.shape).toBe(override.shape);
      expect(spec?.fields?.map((f) => f.name)).toEqual(override.fields?.map((f) => f.name));
    }
  });

  it('读写回环：未知键原样保留，词表外的顶层键不被动', async () => {
    const home = tmpHome();
    const file = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ model: 'opus', userCrutch: { a: 1 } }), 'utf8');

    const before = await CLAUDE_CONFIG.read('user', ctxOf(home));
    expect(before['model']).toBe('opus');
    expect(before['userCrutch']).toBeUndefined();

    await CLAUDE_CONFIG.write('user', ctxOf(home), { model: 'sonnet', env: { FOO: '1' } });
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(after['model']).toBe('sonnet');
    expect(after['env']).toEqual({ FOO: '1' });
    expect(after['userCrutch']).toEqual({ a: 1 });
  });

  it('global 档写回只动文档键，其余键（projects 等）不动', async () => {
    const home = tmpHome();
    const file = path.join(home, '.claude.json');
    const globalKeys = CLAUDE_CONFIG.catalog('global').keys.map((k) => k.key);
    fs.writeFileSync(file, JSON.stringify({ projects: { '/x': {} }, [globalKeys[0]]: 'old' }), 'utf8');

    const before = await CLAUDE_CONFIG.read('global', ctxOf(home));
    expect(before['projects']).toBeUndefined();
    expect(before[globalKeys[0]]).toBe('old');

    await CLAUDE_CONFIG.write('global', ctxOf(home), { [globalKeys[0]]: 'new' });
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(after[globalKeys[0]]).toBe('new');
    expect(after['projects']).toEqual({ '/x': {} });
  });

  it('文件缺失 → 空对象；坏 JSON → 明确报错', async () => {
    const home = tmpHome();
    expect(await CLAUDE_CONFIG.read('user', ctxOf(home))).toEqual({});
    const file = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{oops', 'utf8');
    await expect(CLAUDE_CONFIG.read('user', ctxOf(home))).rejects.toThrow(/不是合法 JSON/);
  });

  it('模型列表：凭配置里的 baseUrl + key 取，解析 Anthropic 形状', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers });
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'claude-opus-5-5', display_name: 'Opus 5.5', created_at: '2026-01-01' }] }),
      };
    });
    try {
      const out = await CLAUDE_CONFIG.models({
        values: { env: { ANTHROPIC_BASE_URL: 'https://gw.example/v1/', ANTHROPIC_API_KEY: 'sk-1' } },
      });
      expect(out.baseUrl).toBe('https://gw.example');
      expect(out.credential).toBe('apiKey');
      expect(out.models).toEqual([{ id: 'claude-opus-5-5', name: 'Opus 5.5', createdAt: '2026-01-01' }]);
      expect(seen[0].url).toBe('https://gw.example/v1/models?limit=1000');
      expect(seen[0].headers['x-api-key']).toBe('sk-1');
      expect(seen[0].headers['anthropic-version']).toBe('2023-06-01');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('模型列表：显式入参优先，失败带 HTTP 状态', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }));
    try {
      await expect(
        CLAUDE_CONFIG.models({ values: {}, baseUrl: 'https://gw.example', authToken: 'tok' }),
      ).rejects.toThrow(/401/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('托管键按当前值判：weave 的 statusLine 才算', () => {
    const weave = CLAUDE_CONFIG.managedKeys({
      $comment: 'Generated by weave',
      hooks: {},
      statusLine: { command: 'node "/p/.claude/helpers/statusline.cjs"' },
      env: { WEAVE_ENABLED: 'true' },
    });
    expect(weave).toEqual(['$comment', 'hooks', 'env.WEAVE_ENABLED', 'statusLine']);

    const own = CLAUDE_CONFIG.managedKeys({
      statusLine: { command: 'node /home/me/my-statusline.cjs' },
      env: { ANTHROPIC_BASE_URL: 'https://gw' },
    });
    expect(own).toEqual([]);
  });

  it('permissions 不当整键托管：用户自己的规则与 defaultMode 都算自己的', () => {
    expect(
      CLAUDE_CONFIG.managedKeys({
        permissions: { allow: ['Bash(git:*)'], defaultMode: 'bypassPermissions' },
      }),
    ).toEqual([]);
  });

  it('托管条目只报值里真在的那几条 weave 规则', () => {
    const entries = CLAUDE_CONFIG.managedEntries({
      permissions: {
        allow: ['Bash(git:*)', 'Bash(npm:*)'],
        deny: ['Read(./.env)', 'Read(./secrets/*)'],
      },
    });
    expect(entries).toEqual([
      { path: 'permissions.allow', entry: 'Bash(npm:*)' },
      { path: 'permissions.deny', entry: 'Read(./.env)' },
      { path: 'permissions.deny', entry: 'Read(./secrets/*)' },
    ]);
    expect(CLAUDE_CONFIG.managedEntries({ permissions: { allow: ['Bash(git:*)'] } })).toEqual([]);
  });

  it('enabledPlugins 只锁 weave 市场的键，其他市场的是用户自己的', () => {
    const entries = CLAUDE_CONFIG.managedEntries({
      enabledPlugins: {
        'weave-plugin-creator@weave': true,
        'figma@claude-plugins-official': false,
        'rust-analyzer-lsp@claude-plugins-official': true,
      },
    });
    expect(entries).toEqual([{ path: 'enabledPlugins', entry: 'weave-plugin-creator@weave' }]);
    expect(CLAUDE_CONFIG.managedKeys({ enabledPlugins: { 'figma@claude-plugins-official': true } })).toEqual([]);
  });
});

describe('ensureTrustAccepted（信任预写）', () => {
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  });

  /** os.homedir() 在 win32 认 USERPROFILE、posix 认 HOME——两边都指过去。 */
  function pointHomeAt(dir: string): void {
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
  }

  const claudeJsonOf = (home: string): string => path.join(home, '.claude.json');

  it('未信任 → 写入 projects[正斜杠原大小写].hasTrustDialogAccepted=true，其余键原样保留', async () => {
    const home = tmpHome();
    pointHomeAt(home);
    fs.writeFileSync(
      claudeJsonOf(home),
      JSON.stringify({ model: 'opus', projects: { 'D:/Other/Proj': { allowedTools: ['Bash'] } } }),
      'utf8',
    );

    const project = path.join(home, 'My Proj');
    await ensureTrustAccepted(project);

    const after = JSON.parse(fs.readFileSync(claudeJsonOf(home), 'utf8')) as {
      model?: string;
      projects: Record<string, Record<string, unknown>>;
    };
    expect(after.model).toBe('opus');
    expect(after.projects['D:/Other/Proj']).toEqual({ allowedTools: ['Bash'] });
    // 键形 = path.resolve 归一成正斜杠、保留原大小写（claude 2.1.296 实测）
    const expectedKey = path.resolve(project).replace(/\\/g, '/');
    expect(after.projects[expectedKey]).toEqual({ hasTrustDialogAccepted: true });
  });

  it('projects 缺失/非对象 → 新建；文件缺失 → 从零建', async () => {
    const home = tmpHome();
    pointHomeAt(home);
    fs.writeFileSync(claudeJsonOf(home), '{"numProjects": 1}', 'utf8');
    await ensureTrustAccepted(path.join(home, 'p1'));

    const home2 = tmpHome();
    pointHomeAt(home2);
    await ensureTrustAccepted(path.join(home2, 'p2'));

    const a = JSON.parse(fs.readFileSync(claudeJsonOf(home), 'utf8')) as Record<string, unknown>;
    expect(a['numProjects']).toBe(1);
    expect(Object.keys(a['projects'] as object)).toHaveLength(1);
    const b = JSON.parse(fs.readFileSync(claudeJsonOf(home2), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(b['projects'] as object)).toHaveLength(1);
  });

  it('已信任 → no-op（文件字节不动）', async () => {
    const home = tmpHome();
    pointHomeAt(home);
    const project = path.join(home, 'already');
    const key = path.resolve(project).replace(/\\/g, '/');
    const seeded = JSON.stringify({ projects: { [key]: { hasTrustDialogAccepted: true } } });
    fs.writeFileSync(claudeJsonOf(home), seeded, 'utf8');

    await ensureTrustAccepted(project);
    expect(fs.readFileSync(claudeJsonOf(home), 'utf8')).toBe(seeded);
  });

  it('坏 JSON → 抛错不写', async () => {
    const home = tmpHome();
    pointHomeAt(home);
    fs.writeFileSync(claudeJsonOf(home), '{oops', 'utf8');
    await expect(ensureTrustAccepted(path.join(home, 'p'))).rejects.toThrow(/不是合法 JSON/);
    expect(fs.readFileSync(claudeJsonOf(home), 'utf8')).toBe('{oops');
  });
});
