import { describe, it, expect } from 'vitest';
import { zh, en, DICTS, type Dict, type MessageKey } from '../dict';
import { interpolate, makeT } from '../t';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, LOCALE_NATIVE_NAMES } from '../locale';

describe('i18n dictionaries', () => {
  it('en covers every zh key and vice versa', () => {
    const zhKeys = Object.keys(zh).sort();
    const enKeys = Object.keys(en).sort();
    expect(enKeys).toEqual(zhKeys);
  });

  it('no dictionary value is empty', () => {
    for (const [key, value] of Object.entries({ ...zh, ...en })) {
      expect(value, key).not.toBe('');
    }
  });

  it('every supported locale is registered with a dictionary', () => {
    for (const l of SUPPORTED_LOCALES) {
      expect(DICTS[l]).toBeDefined();
      expect(LOCALE_NATIVE_NAMES[l]).toBeTruthy();
    }
    expect(DICTS[DEFAULT_LOCALE]).toBe(zh);
  });

  it('locale-specific values actually differ where translated', () => {
    // 抽查：标题类词条两种语言不应相同（专有名词词条除外）
    expect(zh['settings.title']).not.toBe(en['settings.title']);
    expect(zh['common.save']).not.toBe(en['common.save']);
  });
});

describe('interpolate', () => {
  it('replaces named placeholders', () => {
    expect(interpolate('Install failed: {error}', { error: 'boom' })).toBe('Install failed: boom');
  });

  it('keeps unknown placeholders verbatim', () => {
    expect(interpolate('a {x} b', { y: '1' })).toBe('a {x} b');
  });

  it('leaves the string untouched without params', () => {
    expect(interpolate('no placeholders')).toBe('no placeholders');
  });

  it('stringifies numeric params', () => {
    expect(interpolate('n={n}', { n: 3 })).toBe('n=3');
  });
});

describe('makeT', () => {
  it('resolves keys from the bound dictionary with params', () => {
    const t = makeT(en, zh);
    expect(t('settings.title')).toBe('Settings');
    expect(t('common.save')).toBe('Save');
  });

  it('falls back to the default dictionary on a missing key', () => {
    const partial = { 'common.save': 'Guardar' } as typeof en;
    const t = makeT(partial, zh);
    expect(t('settings.title')).toBe('设置');
  });

  it('returns the key itself when unknown everywhere (never throws)', () => {
    const t = makeT({} as Dict, zh);
    expect(t('not.a.key' as MessageKey)).toBe('not.a.key');
  });
});
