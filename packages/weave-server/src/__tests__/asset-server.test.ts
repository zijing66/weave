import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { createWeaveServer } from '../daemon/server.js';
import { setGlobalStatuslineDir } from '../statusline/manager.js';
import { DEFAULT_STATUSLINE_CONFIG } from '../statusline/config.js';

const PROJECT_TOKEN = 'ptoken';

describe('daemon server — file / mcp / statusline', () => {
  let server: Server;
  let db: DatabaseSync;
  let port: number;
  let projectDir: string;
  let projectId: number;
  let globalHome: string;

  beforeAll(async () => {
    globalHome = mkdtempSync(join(tmpdir(), 'weave-asset-global-'));
    setGlobalStatuslineDir(globalHome);
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projectDir = mkdtempSync(join(tmpdir(), 'weave-asset-proj-'));
    const row = projects.register({
      path: projectDir,
      name: 'proj',
      token: PROJECT_TOKEN,
      source: 'init',
    });
    projectId = row.id;

    // seed assets
    mkdirSync(join(projectDir, '.claude/skills/foo'), { recursive: true });
    writeFileSync(join(projectDir, '.claude/skills/foo/SKILL.md'), '# Foo\n\nbody');
    writeFileSync(
      join(projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { alpha: { command: 'npx', args: ['x'] } } }, null, 2),
    );

    server = createWeaveServer({ projects, port: 0 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    db.close();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  const base = () => `http://127.0.0.1:${port}`;

  it('GET /projects/:id/asset-file returns file content', async () => {
    const res = await fetch(
      `${base()}/api/projects/${projectId}/asset-file?path=${encodeURIComponent('.claude/skills/foo/SKILL.md')}`,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.content).toContain('# Foo');
    expect(data.size).toBeGreaterThan(0);
  });

  it('GET /projects/:id/asset-file 403 on traversal', async () => {
    const res = await fetch(
      `${base()}/api/projects/${projectId}/asset-file?path=${encodeURIComponent('../etc/passwd')}`,
    );
    expect(res.status).toBe(403);
  });

  it('GET /projects/:id/asset-file 404 on missing', async () => {
    const res = await fetch(
      `${base()}/api/projects/${projectId}/asset-file?path=${encodeURIComponent('.claude/skills/none/SKILL.md')}`,
    );
    expect(res.status).toBe(404);
  });

  it('GET /projects/:id/mcp returns tool rows', async () => {
    const res = await fetch(`${base()}/api/projects/${projectId}/mcp`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { rows: Array<{ key: string; harness: string; scope: string; installScopes: string[]; enable: string | null; effective: boolean; detail: { command: string; args?: string[] } }> };
    const alpha = data.rows.find((r) => r.harness === 'claude' && r.scope === 'project' && r.key === 'alpha');
    expect(alpha?.detail.command).toBe('npx');
    expect(alpha?.detail.args).toEqual(['x']);
    expect(alpha?.installScopes).toEqual(['project', 'user']);
    // 项目面行带启停语义：无覆盖 = inherit，effective 跟随 enableAll（未放行 = false）。
    expect(alpha?.enable).toBe('inherit');
    expect(alpha?.effective).toBe(false);
  });

  it('GET /projects/:id/statusline returns default config when absent', async () => {
    const res = await fetch(`${base()}/api/projects/${projectId}/statusline`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.config.segments.project.enabled).toBe(true);
  });

  it('PUT /projects/:id/statusline writes script + settings', async () => {
    const cfg = {
      separator: ' | ',
      segments: {
        project: { enabled: true, color: 'cyan' },
        git: { enabled: true, color: 'magenta' },
        model: { enabled: false, color: 'blue' },
        tokens: { enabled: false, color: 'yellow' },
        cost: { enabled: false, color: 'green' },
        time: { enabled: true, color: 'gray' },
      },
    };
    const res = await fetch(`${base()}/api/projects/${projectId}/statusline`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    expect(res.status).toBe(200);
    const script = readFileSync(join(projectDir, '.claude/helpers/statusline.cjs'), 'utf-8');
    expect(script).toContain('weave statusline');
    const settings = JSON.parse(readFileSync(join(projectDir, '.claude/settings.json'), 'utf-8'));
    expect(settings.statusLine.command).toContain('statusline.cjs');
  });

  it('PUT /statusline/global regenerates scripts of following projects', async () => {
    // the previous PUT stored source=global, so this project follows the template
    const res = await fetch(`${base()}/api/statusline/global`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      // logoText is pinned to the badge now — the model label marks the
      // template instead (it survives normalisation and renders at runtime).
      body: JSON.stringify({
        ...DEFAULT_STATUSLINE_CONFIG,
        segments: {
          ...DEFAULT_STATUSLINE_CONFIG.segments,
          model: { ...DEFAULT_STATUSLINE_CONFIG.segments.model, label: 'GLOBAL2' },
        },
      }),
    });
    expect(res.status).toBe(200);
    const script = readFileSync(join(projectDir, '.claude/helpers/statusline.cjs'), 'utf-8');
    expect(script).toContain('GLOBAL2');
    // GET returns the stored global template
    const g = await fetch(`${base()}/api/statusline/global`);
    const gd = await g.json();
    expect(gd.config.segments.model.label).toBe('GLOBAL2');
  });

  it('GET /projects/:id/statusline includes globalConfig', async () => {
    const res = await fetch(`${base()}/api/projects/${projectId}/statusline`);
    const data = await res.json();
    expect(data.config.source).toBe('global');
    expect(data.globalConfig.source).toBe('global');
    expect(data.globalConfig.segments.model.label).toBe('GLOBAL2');
  });

  it('404 for unknown project', async () => {
    const res = await fetch(`${base()}/api/projects/9999/mcp`);
    expect(res.status).toBe(404);
  });
});
