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
 *
 * 版本探测走注入的 `versionOf`：真跑 `<bin> --version` 会让断言随机器的安装状态漂移。
 */

const registry = createRuntimeRegistry();
const NEW_ENOUGH = async (): Promise<string> => '2.1.300';
const TOO_OLD = async (): Promise<string> => '2.1.100';
const UNKNOWN = async (): Promise<null> => null;

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
  it('已接入的都起得了：claude 过版本闸、codex 无闸', async () => {
    const dir = path.join(root, 'both');
    writeConfig(dir, '["claude","codex"]');
    expect(await projectHarnesses(dir, registry, NEW_ENOUGH)).toEqual([
      { id: 'claude', canStartSession: true, version: '2.1.300', minVersion: '2.1.287' },
      { id: 'codex', canStartSession: true },
    ]);
  });

  it('claude 版本低于下限 → 置灰，并带出实际版本与下限供 UI 说明', async () => {
    const dir = path.join(root, 'old');
    writeConfig(dir, '["claude"]');
    expect(await projectHarnesses(dir, registry, TOO_OLD)).toEqual([
      { id: 'claude', canStartSession: false, version: '2.1.100', minVersion: '2.1.287' },
    ]);
  });

  it('探不到版本不拦（低误报优先：拿不到 ≠ 不兼容）', async () => {
    const dir = path.join(root, 'unknown');
    writeConfig(dir, '["claude"]');
    expect(await projectHarnesses(dir, registry, UNKNOWN)).toEqual([
      { id: 'claude', canStartSession: true, version: null, minVersion: '2.1.287' },
    ]);
  });

  it('无 resume 槽的 harness 置灰（注册表里没有它 / 槽为 null）', async () => {
    const dir = path.join(root, 'noresume');
    writeConfig(dir, '["claude"]');
    // 空注册表 = 什么都查不到，等价于没有 resume 槽。
    expect(await projectHarnesses(dir, undefined, NEW_ENOUGH)).toEqual([
      { id: 'claude', canStartSession: false },
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
      expect(await projectHarnesses(dir, registry, NEW_ENOUGH)).toEqual([
        { id: 'claude', canStartSession: true, version: '2.1.300', minVersion: '2.1.287' },
      ]);
    }
  });

  it('withProjectHarnesses 保留行原字段并逐行补 harnesses', async () => {
    const dir = path.join(root, 'row');
    writeConfig(dir, '["claude"]');
    expect(await withProjectHarnesses([{ id: 7, path: dir }], registry, NEW_ENOUGH)).toEqual([
      {
        id: 7,
        path: dir,
        harnesses: [{ id: 'claude', canStartSession: true, version: '2.1.300', minVersion: '2.1.287' }],
      },
    ]);
  });
});
