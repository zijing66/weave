import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readMcpEnableMap, setMcpEnableState } from '../settings-mcp.js';

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'weave-setmcp-'));
  mkdirSync(join(project, '.claude'), { recursive: true });
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

describe('settings-mcp enable map', () => {
  it('reads empty when settings absent', async () => {
    const m = await readMcpEnableMap(project);
    expect(m.overrides).toEqual({});
    expect(m.enableAll).toBe(false);
  });

  it('sets enabled/disabled/default and persists only the three keys', async () => {
    writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ statusLine: { command: 'x' } }));
    await setMcpEnableState(project, 'a', 'enabled');
    await setMcpEnableState(project, 'b', 'disabled');
    const json = JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf-8'));
    expect(json.statusLine.command).toBe('x'); // preserved
    expect(json.enabledMcpjsonServers).toEqual(['a']);
    expect(json.disabledMcpjsonServers).toEqual(['b']);
  });

  it('default removes the override from both arrays', async () => {
    await setMcpEnableState(project, 'a', 'enabled');
    await setMcpEnableState(project, 'a', 'default');
    const m = await readMcpEnableMap(project);
    expect(m.overrides.a).toBeUndefined();
    const json = JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf-8'));
    expect(json.enabledMcpjsonServers).toBeUndefined();
  });

  it('moving a server from enabled to disabled updates arrays', async () => {
    await setMcpEnableState(project, 'a', 'enabled');
    await setMcpEnableState(project, 'a', 'disabled');
    const m = await readMcpEnableMap(project);
    expect(m.overrides.a).toBe('disabled');
  });
});
