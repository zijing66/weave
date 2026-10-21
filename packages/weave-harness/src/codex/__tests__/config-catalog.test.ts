import { describe, it, expect } from 'vitest';
import { CODEX_CONFIG_GROUPS, CODEX_CONFIG_KEYS } from '../config-catalog.generated.js';

describe('config-catalog 生成物', () => {
  it('词表规模够覆盖官方 schema', () => {
    expect(CODEX_CONFIG_KEYS.length).toBeGreaterThanOrEqual(400);
    expect(CODEX_CONFIG_GROUPS.length).toBeGreaterThanOrEqual(15);
  });

  it('键名唯一，且每条都有类型与分组', () => {
    const names = CODEX_CONFIG_KEYS.map((k) => k.key);
    expect(new Set(names).size).toBe(names.length);
    for (const k of CODEX_CONFIG_KEYS) {
      expect(k.type, k.key).toBeTruthy();
      expect(CODEX_CONFIG_GROUPS, k.key).toContain(k.group);
    }
  });

  it('project 层剥掉的键只归 user 档（codex loader 的 DENYLIST）', () => {
    for (const key of ['model_providers', 'profiles', 'notify', 'openai_base_url']) {
      const k = CODEX_CONFIG_KEYS.find((x) => x.key === key);
      expect(k?.scope, key).toBe('user');
    }
    const anyKey = CODEX_CONFIG_KEYS.find((x) => x.key === 'model');
    expect(anyKey?.scope).toBe('any');
  });

  it('map / 数组键都带形状，值结构有字段或标量类型', () => {
    for (const k of CODEX_CONFIG_KEYS) {
      if (k.shape === 'map' || k.shape === 'array') {
        expect(k.fields?.length || k.valueType, k.key).toBeTruthy();
      }
    }
    const mcp = CODEX_CONFIG_KEYS.find((k) => k.key === 'mcp_servers');
    expect(mcp?.shape).toBe('map');
    expect(mcp?.fields?.map((f) => f.name)).toContain('command');
    const hooks = CODEX_CONFIG_KEYS.find((k) => k.key === 'hooks.Stop');
    expect(hooks?.shape).toBe('array');
  });

  it('枚举键收得出候选值', () => {
    const approval = CODEX_CONFIG_KEYS.find((k) => k.key === 'approval_policy');
    expect(approval?.options).toEqual(expect.arrayContaining(['on-request', 'never']));
    const sandbox = CODEX_CONFIG_KEYS.find((k) => k.key === 'sandbox_mode');
    expect(sandbox?.options).toEqual(
      expect.arrayContaining(['read-only', 'workspace-write', 'danger-full-access']),
    );
  });

  it('折叠子树整键保留、不展开', () => {
    expect(CODEX_CONFIG_KEYS.some((k) => k.key === 'tui.keymap')).toBe(true);
    expect(CODEX_CONFIG_KEYS.some((k) => k.key.startsWith('tui.keymap.'))).toBe(false);
    expect(CODEX_CONFIG_KEYS.some((k) => k.key === 'notice')).toBe(true);
    expect(CODEX_CONFIG_KEYS.some((k) => k.key.startsWith('notice.'))).toBe(false);
  });
});
