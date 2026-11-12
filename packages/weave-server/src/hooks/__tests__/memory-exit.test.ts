import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { createMemoryExit } from '../memory-exit.js';
import { CLAUDE_MEMORY, CODEX_MEMORY } from '@weavecode/harness';

/**
 * 记忆出口写盘面：判决落进**编排挂靠项目自己的**记忆文件——按
 * `.weave/config.yaml` 的接入 harness 逐面分发；清单读不到 / 项目查无 /
 * 面缺席 / 写失败都如实报错不写。
 */

let db: DatabaseSync;
let projects: ProjectRepository;
let dir: string;

beforeEach(async () => {
  db = openDatabase(':memory:');
  projects = new ProjectRepository(db);
  dir = await mkdtemp(path.join(tmpdir(), 'memexit-'));
});

afterEach(() => {
  db.close();
});

/** 项目接入清单：`.weave/config.yaml` 写 harnesses 行（init 同款手写 k:v）。 */
async function wireHarnesses(root: string, harnesses: string[]): Promise<void> {
  await mkdir(path.join(root, '.weave'), { recursive: true });
  await writeFile(path.join(root, '.weave', 'config.yaml'), `harnesses: ${JSON.stringify(harnesses)}\n`);
}

describe('createMemoryExit.deliverVerdict', () => {
  it('双 harness 项目 → 两面各写各的文件；区块内可续写', async () => {
    await wireHarnesses(dir, ['claude', 'codex']);
    const project = projects.register({ path: dir, name: 'p', token: 't', source: 'init' });
    const exit = createMemoryExit({
      projects,
      sinkFor: (h) => (h === 'claude' ? CLAUDE_MEMORY : h === 'codex' ? CODEX_MEMORY : null),
    });
    const result = await exit.deliverVerdict({ projectId: project.id, text: '第一次判决' });
    expect(result.ok).toBe(true);
    expect(result.files).toHaveLength(2);
    expect(result.files.some((f) => f.endsWith('CLAUDE.local.md'))).toBe(true);
    expect(result.files.some((f) => f.endsWith('AGENTS.md'))).toBe(true);
    expect(await readFile(path.join(dir, 'CLAUDE.local.md'), 'utf-8')).toContain('第一次判决');
    // 再写一条：已有认领区块内追加，首条不丢
    await exit.deliverVerdict({ projectId: project.id, text: '第二次判决' });
    const local = await readFile(path.join(dir, 'CLAUDE.local.md'), 'utf-8');
    expect(local).toContain('第一次判决');
    expect(local).toContain('第二次判决');
  });

  it('项目没 init（无 config.yaml）→ 不写、如实报错', async () => {
    const project = projects.register({ path: dir, name: 'p', token: 't', source: 'init' });
    const exit = createMemoryExit({ projects, sinkFor: () => CLAUDE_MEMORY });
    const result = await exit.deliverVerdict({ projectId: project.id, text: 'x' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no harnesses');
  });

  it('项目查无 / 面缺席 / 写失败 → 聚合成错误', async () => {
    await wireHarnesses(dir, ['claude']);
    const project = projects.register({ path: dir, name: 'p', token: 't', source: 'init' });
    const badSink = {
      harness: 'claude' as const,
      appendVerdict: vi.fn(async () => ({ ok: false as const, error: 'disk full' })),
    };
    const exit = createMemoryExit({ projects, sinkFor: () => badSink });
    const failed = await exit.deliverVerdict({ projectId: project.id, text: 'x' });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('disk full');
    const missing = await createMemoryExit({ projects, sinkFor: () => null }).deliverVerdict({
      projectId: project.id,
      text: 'x',
    });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('no memory sink face');
    const noProject = await exit.deliverVerdict({ projectId: 999, text: 'x' });
    expect(noProject.ok).toBe(false);
    expect(noProject.error).toContain('project not found');
  });
});
