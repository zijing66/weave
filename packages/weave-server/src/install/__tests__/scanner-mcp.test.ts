import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanLibraryMcp } from '../scanner.js';

describe('scanLibraryMcp', () => {
  let lib: string;
  beforeAll(() => {
    lib = mkdtempSync(join(tmpdir(), 'weave-mcplib-'));
    // *.mcp.json at top level — single-server shape (named by stem)
    writeFileSync(join(lib, 'weather.mcp.json'), JSON.stringify({ command: 'npx', args: ['weather-cli'] }));
    // mcp/<name>.json — multi-server shape (mcpServers wrapper)
    mkdirSync(join(lib, 'mcp'), { recursive: true });
    writeFileSync(
      join(lib, 'mcp', 'bundle.json'),
      JSON.stringify({ mcpServers: { alpha: { command: 'node', args: ['a.js'] }, beta: { command: 'node' } } }),
    );
    // a non-mcp .json (plain .json not in mcp/) must be ignored
    writeFileSync(join(lib, 'config.json'), JSON.stringify({ not: 'a template' }));
    // malformed json ignored
    writeFileSync(join(lib, 'broken.mcp.json'), '{ not json');
  });
  afterAll(() => rmSync(lib, { recursive: true, force: true }));

  it('collects single-server and multi-server templates', async () => {
    const t = await scanLibraryMcp(lib);
    const names = t.map((x) => x.name).sort();
    expect(names).toEqual(['alpha', 'beta', 'weather']);
  });

  it('records command/args from the source', async () => {
    const t = await scanLibraryMcp(lib);
    const weather = t.find((x) => x.name === 'weather')!;
    expect(weather.command).toBe('npx');
    expect(weather.args).toEqual(['weather-cli']);
    expect(weather.sourcePath).toBe(join(lib, 'weather.mcp.json'));
  });

  it('ignores plain .json outside mcp/ and malformed files', async () => {
    const t = await scanLibraryMcp(lib);
    expect(t.find((x) => x.name === 'config')).toBeUndefined();
    expect(t.find((x) => x.name === 'broken')).toBeUndefined();
  });

  it('returns empty for missing dir', async () => {
    expect(await scanLibraryMcp(join(tmpdir(), 'weave-nope-xyz'))).toEqual([]);
  });
});
