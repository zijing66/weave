import type { Harness } from '@weavecode/core';

/**
 * File-backed harness asset kinds — the single source of truth for everything
 * that installs as ONE file (unlike skills, which install as a directory).
 *
 * A kind is fully described by its落点表 `dirs`：键 = harness，值 = 该 harness 的
 * 项目/用户级相对路径（posix 分隔）。缺项 = 该 harness 无此面（Codex 项目面
 * 仅 skills；Codex 目前也没有单文件资产面——其项待补）。
 *
 * **按 harness 名硬编码成列是反模式**（旧 `dir`/`userDir`/`codexUserDir` 三列，
 * 第三个 harness 无处安放）——加 harness = 在 `dirs` 里加一个键。
 *
 * The same table drives: library scanning (scanner.ts), install/uninstall
 * (installer.ts), update detection (updates.ts) and the dashboard badges.
 *
 * 批 4a 从 `weave-server/src/install/file-assets.ts` 迁入（纯数据 + 类型，
 * 零依赖）；server 原位置 re-export，存量 import 零改动。
 */

/** Asset kinds installed as a single file (skills excluded — directory assets). */
export type FileAssetCategory = 'command' | 'agent' | 'workflow' | 'rule' | 'output-style';

/** 一个 harness 在某个类别下的落点（相对路径；缺项 = 该面不存在）。 */
export interface FileAssetDirs {
  /** 项目内相对项目根的目录。 */
  project?: string;
  /** 用户级相对 `~` 的目录。 */
  user?: string;
}

export interface FileAssetSpec {
  /** File extension for this kind. */
  ext: '.md' | '.js';
  /** 落点表：键 = harness（加 harness = 加一个键，不动本表其余行）。 */
  dirs: Partial<Record<Harness, FileAssetDirs>>;
}

export const FILE_ASSET_SPECS: Record<FileAssetCategory, FileAssetSpec> = {
  command: {
    ext: '.md',
    dirs: { claude: { project: '.claude/commands', user: '.claude/commands' } },
    // No Codex surface: Codex removed custom prompts (`$CODEX_HOME/prompts`,
    // gone from its source), and its slash commands are a compile-time enum.
    // Its only file-based command path is a plugin's `commands/`, which Codex
    // migrates into skills on load.
  },
  agent: {
    ext: '.md',
    dirs: { claude: { project: '.claude/agents', user: '.claude/agents' } },
  },
  workflow: {
    ext: '.js',
    dirs: { claude: { project: '.claude/workflows' } },
  },
  rule: {
    ext: '.md',
    dirs: { claude: { project: '.claude/rules' } },
  },
  'output-style': {
    ext: '.md',
    dirs: { claude: { project: '.claude/output-styles', user: '.claude/output-styles' } },
  },
};

export const FILE_ASSET_CATEGORIES = Object.keys(FILE_ASSET_SPECS) as FileAssetCategory[];

/** Is `category` one of the single-file asset kinds? */
export function isFileAssetCategory(category: string): category is FileAssetCategory {
  return Object.prototype.hasOwnProperty.call(FILE_ASSET_SPECS, category);
}
