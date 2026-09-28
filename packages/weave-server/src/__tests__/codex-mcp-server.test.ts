import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { createWeaveServer } from '../daemon/server.js';
import { setCodexConfigFileOverride } from '../install/codex-toml.js';

const DAEMON_TOKEN = 'daemon-token';
const PROJECT_TOKEN = 'ptoken';

/** Hand-written config the routes must preserve around [mcp_servers.*]. */
const SEED = `# user config
model = "gpt"

[mcp_servers.existing]
command = "existing"

[other_section]
key = "value"
`;

describe('daemon server — codex MCP (config.toml)', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let projectId: number;
  let configFile: string;

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const projectDir = mkdtempSync(join(tmpdir(), 'weave-cxmcp-proj-'));
    const row = projects.register({
      path: projectDir,
      name: 'proj',
      token: PROJECT_TOKEN,
      source: 'init',
    });
    projectId = row.id;

    const home = mkdtempSync(join(tmpdir(), 'weave-cxmcp-home-'));
    configFile = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(configFile, SEED);
    setCodexConfigFileOverride(configFile);

    server = createWeaveServer({
      projects,
      daemonToken: DAEMON_TOKEN,
      port: 0,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    db.close();
    setCodexConfigFileOverride(null);
  });

  const auth = { authorization: `Bearer ${DAEMON_TOKEN}` };
  const install = (body: unknown) =>
    fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/install`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const uninstall = (body: unknown) =>
    fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/uninstall`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('GET /projects/:id/mcp includes codex servers from config.toml', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/mcp`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      codex: Record<string, { command: string }>;
    };
    expect(data.codex.existing).toEqual({ command: 'existing' });
  });

  it('POST install agent=codex writes a config.toml section', async () => {
    const res = await install({
      category: 'mcp',
      name: 'weave',
      mcpConfig: { command: 'npx', args: ['-y', 'weave'] },
      scope: 'global',
      agent: 'codex',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { scope: string; agent: string };
    expect(body.scope).toBe('global');
    expect(body.agent).toBe('codex');

    const raw = readFileSync(configFile, 'utf-8');
    expect(raw).toContain('# user config');
    expect(raw).toContain('[other_section]');
    expect(raw).toContain('[mcp_servers.weave]');
    expect(raw).toContain('args = ["-y", "weave"]');
  });

  it('GET /mcp reflects the installed codex server', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/mcp`, {
      headers: auth,
    });
    const data = (await res.json()) as {
      codex: Record<string, { command: string; args?: string[] }>;
    };
    expect(data.codex.weave).toEqual({ command: 'npx', args: ['-y', 'weave'] });
  });

  it('install agent=codex rejects project scope (config.toml is user-level)', async () => {
    const res = await install({
      category: 'mcp',
      name: 'bad',
      mcpConfig: { command: 'x' },
      scope: 'project',
      agent: 'codex',
    });
    expect(res.status).toBe(400);
  });

  it('install agent=codex returns 409 when already configured', async () => {
    const res = await install({
      category: 'mcp',
      name: 'weave',
      mcpConfig: { command: 'npx' },
      scope: 'global',
      agent: 'codex',
    });
    expect(res.status).toBe(409);
  });

  it('uninstall agent=codex removes the section, then 404', async () => {
    const ok = await uninstall({ category: 'mcp', name: 'weave', agent: 'codex' });
    expect(ok.status).toBe(200);
    const raw = readFileSync(configFile, 'utf-8');
    expect(raw).not.toContain('[mcp_servers.weave]');
    expect(raw).toContain('[mcp_servers.existing]');
    expect(raw).toContain('[other_section]');

    const missing = await uninstall({ category: 'mcp', name: 'weave', agent: 'codex' });
    expect(missing.status).toBe(404);
  });
});
