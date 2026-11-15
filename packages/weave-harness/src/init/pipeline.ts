import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, fileExists, writeFileIfAbsent } from '@weavecode/core';
import type { InitOptions, PlatformInfo } from '@weavecode/core';

/** init 执行上下文：InitOptions 加上运行时探测到的平台信息。 */
export type InitContext = InitOptions & { platform: PlatformInfo };

/**
 * init 唯一模板方法（全仓唯一 abstract class）：`runSurface()` final 锁死
 * 1→2→3→4→5→6→6b→7 顺序，子类只覆写钩子。
 */
export abstract class InitPipeline {
  protected readonly ctx: InitContext;
  /** 被跳过的步骤名（按调用顺序；实例字段、不入 ctx，供测试断言）。 */
  readonly skipped: string[] = [];
  /** 步骤 → 跳过原因（`skip` 的 reason 存档，供上层告警文案）。 */
  readonly skipReasons = new Map<string, string>();

  constructor(ctx: InitContext) {
    this.ctx = ctx;
  }

  /**
   * 模板方法：按 1→2→3→4→5→6→6b→7 调用钩子。
   * final 约定——TS 无 final 关键字，子类不得覆写本方法；顺序由 pipeline.test 锁定。
   * 钩子可同步（void）也可异步（Promise<void>），逐个 await。
   */
  async runSurface(): Promise<void> {
    await this.ensureDirs();            // 1
    await this.writeSettings();         // 2
    await this.writeMcp();              // 3
    await this.copySkills();            // 4
    await this.copyCommands();          // 5
    await this.copyAgents();            // 6
    await this.injectPluginTemplates(); // 6b（virtual）
    await this.writeHelpers();          // 7
  }

  /** Step 1：建 harness 表面目录结构。 */
  protected abstract ensureDirs(): void | Promise<void>;
  /** Step 2：生成/合并 settings.json。 */
  protected abstract writeSettings(): void | Promise<void>;
  /** Step 3：生成/合并 MCP 配置。 */
  protected abstract writeMcp(): void | Promise<void>;
  /** Step 4：复制 skills 模板到表面目录。 */
  protected abstract copySkills(): void | Promise<void>;
  /** Step 5：复制 commands 模板到表面目录。 */
  protected abstract copyCommands(): void | Promise<void>;
  /** Step 6：复制 agents 模板到表面目录。 */
  protected abstract copyAgents(): void | Promise<void>;
  /** Step 7：生成 helper 脚本（含标记清扫）。 */
  protected abstract writeHelpers(): void | Promise<void>;
  /** Step 6b（virtual）：插件模板注入（扩展点③），默认 no-op。 */
  protected injectPluginTemplates(): void | Promise<void> {}

  /** 记录一次跳过：步骤名入 `skipped`，原因入 `skipReasons`。 */
  protected skip(step: string, reason: string): void {
    this.skipped.push(step);
    this.skipReasons.set(step, reason);
  }

  /** 深合并写 JSON：force 或文件缺失时直接写入，已存在对象则深合并（`data` 覆盖叶子）；存在但不可解析则跳过不覆写。 */
  protected async writeOrMergeJson(
    filePath: string,
    data: Record<string, unknown>,
    force: boolean,
  ): Promise<boolean> {
    if (!force && (await fileExists(filePath))) {
      const existing = await readJsonObject(filePath);
      if (existing === undefined) return false;
      await writeJson(filePath, deepMerge(existing, data));
      return true;
    }
    await writeJson(filePath, data);
    return true;
  }

  /** 递归复制目录：目标已存在的文件默认跳过（force 覆写），源目录缺失视作无事可做。 */
  protected async copyDirIfAbsent(srcDir: string, destDir: string, force = false): Promise<void> {
    let entries;
    try {
      entries = await readdir(srcDir, { withFileTypes: true });
    } catch {
      return;
    }
    await ensureDir(destDir);
    for (const entry of entries) {
      const src = path.join(srcDir, entry.name);
      const dest = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        await this.copyDirIfAbsent(src, dest, force);
      } else {
        const content = await readFile(src, 'utf-8');
        await writeFileIfAbsent(dest, content, force);
      }
    }
  }

  /** 按标记清扫：递归删除 dir 内容含 marker 且不在 keep（相对 dir 的 posix 路径清单）的文件，返回被删路径。 */
  protected async sweepMarked(
    dir: string,
    keep: readonly string[],
    marker: string,
  ): Promise<string[]> {
    const keepSet = new Set(keep);
    const removed: string[] = [];
    const walk = async (current: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        const rel = path.relative(dir, full).split(path.sep).join('/');
        if (keepSet.has(rel)) continue;
        const content = await readFile(full, 'utf-8').catch(() => null);
        if (content !== null && content.includes(marker)) {
          await unlink(full);
          removed.push(full);
        }
      }
    };
    await walk(dir);
    return removed;
  }
}

/** 深合并：`data` 叶子覆盖 base，普通对象递归、数组整体替换。 */
function deepMerge(
  base: Record<string, unknown>,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(data)) {
    const prev = out[key];
    out[key] = isRecord(prev) && isRecord(value) ? deepMerge(prev, value) : value;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取 JSON 对象文件；缺失、不可解析或非对象返回 undefined。 */
async function readJsonObject(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeJson(filePath: string, data: Record<string, unknown>): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}
