import { describe, it, expect, afterEach } from 'vitest';
import { zh, en, DICTS } from '../dict/index';
import { interpolate, makeT } from '../t';
import { setLocale, getLocale, t } from '../index';

describe('CLI dictionaries', () => {
  it('en covers every zh key', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it('no value is empty', () => {
    for (const [k, v] of Object.entries({ ...zh, ...en })) expect(v, k).not.toBe('');
  });

  it('registers a dictionary for every supported locale', () => {
    expect(Object.keys(DICTS).sort()).toEqual(['en', 'zh-CN']);
    expect(DICTS['zh-CN']).toBe(zh);
  });
});

describe('interpolate', () => {
  it('replaces named placeholders', () => {
    expect(interpolate('Unknown command: {command}', { command: 'frobnicate' })).toBe(
      'Unknown command: frobnicate',
    );
  });

  it('keeps unknown placeholders verbatim', () => {
    expect(interpolate('a {x} b', { y: '1' })).toBe('a {x} b');
  });
});

describe('locale switching', () => {
  afterEach(() => setLocale('zh-CN'));

  it('defaults to zh-CN', () => {
    setLocale('zh-CN');
    expect(getLocale()).toBe('zh-CN');
    expect(t('help.commands')).toBe('命令：');
  });

  it('renders English after setLocale(en)', () => {
    setLocale('en');
    expect(getLocale()).toBe('en');
    expect(t('help.commands')).toBe('Commands:');
    expect(t('cli.unknownCommand', { command: 'nope' })).toBe('Unknown command: nope');
  });

  it('zh interpolation carries parameters', () => {
    setLocale('zh-CN');
    expect(t('cli.missingRequired', { name: 'dir' })).toBe('缺少必填选项：--dir');
  });

  it('makeT falls back to zh for a key missing in en', () => {
    const partial = { 'help.commands': 'Commands!' } as typeof en;
    const fn = makeT(partial, zh);
    expect(fn('cli.error', { error: 'x' })).toBe('错误：x');
  });
});
