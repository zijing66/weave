import { describe, it, expect } from 'vitest';
import {
  CLAUDE_ENV_VARS,
  CLAUDE_SETTINGS_GROUPS,
  CLAUDE_SETTINGS_KEYS,
} from '../settings-catalog.generated.js';

describe('settings-catalog 生成物', () => {
  it('词表规模够覆盖官方文档', () => {
    expect(CLAUDE_SETTINGS_KEYS.length).toBeGreaterThanOrEqual(200);
    expect(CLAUDE_ENV_VARS.length).toBeGreaterThanOrEqual(300);
    expect(CLAUDE_SETTINGS_GROUPS.length).toBeGreaterThanOrEqual(10);
  });

  it('键名唯一，且每条都有类型与说明', () => {
    const names = CLAUDE_SETTINGS_KEYS.map((k) => k.key);
    expect(new Set(names).size).toBe(names.length);
    for (const k of CLAUDE_SETTINGS_KEYS) {
      expect(k.type, k.key).toBeTruthy();
      expect(k.description, k.key).toBeTruthy();
      expect(CLAUDE_SETTINGS_GROUPS, k.key).toContain(k.group);
    }
  });

  it('分组里没有文档章节噪声', () => {
    for (const g of CLAUDE_SETTINGS_GROUPS) {
      expect(g).not.toBe('Settings index');
      expect(g).not.toBe('See also');
      expect(CLAUDE_SETTINGS_KEYS.some((k) => k.group === g), g).toBe(true);
    }
  });

  it('Boolean 键不给枚举，枚举键给得出来', () => {
    for (const k of CLAUDE_SETTINGS_KEYS) {
      if (/^Boolean/i.test(k.type)) expect(k.options, k.key).toBeUndefined();
    }
    const mode = CLAUDE_SETTINGS_KEYS.find((k) => k.key === 'permissions.defaultMode');
    expect(mode?.options).toContain('bypassPermissions');
  });

  it('env 变量名唯一且有说明', () => {
    const names = CLAUDE_ENV_VARS.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const e of CLAUDE_ENV_VARS) expect(e.description, e.name).toBeTruthy();
    expect(names).toContain('ANTHROPIC_BASE_URL');
  });
});
