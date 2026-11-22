import { describe, it, expect, beforeAll } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../projects.js';
import { AgentInstanceRepository } from '../agent-instances.js';

describe('AgentInstanceRepository live counting', () => {
  const db = openDatabase(':memory:');
  const repo = new AgentInstanceRepository(db);

  beforeAll(() => {
    // FK：project 1/2/3 各登记一个（id 自增连续）。
    const projects = new ProjectRepository(db);
    for (const i of [1, 2, 3]) {
      projects.register({ path: `/w${i}`, name: `w${i}`, token: `t${i}`, source: 'init' });
    }
  });

  const create = (id: string, projectId: number, status: string, harness = 'claude'): void => {
    repo.create({ id, projectId, harness, executionMode: 'headless', workingDirectory: '/w', command: 'x' });
    if (status !== 'created') repo.markStatus(id, status as never);
  };

  it('liveHeadlessCounts counts only running/starting headless rows per project', () => {
    create('a1', 1, 'running');
    create('a2', 1, 'starting');
    create('a3', 1, 'exited');
    create('a4', 1, 'failed');
    create('a5', 2, 'running', 'shell');
    create('a6', 3, 'created'); // created 不算活
    db.prepare(`INSERT INTO agent_instances (id, project_id, harness, status, execution_mode, working_directory, command, created_at)
                VALUES ('a7', 2, 'claude', 'running', 'headless', '/w', 'x', ?)`).run(new Date().toISOString());
    expect(repo.liveHeadlessCounts()).toEqual({ 1: 2, 2: 2 });
  });

  it('liveShellOf returns the newest live shell instance only', () => {
    create('s1', 1, 'exited', 'shell');
    create('s2', 1, 'running', 'shell');
    create('s3', 1, 'running', 'claude');
    const shell = repo.liveShellOf(1);
    expect(shell?.id).toBe('s2');
    expect(repo.liveShellOf(4)).toBeNull();
  });
});
