import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import type { StatuslineSurface } from '../../driver.js';
import { SEGMENT_ORDER, type StatuslineConfig } from './config.js';
import { generateStatuslineScript } from './generator.js';
import { statuslineFactsFromCache } from './git-cache.js';

const HELPERS_DIR = '.claude/helpers';
const STATUSLINE_SCRIPT = 'statusline.cjs';
const SETTINGS_FILE = '.claude/settings.json';

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep `.claude/settings.json`'s `statusLine` pointing at the generated script,
 * with a `refreshInterval` (seconds) so Claude Code re-runs it on a timer during
 * idle periods — updates after each assistant response are event-driven by
 * Claude Code itself and need no weave-side polling. Preserves all other
 * settings. Idempotent.
 */
export async function ensureSettingsStatusLine(
  projectPath: string,
  opts: { scriptPath: string; refreshInterval: number },
): Promise<void> {
  const file = path.join(projectPath, SETTINGS_FILE);
  const isWindows = process.platform === 'win32';
  let settings: Record<string, unknown> = {};
  if (await pathExists(file)) {
    try {
      settings = JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>;
    } catch {
      settings = {};
    }
  }
  const scriptPath = opts.scriptPath;
  const command = isWindows ? `node "${scriptPath}"` : `node ${scriptPath}`;
  settings['statusLine'] = {
    type: 'command',
    command,
    padding: 0,
    refreshInterval: Math.max(1, Math.round(opts.refreshInterval)),
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
}

/**
 * Claude Code 的状态栏面：weave 生成脚本、宿主每轮调用它渲染在 TUI 底部。
 *
 * `segments` 就是 Claude Code statusline stdin JSON 能填的块（词表见
 * `config.ts` 的 `SegmentKey`）——别的 harness 的面（或没有面）由它们自己声明，
 * web 只渲染能力表给出的块。
 */
export const CLAUDE_STATUSLINE: StatuslineSurface = {
  segments: SEGMENT_ORDER,
  tui: 'injectable',
  scriptRelPath: `${HELPERS_DIR}/${STATUSLINE_SCRIPT}`,
  // 配置形状归 claude（StatuslineConfig）；槽位对配置类型不做假设。
  generate: (config, ctx) => generateStatuslineScript(config as StatuslineConfig, ctx),
  wire: ensureSettingsStatusLine,
  facts: statuslineFactsFromCache,
};
