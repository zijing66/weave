import type { Harness } from '@weavecode/core';
import type { HookEventInput } from '../repositories/hook-events.js';
import type { HookReport } from './types.js';

/**
 * Normalizes a raw hook report from a specific agent into the unified
 * {@link HookEventInput} shape for persistence.
 *
 * 批 4b 兼容类型：实现已迁入 `@weavecode/harness`（ClaudeEventSource），本接口保留
 * 具体签名（HookReport → HookEventInput）供既有注入方使用——与 harness 的
 * `EventSource` 结构兼容（normalize 参数放宽为 unknown、返回收窄为具体行，
 * 方法双变下 HookAdapter 是 EventSource 的结构子类型）。
 */
export interface HookAdapter {
  readonly source: Harness;
  normalize(report: HookReport, projectId: number): HookEventInput;
}

/**
 * 旧名保留（批 4b 迁出）：构造与行为与原 ClaudeCodeAdapter 完全一致，
 * `new ClaudeCodeAdapter()` 等价于 `new ClaudeEventSource()`。
 */
export { ClaudeEventSource as ClaudeCodeAdapter } from '@weavecode/harness';
