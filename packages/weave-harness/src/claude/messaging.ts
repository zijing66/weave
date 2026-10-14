import { HARNESS_LIFECYCLE, INJECTABLE_EVENTS } from '@weavecode/core';
import type { MessagingSurface } from '../driver.js';
import { CLAUDE_PROMPT_RELAY } from './prompt.js';
import { CLAUDE_RESUME } from './resume.js';

/**
 * Claude 消息能力面（完整参考实现）：四通道全支持——
 * - prompt：原生 peer 消息经受限中继（SendMessage，寻址 = peer 注册表）；
 * - inject：outbox → 会话下一拍 hook 事件随 additionalContext 进会话（非抢占）；
 * - headless：resume 槽规格**对象直接引用**（单源，不复制）；
 * - watch：空闲信号取值源自 HARNESS_LIFECYCLE（close + 会话级终点），不手抄。
 */
export const CLAUDE_MESSAGING: MessagingSurface = {
  harness: 'claude',
  discovery: true,
  prompt: CLAUDE_PROMPT_RELAY,
  inject: { rideEvents: INJECTABLE_EVENTS.claude },
  headless: CLAUDE_RESUME,
  idleSignals: [...HARNESS_LIFECYCLE.claude.close, 'SessionEnd'],
};
