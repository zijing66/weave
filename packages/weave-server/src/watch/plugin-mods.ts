import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { AssetCategory } from './types.js';

/**
 * sniff 一个 `plugin` 文件所在的插件包是否为 mods 包（`hooks/hooks.json`
 * 声明非空 `modules`）——是则整个包的文件全部翻转为 `mods`。
 *
 * 同步 fs（watch onFile 是同步回调）；带 per-目录缓存，命中时 stat
 * hooks.json 对比 mtime，变了重读。
 */

const MAX_UP = 8;

export class PluginModsSniffer {
  /** 包目录 → verdict + 该包 hooks.json 的 mtime（缺失记 -1）。 */
  private readonly cache = new Map<string, { mods: boolean; hooksMtimeMs: number }>();

  refine(category: AssetCategory, _relPath: string, absPath: string): AssetCategory {
    if (category !== 'plugin') return category;
    return this.sniff(path.dirname(absPath)) ? 'mods' : 'plugin';
  }

  private sniff(startDir: string): boolean {
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

  private hooksMods(dir: string): boolean {
    const hooksPath = path.join(dir, 'hooks', 'hooks.json');
    let mtimeMs: number;
    try {
      mtimeMs = statSync(hooksPath).mtimeMs;
    } catch {
      // 文件不存在 → 非 mods；缓存 -1，之后出现文件时 mtime 必不同 → 重读。
      const hit = this.cache.get(dir);
      if (hit && hit.hooksMtimeMs === -1) return false;
      this.cache.set(dir, { mods: false, hooksMtimeMs: -1 });
      return false;
    }
    const hit = this.cache.get(dir);
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

/** 与 toolkit-scan readJson 语义对齐：非法 JSON → null → 非 mods。 */
function readModulesNonEmpty(hooksPath: string): boolean {
  try {
    const raw: unknown = JSON.parse(readFileSync(hooksPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const modules = (raw as { modules?: unknown }).modules;
    return Array.isArray(modules) && modules.length > 0;
  } catch {
    return false;
  }
}
