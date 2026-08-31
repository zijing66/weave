import { describe, it, expect } from 'vitest';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { HookEventRepository } from '../repositories/hook-events.js';
import { LibraryRepository } from '../repositories/libraries.js';

describe('data layer', () => {
  it('opens an in-memory database with an idempotent schema', () => {
    const db = openDatabase(':memory:');
    // Re-running the schema is a no-op (openDatabase already migrated once).
    db.exec('CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY)');
    db.close();
  });

  it('registers projects idempotently, preserving the original token', () => {
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);

    const first = projects.register({ path: '/a/b', name: 'b', token: 't1', source: 'init' });
    expect(first.id).toBeGreaterThan(0);
    expect(first.token).toBe('t1');

    // Re-register with a different token/source must NOT overwrite the token.
    projects.register({ path: '/a/b', name: 'b', token: 't2', source: 'scan' });
    expect(projects.getByPath('/a/b')?.token).toBe('t1');
    expect(projects.getByToken('t1')?.path).toBe('/a/b');
    expect(projects.list()).toHaveLength(1);
    db.close();
  });

  it('appends hook events and queries by project and session', () => {
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const hooks = new HookEventRepository(db);

    const p = projects.register({ path: '/x', name: 'x', token: 'tx', source: 'init' });
    hooks.insert({ projectId: p.id, source: 'claude', eventType: 'PreToolUse', sessionId: 's1', payload: '{}' });
    hooks.insert({ projectId: p.id, source: 'claude', eventType: 'PostToolUse', sessionId: 's1', payload: '{}' });

    expect(hooks.listBySession('s1')).toHaveLength(2);
    expect(hooks.listByProject(p.id)).toHaveLength(2);
    expect(hooks.listByProject(p.id)[0].eventType).toBe('PostToolUse'); // DESC order
    db.close();
  });

  it('adds libraries idempotently', () => {
    const db = openDatabase(':memory:');
    const libs = new LibraryRepository(db);

    libs.add({ path: 'C:/skills/zj-skills', kind: 'skill' });
    libs.add({ path: 'C:/skills/zj-skills', kind: 'skill' }); // dedup
    expect(libs.list()).toHaveLength(1);
    expect(libs.getByPath('C:/skills/zj-skills')?.kind).toBe('skill');
    db.close();
  });
});
