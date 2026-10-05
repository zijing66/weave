import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { AssetCategory } from './types.js';

/**
 * sniff 一个 `plugin` 文件所在的插件包是否为 mods 包（`hooks/hooks.json`
 * 声明非空 `modules`）——是则整个包的文件全部翻转为 `mods`。
 *
 * 同步 fs（watch onFile 是同步回调）；per-目录缓存带 mtime 失效，命中时
 * 对比 mtime，变了重读。
 */

const MAX_UP = 8;

export interface PluginModsSnifferOptions {
  /**
   * 命中 startDir 结论后是否仍重走上行链（mtime 失效语义）。watch 长命实例
   * 保持 true；请求级实例（全局树 walk，每请求新建）传 false——请求内文件
   * 视为稳定，同目录兄弟文件直接复用结论。
   */
  revalidate?: boolean;
}

export class PluginModsSniffer {
  /** 包目录 → verdict + 该包 hooks.json 的 mtime（缺失记 -1）。 */
  private readonly cache = new Map<string, { mods: boolean; hooksMtimeMs: number }>();
  /** startDir → 上行链结论（仅 revalidate=false 实例写入并复用）。 */
  private readonly verdicts = new Map<string, boolean>();
  private readonly revalidate: boolean;

  constructor(options: PluginModsSnifferOptions = {}) {
    this.revalidate = options.revalidate ?? true;
  }

  refine(category: AssetCategory, _relPath: string, absPath: string): AssetCategory {
    if (category !== 'plugin') return category;
    return this.sniff(path.dirname(absPath)) ? 'mods' : 'plugin';
  }

  private sniff(startDir: string): boolean {
    if (!this.revalidate) {
      const hit = this.verdicts.get(startDir);
      if (hit !== undefined) return hit;
    }
    const mods = this.walkUp(startDir);
    if (!this.revalidate) this.verdicts.set(startDir, mods);
    return mods;
  }

  private walkUp(startDir: string): boolean {
    let dir = startDir;
    for (let i = 0; i < MAX_UP; i++) {
      if (isPluginRoot(dir)) return false; // 上界：根目录本身不再检查
      if (this.hooksMods(dir)) return true;
      // 包根（含 .claude-plugin/plugin.json）且本级无非空 modules →
      // 立即判非 mods 停止，防嵌套子包被外层 mods 包污染。
      if (existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) return false;
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
    return false;
  }

  /** exists 探测替代 statSync 抛异常（多数祖先层无 hooks.json，异常控制流贵）。 */
  private hooksMods(dir: string): boolean {
    const hooksPath = path.join(dir, 'hooks', 'hooks.json');
    const hit = this.cache.get(dir);
    let mtimeMs = -1;
    if (existsSync(hooksPath)) {
      try {
        mtimeMs = statSync(hooksPath).mtimeMs;
      } catch {
        // exists 与 stat 之间被并发删除 → 维持缺失语义
      }
    }
    if (mtimeMs === -1) {
      if (hit?.hooksMtimeMs !== -1) this.cache.set(dir, { mods: false, hooksMtimeMs: -1 });
      return false;
    }
    if (hit && hit.hooksMtimeMs === mtimeMs) return hit.mods;
    const mods = readModulesNonEmpty(hooksPath);
    this.cache.set(dir, { mods, hooksMtimeMs: mtimeMs });
    return mods;
  }
}

/** `<...>/.claude/plugins` 或 `<...>/.weave/plugins` 目录本身（上界）。 */
function isPluginRoot(dir: string): boolean {
  if (path.basename(dir) !== 'plugins') return false;
  const parent = path.basename(path.dirname(dir));
  return parent === '.claude' || parent === '.weave';
}

/** mods 判定核心（toolkit-scan 复用）：hooks.json 对象的 modules 为非空数组。 */
export function hasNonEmptyModules(hooksJson: unknown): boolean {
  if (!hooksJson || typeof hooksJson !== 'object' || Array.isArray(hooksJson)) return false;
  const modules = (hooksJson as { modules?: unknown }).modules;
  return Array.isArray(modules) && modules.length > 0;
}

/** 与 toolkit-scan readJson 语义对齐：非法 JSON → null → 非 mods。 */
function readModulesNonEmpty(hooksPath: string): boolean {
  try {
    return hasNonEmptyModules(JSON.parse(readFileSync(hooksPath, 'utf8')));
  } catch {
    return false;
  }
}
