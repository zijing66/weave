import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AttachSpec, MessagingSurface, QueuedPromptSpec } from '../driver.js';

/**
 * codex CLI 的可直接 spawn 入口。win32 的 `codex` 可能是 `.cmd` 垫片
 * （CreateProcess 不认，npm 垫片与 WindowsApps shim 都是），而 queue 的正文
 * 只能进 argv（CLI 没有 stdin 形）——经 shell 拼串会被 `%VAR%` 展开、`&` /
 * 引号改写甚至注入。故 win32 依次找：env 覆盖 → PATH 上的 `codex.exe`
 * （原生 PE 可直接 spawn）→ `.cmd` 垫片（读首行引号里的 exe 真身，shim 我们
 * 自己写的、npm 垫片也有同形首行）→ 包里声明的 bin 入口
 * `node <pkg>/bin/codex.js`。都探不到就按裸名 spawn，失败即回落下一层。
 */
function codexCommand(): { bin: string; prefix: string[] } {
  const override = process.env.WEAVE_CODEX_BIN;
  if (override && override.trim()) return { bin: override.trim(), prefix: [] };
  if (process.platform !== 'win32') return { bin: 'codex', prefix: [] };
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const exe = path.join(dir, 'codex.exe');
    if (existsSync(exe)) return { bin: exe, prefix: [] };
    const cmdShim = path.join(dir, 'codex.cmd');
    if (existsSync(cmdShim)) {
      try {
        // 首个非空行可能是 `@echo off`；exe 行在其后（`"…codex.exe" %*`）
        const line = readFileSync(cmdShim, 'utf8')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => /^".+?\.exe"/.test(l));
        const m = /^"(.+?\.exe)"/.exec(line ?? '');
        if (m && existsSync(m[1]!)) return { bin: m[1]!, prefix: [] };
      } catch {
        /* 垫片读不了就试下一处 */
      }
    }
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
 * codex 的附件面：只有普通文件。宿主没有文件附件形态——提示词里一条绝对路径，
 * 模型自己读（读得到读不到由用户的 codex 沙箱/工具配置决定，weave 不替它判断）。
 * 图片不在此列：queue 通道硬拒 `--images`，终端通道也没有「路径 → 图」的转换。
 */
export const CODEX_ATTACH: AttachSpec = {
  kinds: ['file'],
  composePrompt(text, files) {
    // 原文里已含某附件路径（web 的占位胶囊序列化进来的）＝用户已亲手摆了位置，
    // 不再末尾追加——删掉胶囊路径就从原文消失，追加自动恢复（自愈）。
    const rest = files.filter((f) => !text.includes(f.path));
    if (rest.length === 0) return text;
    const paths = rest.map((f) => f.path).join('\n');
    return text ? `${text}\n\n${paths}` : paths;
  },
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
  attach: CODEX_ATTACH,
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
