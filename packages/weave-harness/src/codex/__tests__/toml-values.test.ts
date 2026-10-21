import { describe, it, expect } from 'vitest';
import { parse } from 'smol-toml';
import {
  renderTomlValue,
  setTomlValueInText,
  removeTomlValueInText,
} from '../toml.js';

const roundtrip = (text: string): Record<string, unknown> =>
  parse(text) as Record<string, unknown>;

describe('renderTomlValue', () => {
  it('标量与容器都渲染成合法 TOML', () => {
    expect(renderTomlValue(true)).toBe('true');
    expect(renderTomlValue(42)).toBe('42');
    expect(renderTomlValue('D:\\path')).toBe(`'D:\\path'`);
    expect(renderTomlValue('hello world')).toBe('"hello world"');
    expect(renderTomlValue(['a', 'b'])).toBe(`["a", "b"]`);
    expect(roundtrip(`v = ${renderTomlValue({ b: 1, a: 'x' })}`).v).toEqual({ b: 1, a: 'x' });
  });
});

describe('setTomlValueInText', () => {
  it('根键：替换已有值，其余字节原样保留', () => {
    const before = `# top comment\nmodel = "gpt-5"\napproval_policy = "never"\n`;
    const out = setTomlValueInText(before, ['model'], 'gpt-5.2');
    expect(out).toBe(`# top comment\nmodel = "gpt-5.2"\napproval_policy = "never"\n`);
    expect(roundtrip(out).model).toBe('gpt-5.2');
  });

  it('根键：新键追加在最后一个值行之后（不落在注释后面）', () => {
    const before = `model = "gpt-5"\n# trailing note\n`;
    const out = setTomlValueInText(before, ['sandbox_mode'], 'read-only');
    expect(roundtrip(out).sandbox_mode).toBe('read-only');
    expect(out).toContain('# trailing note');
    expect(out.indexOf('sandbox_mode')).toBeLessThan(out.indexOf('# trailing note'));
  });

  it('子键：落进既有 section，注释与其他键不动', () => {
    const before = [
      '[tui]',
      '# tui comment',
      'notifications = true',
      '',
      '[mcp_servers.weave]',
      'command = "npx"',
    ].join('\n');
    const out = setTomlValueInText(before, ['tui', 'mouse_scroll_speed'], 3);
    const parsed = roundtrip(out) as { tui: Record<string, unknown> };
    expect(parsed.tui.mouse_scroll_speed).toBe(3);
    expect(parsed.tui.notifications).toBe(true);
    expect(out).toContain('# tui comment');
    expect(out.indexOf('[mcp_servers.weave]')).toBeGreaterThan(out.indexOf('mouse_scroll_speed'));
  });

  it('子键：section 不存在时在 EOF 建 section', () => {
    const before = `model = "gpt-5"\n`;
    const out = setTomlValueInText(before, ['shell_environment_policy', 'inherit'], 'all');
    const parsed = roundtrip(out) as { shell_environment_policy: Record<string, unknown> };
    expect(parsed.shell_environment_policy.inherit).toBe('all');
    expect(parsed.model).toBe('gpt-5');
  });

  it('inline 父表：深层路径把它转换成 section 形式', () => {
    const before = `tui = { notifications = true }\n`;
    const out = setTomlValueInText(before, ['tui', 'mouse_scroll_speed'], 2);
    const parsed = roundtrip(out) as { tui: Record<string, unknown> };
    expect(parsed.tui.notifications).toBe(true);
    expect(parsed.tui.mouse_scroll_speed).toBe(2);
    expect(out).toContain('[tui]');
  });

  it('数组与对象值原样落盘', () => {
    const before = `[projects.'d:\\proj']\ntrust_level = "trusted"\n`;
    const out = setTomlValueInText(before, ['project_doc_fallback_filenames'], ['AGENTS.md', 'README.md']);
    expect(roundtrip(out).project_doc_fallback_filenames).toEqual(['AGENTS.md', 'README.md']);
  });

  it('带引号的键名（Windows 路径 section）照常命中', () => {
    // TOML basic string 里的反斜杠要转义；JS 侧用 String.fromCharCode 拼，避开模板串吃字符
    const bs = String.fromCharCode(92);
    const dir = `d:${bs}a b`;
    const before = `[projects."d:${bs}${bs}a b"]\ntrust_level = "trusted"\n`;
    const out = setTomlValueInText(before, ['projects', dir, 'trust_level'], 'untrusted');
    expect(roundtrip(out).projects).toEqual({ [dir]: { trust_level: 'untrusted' } });
    // 命中既有 section：不追加空父节
    expect(out.includes('\n[projects]\n')).toBe(false);
  });
});

describe('removeTomlValueInText', () => {
  it('删根键与子键，其余不动', () => {
    const before = `model = "gpt-5"\n[tui]\nnotifications = true\nmouse_scroll_speed = 2\n`;
    const r1 = removeTomlValueInText(before, ['model']);
    expect(r1.removed).toBe(true);
    expect(roundtrip(r1.text).model).toBeUndefined();
    const r2 = removeTomlValueInText(r1.text, ['tui', 'mouse_scroll_speed']);
    expect(r2.removed).toBe(true);
    const parsed = roundtrip(r2.text) as { tui: Record<string, unknown> };
    expect(parsed.tui.notifications).toBe(true);
    expect(parsed.tui.mouse_scroll_speed).toBeUndefined();
  });

  it('键不存在时原样返回', () => {
    const before = `model = "gpt-5"\n`;
    const r = removeTomlValueInText(before, ['tui', 'notifications']);
    expect(r.removed).toBe(false);
    expect(r.text).toBe(before);
  });
});
