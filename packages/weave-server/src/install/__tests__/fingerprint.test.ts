import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  hashSkillDir,
  maxMtimeDir,
  hashMcpConfig,
  FingerprintCache,
} from '../fingerprint.js';
import type { McpServerConfig } from '../installer.js';

describe('hashSkillDir', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-fp-'));
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# skill');
    writeFileSync(join(dir, 'scripts', 'run.py'), 'print(1)');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('is stable across calls for unchanged content', async () => {
    const a = await hashSkillDir(dir);
    const b = await hashSkillDir(dir);
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('changes when content changes', async () => {
    const before = await hashSkillDir(dir);
    writeFileSync(join(dir, 'SKILL.md'), '# skill v2');
    const after = await hashSkillDir(dir);
    expect(after).not.toBe(before);
  });

  it('is order-independent (file add order does not matter)', async () => {
    const d1 = mkdtempSync(join(tmpdir(), 'weave-fp1-'));
    const d2 = mkdtempSync(join(tmpdir(), 'weave-fp2-'));
    try {
      // same files, written in different order
      writeFileSync(join(d1, 'a.md'), 'A');
      writeFileSync(join(d1, 'b.md'), 'B');
      writeFileSync(join(d2, 'b.md'), 'B');
      writeFileSync(join(d2, 'a.md'), 'A');
      expect(await hashSkillDir(d1)).toBe(await hashSkillDir(d2));
    } finally {
      rmSync(d1, { recursive: true, force: true });
      rmSync(d2, { recursive: true, force: true });
    }
  });

  it('ignores .weave sidecar directories', async () => {
    const d = mkdtempSync(join(tmpdir(), 'weave-fp-sc-'));
    try {
      writeFileSync(join(d, 'SKILL.md'), '# x');
      const base = await hashSkillDir(d);
      mkdirSync(join(d, '.weave'), { recursive: true });
      writeFileSync(join(d, '.weave', 'statusline.json'), '{}');
      expect(await hashSkillDir(d)).toBe(base);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('maxMtimeDir', () => {
  it('returns 0 for missing dir', async () => {
    expect(await maxMtimeDir(join(tmpdir(), 'weave-nope-xyz'))).toBe(0);
  });

  it('reflects the newest file mtime', async () => {
    const d = mkdtempSync(join(tmpdir(), 'weave-mt-'));
    try {
      writeFileSync(join(d, 'a.md'), 'a');
      const future = new Date(Date.now() + 100000);
      utimesSync(join(d, 'a.md'), future, future);
      const m = await maxMtimeDir(d);
      expect(m).toBeGreaterThan(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('hashMcpConfig', () => {
  it('is stable regardless of key insertion order', () => {
    const a: McpServerConfig = { command: 'npx', args: ['x'], env: { B: '2', A: '1' } };
    const b: McpServerConfig = { env: { A: '1', B: '2' }, args: ['x'], command: 'npx' };
    expect(hashMcpConfig(a)).toBe(hashMcpConfig(b));
  });

  it('changes when a value changes', () => {
    const a: McpServerConfig = { command: 'npx' };
    const b: McpServerConfig = { command: 'node' };
    expect(hashMcpConfig(a)).not.toBe(hashMcpConfig(b));
  });
});

describe('FingerprintCache', () => {
  it('reuses hash while mtime unchanged, recomputes after change', async () => {
    const d = mkdtempSync(join(tmpdir(), 'weave-fpc-'));
    try {
      writeFileSync(join(d, 'SKILL.md'), '# v1');
      const cache = new FingerprintCache();
      const h1 = await cache.get(d);

      // unchanged → same cached hash
      const h2 = await cache.get(d);
      expect(h2).toBe(h1);

      // mutate content + bump mtime → new hash
      writeFileSync(join(d, 'SKILL.md'), '# v2');
      const h3 = await cache.get(d);
      expect(h3).not.toBe(h1);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('invalidate forces recompute', async () => {
    const d = mkdtempSync(join(tmpdir(), 'weave-fpc2-'));
    try {
      writeFileSync(join(d, 'SKILL.md'), '# v1');
      const cache = new FingerprintCache();
      await cache.get(d);
      cache.invalidate(d);
      // after invalidate, get recomputes (still same content → same hash)
      expect(await cache.get(d)).toBe(await hashSkillDir(d));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
