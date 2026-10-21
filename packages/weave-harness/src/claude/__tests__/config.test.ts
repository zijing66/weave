import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CLAUDE_CONFIG } from '../config.js';

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
      permissions: { allow: [] },
      statusLine: { command: 'node "/p/.claude/helpers/statusline.cjs"' },
      env: { WEAVE_ENABLED: 'true' },
    });
    expect(weave).toEqual(['$comment', 'hooks', 'permissions', 'env.WEAVE_ENABLED', 'statusLine']);

    const own = CLAUDE_CONFIG.managedKeys({
      statusLine: { command: 'node /home/me/my-statusline.cjs' },
      env: { ANTHROPIC_BASE_URL: 'https://gw' },
    });
    expect(own).toEqual([]);
  });
});
