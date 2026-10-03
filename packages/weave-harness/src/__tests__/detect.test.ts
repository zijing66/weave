import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessRegistry, supports } from '../driver';
import { registerRuntimeDrivers } from '../registry-wiring';
import { CLAUDE_DETECTOR } from '../claude/detect';
import { CODEX_DETECTOR } from '../codex/detect';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'weave-detect-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('CLAUDE_DETECTOR', () => {
  it('markers：.claude / CLAUDE.md', () => {
    expect([...CLAUDE_DETECTOR.markers]).toEqual(['.claude', 'CLAUDE.md']);
  });

  it('present 命中 .claude 目录或 CLAUDE.md，否则 false', async () => {
    expect(CLAUDE_DETECTOR.present(dir)).toBe(false);
    await mkdir(path.join(dir, '.claude'));
    expect(CLAUDE_DETECTOR.present(dir)).toBe(true);
  });

  it('detect 返回 { harness, present }', async () => {
    expect(CLAUDE_DETECTOR.detect(dir)).toEqual({ harness: 'claude', present: false });
    await writeFile(path.join(dir, 'CLAUDE.md'), '# hi\n');
    expect(CLAUDE_DETECTOR.detect(dir)).toEqual({ harness: 'claude', present: true });
  });
});

describe('CODEX_DETECTOR', () => {
  it('markers：.codex / AGENTS.md', () => {
    expect([...CODEX_DETECTOR.markers]).toEqual(['.codex', 'AGENTS.md']);
  });

  it('present 命中 .codex 目录或 AGENTS.md，否则 false', async () => {
    expect(CODEX_DETECTOR.present(dir)).toBe(false);
    await mkdir(path.join(dir, '.codex'));
    expect(CODEX_DETECTOR.present(dir)).toBe(true);
  });

  it('detect 返回 { harness, present }', async () => {
    await writeFile(path.join(dir, 'AGENTS.md'), '# hi\n');
    expect(CODEX_DETECTOR.detect(dir)).toEqual({ harness: 'codex', present: true });
  });
});

describe('registerRuntimeDrivers（批 5 detect 槽）', () => {
  it('两 driver 都声明 detect 能力且带 detect 槽', () => {
    const reg = new HarnessRegistry();
    registerRuntimeDrivers(reg);

    const detected = reg.byCapability('detect');
    expect(detected.map((d) => d.id)).toEqual(['claude', 'codex']);
    for (const d of detected) expect(d.detect).toBeDefined();
  });

  it('harness 包骨架不带 init 槽（init 实现半球留 cli wiring）', () => {
    const reg = new HarnessRegistry();
    registerRuntimeDrivers(reg);

    for (const d of reg.all()) {
      expect(supports(d, 'init')).toBe(false);
      expect(d.init).toBeUndefined();
    }
  });
});
