import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { HARNESS_KEYS, isHarness, type Harness } from '@weavecode/core';
import type { HarnessRegistry } from '@weavecode/harness';
import { isVersionAtLeast } from '../hooks/toolkit.js';

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
 *
 * 「这个项目该不该采某个 harness 的日志」也走它（拉取式采集的 cwd 白名单来源）。
 */
export async function projectHarnessIds(projectPath: string): Promise<Harness[]> {
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
  /** true = 该 harness 有 resume 槽的裸 bin、且宿主版本够（`resume.minVersion`），
   *  可「新建会话」；false 只出现在项目卡标签与新建会话弹层的置灰行里。 */
  canStartSession: boolean;
  /** 探到的宿主版本（只有设了 `minVersion` 的 harness 才探；探不到 = null）。 */
  version?: string | null;
  /** resume 槽的版本下限（UI 据此说明为什么置灰）。 */
  minVersion?: string;
}

const VERSION_TTL_MS = 600_000;
/** 缓存的是**在飞的那次探测**（promise）：`GET /projects` 逐项目并发取版本时共用
 *  一次 spawn，不按项目数起一串子进程。失败不留缓存（下一次重探）。 */
const versionCache = new Map<string, { at: number; value: Promise<string | null> }>();

/** `<bin> --version` 的首个 semver；探不到 null（win32 上 npm shim 是 .cmd，须走 shell）。 */
function probeBinVersion(bin: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let out = '';
    const child =
      process.platform === 'win32'
        ? spawn(`${bin} --version`, { windowsHide: true, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(bin, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, 5000);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const m = /(\d+\.\d+\.\d+)/.exec(out);
      resolve(m ? m[1]! : null);
    });
  });
}

function detectBinVersion(bin: string): Promise<string | null> {
  const cached = versionCache.get(bin);
  if (cached && Date.now() - cached.at < VERSION_TTL_MS) return cached.value;
  const value = probeBinVersion(bin).then((v) => {
    if (v === null) versionCache.delete(bin);
    return v;
  });
  versionCache.set(bin, { at: Date.now(), value });
  return value;
}

/** 项目的已接入 harness（init 选择结果）+ 各自能否起交互会话（注册表现状）。 */
export async function projectHarnesses(
  projectPath: string,
  registry?: HarnessRegistry,
  /** 版本探测（测试注入；缺省真跑 `<bin> --version`）。 */
  versionOf: (bin: string) => Promise<string | null> = detectBinVersion,
): Promise<ProjectHarness[]> {
  const ids = await projectHarnessIds(projectPath);
  return Promise.all(
    ids.map(async (id) => {
      const spec = registry?.get(id)?.resume;
      if (!spec?.bin) return { id, canStartSession: false };
      if (!spec.minVersion) return { id, canStartSession: true };
      const version = await versionOf(spec.bin);
      const min = spec.minVersion.split('.').map((n) => Number.parseInt(n, 10));
      // 探不到版本不拦（与 mod 版本闸同口径：拿不到就放行，低误报优先）。
      const ok = version === null || isVersionAtLeast(version, min);
      return { id, canStartSession: ok, version, minVersion: spec.minVersion };
    }),
  );
}

/** 项目行补上 `harnesses` 字段（项目列表 / 归档面）——项目卡标签与新建会话的
 *  harness 选项同源，不给 web 第二处取数。 */
export async function withProjectHarnesses<T extends { path: string }>(
  rows: T[],
  registry?: HarnessRegistry,
  /** 版本探测（测试注入；缺省见 `projectHarnesses`）。 */
  versionOf?: (bin: string) => Promise<string | null>,
): Promise<(T & { harnesses: ProjectHarness[] })[]> {
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      harnesses: await projectHarnesses(row.path, registry, versionOf),
    })),
  );
}
