import type { MemorySinkSurface } from '../driver.js';
import { createClaimBlockMemorySink } from '../shared/memory-sink.js';

/**
 * codex 的项目记忆文件 = `AGENTS.md`（宿主惯例：进版本库、团队共享）。weave
 * init 的双 harness 项目里它常是 CLAUDE.md 的链接——writeFile 自然穿透链接
 * 落进同一份说明文件。认领区块滑动窗口裁旧；入库与否归项目自己的选择，weave
 * 不替用户做 gitignore 决定。
 */
export const CODEX_MEMORY: MemorySinkSurface = createClaimBlockMemorySink('codex', 'AGENTS.md', {
  start: '<!-- weave:verdicts:start -->',
  end: '<!-- weave:verdicts:end -->',
  header: '<!-- Machine-maintained by weave orchestration; entries inside this block are trimmed automatically. -->',
  maxEntries: 20,
});
