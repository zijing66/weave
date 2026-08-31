import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { LibraryRepository } from '../repositories/libraries.js';
import { createWeaveServer } from '../daemon/server.js';
import { listBrowseRoots, listDirectoryChildren } from '../daemon/fs-browser.js';

const TOKEN = 'daemon-token';

describe('fs-browser', () => {
  it('listDirectoryChildren returns only directories, sorted numerically', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'weave-fs-'));
    await mkdir(path.join(dir, 'b-dir'));
    await mkdir(path.join(dir, 'a-dir'));
    await mkdir(path.join(dir, '10-dir'));
    await mkdir(path.join(dir, '2-dir'));
    await writeFile(path.join(dir, 'not-a-dir.txt'), 'x');
    const children = await listDirectoryChildren(dir);
    expect(children.map((c) => c.name)).toEqual(['2-dir', '10-dir', 'a-dir', 'b-dir']);
    expect(children[0].path).toBe(path.join(dir, '2-dir'));
  });

  it('listDirectoryChildren rejects a nonexistent path', async () => {
    await expect(
      listDirectoryChildren(path.join(tmpdir(), 'weave-nonexistent-xyz')),
    ).rejects.toThrow();
  });

  it('listBrowseRoots includes home and library parents, deduped', async () => {
    const roots = await listBrowseRoots([
      path.join(tmpdir(), 'lib-a'),
      path.join(tmpdir(), 'lib-b'),
      path.join(tmpdir(), 'lib-a'), // duplicate path
    ]);
    const kinds = roots.map((r) => r.kind);
    expect(kinds).toContain('home');
    const libParents = roots.filter((r) => r.kind === 'library-parent');
    expect(libParents).toHaveLength(1);
    expect(libParents[0].path).toBe(tmpdir());
    const paths = roots.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('daemon /fs routes', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let scratch: string;

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projects.register({ path: '/test', name: 'test', token: 'ptoken', source: 'init' });
    const libraries = new LibraryRepository(db);
    scratch = await mkdtemp(path.join(tmpdir(), 'weave-fs-api-'));
    await mkdir(path.join(scratch, 'sub-a'));
    await mkdir(path.join(scratch, 'sub-b'));
    server = createWeaveServer({ projects, libraries, daemonToken: TOKEN, port: 0 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    db.close();
  });

  it('GET /fs/roots returns browse roots', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/fs/roots`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { roots: Array<{ path: string; kind: string }> };
    expect(data.roots.length).toBeGreaterThan(0);
    expect(data.roots.some((r) => r.kind === 'home')).toBe(true);
  });

  it('GET /fs/roots rejects a missing token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/fs/roots`);
    expect(res.status).toBe(401);
  });

  it('GET /fs/children requires a path query', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/fs/children`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
  });

  it('GET /fs/children lists subdirectories of a real folder', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/fs/children?path=${encodeURIComponent(scratch)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { children: Array<{ name: string; path: string }> };
    expect(data.children.map((c) => c.name)).toEqual(['sub-a', 'sub-b']);
  });

  it('GET /fs/children on a nonexistent path returns 400 with an error', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/fs/children?path=${encodeURIComponent('/nonexistent-weave-xyz')}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toMatch(/Cannot list directory/);
  });

  it('the old native picker route is gone', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/fs/pick-directory`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});
