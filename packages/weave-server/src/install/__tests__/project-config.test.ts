import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readProjectConfig, writeProjectConfig, markSynced, DEFAULT_PROJECT_CONFIG } from '../project-config.js';

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'weave-pcfg-'));
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

describe('project-config', () => {
  it('returns defaults when absent', async () => {
    expect(await readProjectConfig(project)).toEqual(DEFAULT_PROJECT_CONFIG);
  });

  it('writes and reads back', async () => {
    await writeProjectConfig(project, { autoSync: true, lastSyncAt: null });
    expect((await readProjectConfig(project)).autoSync).toBe(true);
  });

  it('markSynced stamps lastSyncAt', async () => {
    const iso = new Date().toISOString();
    await markSynced(project, iso);
    const cfg = await readProjectConfig(project);
    expect(cfg.lastSyncAt).toBe(iso);
  });

  it('persists to .weave/config.json', async () => {
    await writeProjectConfig(project, { autoSync: true, lastSyncAt: null });
    expect(existsSync(join(project, '.weave', 'config.json'))).toBe(true);
    const raw = JSON.parse(readFileSync(join(project, '.weave', 'config.json'), 'utf-8'));
    expect(raw.autoSync).toBe(true);
  });
});
