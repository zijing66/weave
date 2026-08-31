import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { createWeaveServer } from '../daemon/server.js';
import type { DatabaseSync } from 'node:sqlite';

const TOKEN = 'daemon-token';

describe('daemon server', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projects.register({ path: '/test', name: 'test', token: 'ptoken', source: 'init' });
    server = createWeaveServer({ projects, daemonToken: TOKEN, port: 0 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    db.close();
  });

  it('GET /health is unauthenticated', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { service: string };
    expect(data.service).toBe('weave-daemon');
  });

  it('GET /projects rejects a missing token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects`);
    expect(res.status).toBe(401);
  });

  it('GET /projects with a valid token returns projects', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { projects: Array<{ path: string }> };
    expect(data.projects).toHaveLength(1);
    expect(data.projects[0].path).toBe('/test');
  });

  it('unknown routes return 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nope`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it('GET /assets returns 503 without a watch service', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/assets?path=/test`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(503);
  });

  it('GET /assets requires a path query', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/assets`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
  });

  it('GET /events returns 503 without a watch service', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(503);
  });
});
