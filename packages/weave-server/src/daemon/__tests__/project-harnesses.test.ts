import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntimeRegistry } from '@weavecode/harness';
import { projectHarnesses, withProjectHarnesses } from '../project-harnesses.js';

/**
 * 「已接入 harness」= init 选择结果（`.weave/config.yaml` 的 `harnesses`），
 * 不是 marker 探测——codex 探测对任何 weave 项目都假阳性（init 恒建
 * `AGENTS.md → CLAUDE.md` 链接），故这里按 config.yaml 逐档断言。
 */

const registry = createRuntimeRegistry();

function writeConfig(dir: string, harnesses: string): void {
  mkdirSync(path.join(dir, '.weave'), { recursive: true });
  writeFileSync(
    path.join(dir, '.weave', 'config.yaml'),
    `initVersion: 0.1.0\npreset: default\nharnesses: ${harnesses}\n`,
    'utf-8',
  );
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'weave-harnesses-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('projectHarnesses', () => {
  it('读 init 选择结果，并按注册表现状标 canStartSession（codex 无 resume → false）', async () => {
    const dir = path.join(root, 'both');
    writeConfig(dir, '["claude","codex"]');
    expect(await projectHarnesses(dir, registry)).toEqual([
      { id: 'claude', canStartSession: true },
      { id: 'codex', canStartSession: false },
    ]);
  });

  it('codex-only 项目：已接入但都起不了交互会话', async () => {
    const dir = path.join(root, 'codex-only');
    writeConfig(dir, '["codex"]');
    expect(await projectHarnesses(dir, registry)).toEqual([
      { id: 'codex', canStartSession: false },
    ]);
  });

  it('无 config.yaml（未 weave 化）/ 无该字段 / 值非法 → 回落注册表首个', async () => {
    const bare = path.join(root, 'bare');
    mkdirSync(bare, { recursive: true });
    const noField = path.join(root, 'no-field');
    mkdirSync(path.join(noField, '.weave'), { recursive: true });
    writeFileSync(path.join(noField, '.weave', 'config.yaml'), 'initVersion: 0.1.0\n', 'utf-8');
    const junk = path.join(root, 'junk');
    writeConfig(junk, 'not-json');
    for (const dir of [bare, noField, junk]) {
      expect(await projectHarnesses(dir, registry)).toEqual([
        { id: 'claude', canStartSession: true },
      ]);
    }
  });


  it('withProjectHarnesses 保留行原字段并逐行补 harnesses', async () => {
    const dir = path.join(root, 'row');
    writeConfig(dir, '["claude"]');
    expect(await withProjectHarnesses([{ id: 7, path: dir }], registry)).toEqual([
      { id: 7, path: dir, harnesses: [{ id: 'claude', canStartSession: true }] },
    ]);
  });
});
