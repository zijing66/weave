import { existsSync } from 'node:fs';
import path from 'node:path';
import type { MessagingSurface, QueuedPromptSpec } from '../driver.js';

/**
 * codex CLI 的可直接 spawn 入口。win32 的 `codex` 是 npm `.cmd` 垫片
 * （CreateProcess 不认），而 queue 的正文只能进 argv（CLI 没有 stdin 形）——
 * 经 shell 拼串会被 `%VAR%` 展开、`&` / 引号改写甚至注入。故 win32 走包里
 * 声明的 bin 入口：`node <pkg>/bin/codex.js`，argv 原样转交原生二进制。
 * 探不到（如 pnpm 全局布局）就按裸名 spawn，失败即回落下一层。
 */
function codexCommand(): { bin: string; prefix: string[] } {
  const override = process.env.WEAVE_CODEX_BIN;
  if (override && override.trim()) return { bin: override.trim(), prefix: [] };
  if (process.platform !== 'win32') return { bin: 'codex', prefix: [] };
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const js = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(js)) return { bin: process.execPath, prefix: [js] };
  }
  return { bin: 'codex', prefix: [] };
}

/**
 * codex 的宿主排队投递：`codex queue --thread <UUID> --message <TEXT>` 经
 * app-server 的 `thread/queue/add` 写进目标会话自己的队列——活会话 <1s 注入、
 * 没开的会话下次 resume 自动领走。它在宿主眼里就是一条普通 user 回合
 * （**没有带外来源位**，见 docs/DECISIONS.md 2026-10-21），故手动面也走它。
 * 不收图（CLI 硬拒 `--images`）——带图消息由投递层优先走终端。
 */
export const CODEX_QUEUED_PROMPT: QueuedPromptSpec = {
  command(sessionId, text) {
    const { bin, prefix } = codexCommand();
    return { bin, args: [...prefix, 'queue', '--thread', sessionId, '--message', text] };
  },
  timeoutMs: 30_000,
};

/**
 * Codex 消息能力面：**显式不支持面**（不支持通道 null + 原因，不是槽位缺席——
 * 缺席无法渲染「为什么置灰」）。prompt 走宿主队列（`codex queue`，见上）+ 终端
 * send-text 兜底；无原生 peer 消息（中继）。B0 调研（BACKLOG §10-6）落地后在
 * 本文件逐通道点亮，编排层零改动。
 */
export const CODEX_MESSAGING: MessagingSurface = {
  harness: 'codex',
  discovery: false,
  prompt: null,
  promptInbox: null,
  queuedPrompt: CODEX_QUEUED_PROMPT,
  inject: null,
  headless: null,
  idleSignals: [],
  imageAttach: null,
  pathRefs: null,
  sideQuestion: null,
  unsupportedReasons: {
    discovery: 'Codex event ingestion is pending research (BACKLOG §10-6); sessions are not discoverable',
    prompt: 'Codex has no native peer-messaging channel; prompts reach it via its own queue or terminal text injection',
    inject: 'Codex has no synchronous injection channel yet (pending research)',
    headless: 'Codex resume is pending research',
    watch: 'Codex idle signals are pending research; watch is unavailable',
    pathRefs: 'Codex path references are pending research (BACKLOG §10-6); only plain paths can be typed',
    sideQuestion: 'Codex side chat is pending research (BACKLOG §10-6)',
  },
};
