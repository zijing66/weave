import type { MemorySinkSurface } from '../driver.js';
import { createClaimBlockMemorySink } from '../shared/memory-sink.js';

/**
 * claude 的项目记忆文件 = `CLAUDE.local.md`（宿主原生私有备注档，惯例不入库、
 * 机器不碰用户段）。编排记忆出口的判决写进认领区块（滑动窗口裁旧）；用户在
 * 区块外写的内容字节不动（append-only 合并纪律）。
 */
export const CLAUDE_MEMORY: MemorySinkSurface = createClaimBlockMemorySink('claude', 'CLAUDE.local.md', {
  start: '<!-- weave:verdicts:start -->',
  end: '<!-- weave:verdicts:end -->',
  header: '<!-- Machine-maintained by weave orchestration; entries inside this block are trimmed automatically. -->',
  maxEntries: 20,
});
