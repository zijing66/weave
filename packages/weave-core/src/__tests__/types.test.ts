import { describe, it, expect } from 'vitest';
import {
  resolveComponents,
  MINIMAL_COMPONENTS,
  DEFAULT_COMPONENTS,
  FULL_COMPONENTS,
  PresetSchema,
  InitOptionsSchema,
} from '../types';

describe('resolveComponents', () => {
  it('returns minimal components for "minimal" preset', () => {
    expect(resolveComponents('minimal')).toEqual(MINIMAL_COMPONENTS);
  });

  it('returns default components for "default" preset', () => {
    expect(resolveComponents('default')).toEqual(DEFAULT_COMPONENTS);
  });

  it('returns full components for "full" preset', () => {
    expect(resolveComponents('full')).toEqual(FULL_COMPONENTS);
  });

  it('returns a fresh object (no shared references)', () => {
    const a = resolveComponents('default');
    const b = resolveComponents('default');
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('merges partial overrides on top of the preset', () => {
    const result = resolveComponents('minimal', { mcp: true });
    expect(result.mcp).toBe(true);
    expect(result.skills).toBe(true); // unchanged from minimal
  });

  it('lets overrides disable preset-enabled components', () => {
    const result = resolveComponents('full', { agents: false });
    expect(result.agents).toBe(false);
    expect(result.settings).toBe(true);
  });
});

describe('PresetSchema', () => {
  it('accepts all three presets', () => {
    for (const p of ['minimal', 'default', 'full']) {
      expect(PresetSchema.parse(p)).toBe(p);
    }
  });

  it('rejects an unknown preset', () => {
    expect(() => PresetSchema.parse('ultra')).toThrow();
  });
});

describe('InitOptionsSchema', () => {
  it('fills defaults for an empty object', () => {
    const opts = InitOptionsSchema.parse({});
    expect(opts.preset).toBe('default');
    expect(opts.force).toBe(false);
    expect(opts.interactive).toBe(true);
    expect(opts.targetDir).toBeTypeOf('string');
  });

  it('accepts a full explicit options object', () => {
    const opts = InitOptionsSchema.parse({
      targetDir: '/tmp/proj',
      force: true,
      interactive: false,
      preset: 'full',
      components: { agents: true },
    });
    expect(opts.targetDir).toBe('/tmp/proj');
    expect(opts.force).toBe(true);
    expect(opts.components?.agents).toBe(true);
  });

  it('rejects an invalid preset value', () => {
    expect(() => InitOptionsSchema.parse({ preset: 'bogus' })).toThrow();
  });
});
