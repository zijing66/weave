/**
 * claude 判活的唯一实现已迁 harness（`@weavecode/harness` 的 claude/liveness.ts
 * ——判据是 harness 专属知识，server 不自拼）。本文件只剩 re-export 壳：
 * 存量 import 点（hooks 域 6 文件 + daemon 域 4 文件 + 测试）不动。
 */
export {
  type ClaudeSessionReg,
  parseClaudeSessionReg,
  pidAlive,
  CLAUDE_REG_GRACE_MS,
  pidAliveOf,
  shellDiscardedByClaude,
  claudeLivenessById,
} from '@weavecode/harness';
