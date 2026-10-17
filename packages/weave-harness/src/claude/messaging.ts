import { HARNESS_LIFECYCLE, INJECTABLE_EVENTS } from '@weavecode/core';
import type { ImageAttachSpec, MessagingSurface } from '../driver.js';
import { CLAUDE_PROMPT_INBOX } from './prompt-inbox.js';
import { CLAUDE_PROMPT_RELAY } from './prompt.js';
import { CLAUDE_RESUME } from './resume.js';

/**
 * Claude 图片对齐面：**裸绝对路径、不加任何说明**——用户自己往输入框粘贴一条图片
 * 路径时它就是这么认的（粘贴处理器按 `\.(png|jpe?g|gif|webp)$` 切出路径 → 读文件 →
 * 输入框变 `[Image #N]` + 消息里出真 image block）。路径放**独立一行**：粘贴处理器
 * 先按空格切路径边界、再按换行切行，行首的路径照样命中；落在原文后面则原文被原样
 * 留在输入框、图单独挂上。
 */
export const CLAUDE_IMAGE_ATTACH: ImageAttachSpec = {
  composePrompt(text, images) {
    const paths = images.map((i) => i.path).join('\n');
    return text ? `${text}\n\n${paths}` : paths;
  },
};

/**
 * Claude 消息能力面（完整参考实现）：四通道全支持——
 * - prompt：原生 peer 消息经受限中继（SendMessage，寻址 = peer 注册表）；
 * - promptInbox：会话本地 inbox socket 直投（毫秒级、零进程零 LLM）；
 * - inject：outbox → 会话下一拍 hook 事件随 additionalContext 进会话（非抢占）；
 * - headless：resume 槽规格**对象直接引用**（单源，不复制）；
 * - watch：空闲信号取值源自 HARNESS_LIFECYCLE（close + 会话级终点），不手抄；
 * - imageAttach：图片按 claude 自己的「粘贴路径」文法对齐（见上）。
 */
export const CLAUDE_MESSAGING: MessagingSurface = {
  harness: 'claude',
  discovery: true,
  prompt: CLAUDE_PROMPT_RELAY,
  promptInbox: CLAUDE_PROMPT_INBOX,
  inject: { rideEvents: INJECTABLE_EVENTS.claude },
  headless: CLAUDE_RESUME,
  idleSignals: [...HARNESS_LIFECYCLE.claude.close, 'SessionEnd'],
  imageAttach: CLAUDE_IMAGE_ATTACH,
};
