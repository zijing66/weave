import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { HARNESS_KEYS, isHarness, type Harness } from '@weavecode/core';
import type { HarnessRegistry } from '@weavecode/harness';

/**
 * 项目「已接入的 harness」的**唯一权威事实 = init 选择结果**：`weave init` 把用户
 * 选的 harness 列表写进 `.weave/config.yaml` 的 `harnesses`（JSON 数组，与
 * `init/executor.ts` 同一处生成）。
 *
 * 为什么不用 Detector 的 marker 探测：init 恒建 `AGENTS.md → CLAUDE.md` 链接，codex
 * 探测器（marker = `AGENTS.md`）对任何 weave 项目都假阳性。探测答的是「目录结构像不像」，
 * 这里问的是「用户 init 时装了什么」。
 *
 * 老项目 / 未 weave 化的项目没有该字段：回落注册表首个（起会话的既有默认，不写死名字）。
 */
async function readProjectHarnesses(projectPath: string): Promise<Harness[]> {
  const fallback: Harness[] = [HARNESS_KEYS[0]!];
  let raw: string;
  try {
    raw = await readFile(path.join(projectPath, '.weave', 'config.yaml'), 'utf-8');
  } catch {
    return fallback;
  }
  const line = raw.split('\n').find((l) => l.startsWith('harnesses:'));
  if (!line) return fallback;
  try {
    const parsed = JSON.parse(line.slice(line.indexOf(':') + 1).trim()) as unknown;
    const ids = Array.isArray(parsed) ? parsed.filter(isHarness) : [];
    return ids.length > 0 ? ids : fallback;
  } catch {
    return fallback;
  }
}

/** 项目行 / 新建会话共用的一个已接入 harness。 */
export interface ProjectHarness {
  id: Harness;
  /** true = 该 harness 有 resume 槽的裸 bin，可「在项目既有终端里新建会话」；
   *  false（如 codex）只出现在项目卡标签里，不进新建会话的可选项。 */
  canStartSession: boolean;
}

/** 项目的已接入 harness（init 选择结果）+ 各自能否起交互会话（注册表现状）。 */
export async function projectHarnesses(
  projectPath: string,
  registry?: HarnessRegistry,
): Promise<ProjectHarness[]> {
  return (await readProjectHarnesses(projectPath)).map((id) => ({
    id,
    canStartSession: Boolean(registry?.get(id)?.resume?.bin),
  }));
}

/** 项目行补上 `harnesses` 字段（项目列表 / 归档面）——项目卡标签与新建会话的
 *  harness 选项同源，不给 web 第二处取数。 */
export async function withProjectHarnesses<T extends { path: string }>(
  rows: T[],
  registry?: HarnessRegistry,
): Promise<(T & { harnesses: ProjectHarness[] })[]> {
  return Promise.all(
    rows.map(async (row) => ({ ...row, harnesses: await projectHarnesses(row.path, registry) })),
  );
}
