import type { MessagingSurface } from '../driver.js';

/**
 * Codex 消息能力面：**显式不支持面**（全通道 null + 原因，不是槽位缺席——
 * 缺席无法渲染「为什么置灰」）。B0 调研（BACKLOG §10-6）落地后在本文件逐通道
 * 点亮，编排层（路由裁决 / UI 矩阵 / watch 引擎）零改动。
 */
export const CODEX_MESSAGING: MessagingSurface = {
  harness: 'codex',
  discovery: false,
  inject: null,
  headless: null,
  idleSignals: [],
  unsupportedReasons: {
    discovery: 'Codex event ingestion is pending research (BACKLOG §10-6); sessions are not discoverable',
    inject: 'Codex has no synchronous injection channel yet (pending research)',
    headless: 'Codex resume is pending research',
    watch: 'Codex idle signals are pending research; watch is unavailable',
  },
};
