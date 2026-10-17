import type { MessagingSurface } from '../driver.js';

/**
 * Codex 消息能力面：**显式不支持面**（全通道 null + 原因，不是槽位缺席——
 * 缺席无法渲染「为什么置灰」）。prompt 例外走层②：无原生 peer 消息，但终端
 * send-text 兜底可用时路由侧点亮（矩阵口径 = 原生 || 终端兜底）。B0 调研
 * （BACKLOG §10-6）落地后在本文件逐通道点亮，编排层零改动。
 */
export const CODEX_MESSAGING: MessagingSurface = {
  harness: 'codex',
  discovery: false,
  prompt: null,
  promptInbox: null,
  inject: null,
  headless: null,
  idleSignals: [],
  imageAttach: null,
  unsupportedReasons: {
    discovery: 'Codex event ingestion is pending research (BACKLOG §10-6); sessions are not discoverable',
    prompt: 'Codex has no native peer-messaging channel; prompts can only reach it via terminal text injection where the configured terminal supports it',
    inject: 'Codex has no synchronous injection channel yet (pending research)',
    headless: 'Codex resume is pending research',
    watch: 'Codex idle signals are pending research; watch is unavailable',
  },
};
