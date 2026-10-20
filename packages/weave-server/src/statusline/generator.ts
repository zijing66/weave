import { generateStatuslineScript as generate } from '@weavecode/harness';
import type { StatuslineConfig } from './config.js';
import { getStatuslineDir } from '../db/paths.js';
import { WEAVE_VERSION } from '../version.js';

/**
 * 渲染缓存的落点：`<dataDir>/cache/statusline/<session>.json`（可弃档，不迁移）。
 *
 * 旧版写系统临时目录、且按 cwd 分文件——cwd 会随子目录与测试临时目录无限
 * 增殖，实测两天攒下 1151 个文件且无人回收。统一收进数据目录后，按会话
 * 一个文件（分会话自带天然上限），过期条目与陈旧文件由 daemon 的
 * `StatuslineCacheSweeper` 回收。
 */
export function statuslineCacheDir(): string {
  return getStatuslineDir();
}

/**
 * 生成 `helpers/statusline.cjs` 源码——脚本本体归 claude 的 statusline 表示法，
 * 实现在 `weave-harness/src/claude/statusline/`；这里的两个落点参数是 server
 * 的事实（dataDir 布局与包版本），由调用侧取。
 */
export function generateStatuslineScript(
  config: StatuslineConfig,
  opts: { cacheDir?: string } = {},
): string {
  return generate(config, {
    cacheDir: opts.cacheDir ?? statuslineCacheDir(),
    version: WEAVE_VERSION,
  });
}
