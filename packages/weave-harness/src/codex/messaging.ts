import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { HARNESS_LIFECYCLE } from '@weavecode/core';
import type { AttachSpec, MessagingSurface, PathRefSpec, QueuedPromptSpec, RecognizedRef } from '../driver.js';

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
 * codex 的附件面：普通文件与图片都收。宿主没有文件附件形态——提示词里一条
 * 绝对路径，模型自己读（读得到读不到由用户的 codex 沙箱/工具配置决定，weave
 * 不替它判断）。图片同走路径：`view_image` 工具默认开启（features 表 Stable +
 * default_enabled，0.164 实测本机 rollout 有真实调用），模型拿路径自己看图；
 * 终端通道里用户粘贴图片路径时宿主也会当场转成图附件（`handle_paste_image_path`），
 * 但那是「粘贴事件」才认，weave 投递的路径就是一段正文——两种形态模型都接得住。
 * queue 通道硬拒 `--images`（CLI 形参），路径文本不受影响。
 */
export const CODEX_ATTACH: AttachSpec = {
  kinds: ['file', 'image'],
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
 * Codex 路径引用面：**裸相对路径**就是它自己的引用文法——输入框里按 `@` 唤起的
 * 文件补全，选中后 `@` 连同查询词被**整体替换**成补全给出的相对路径（0.164
 * composer 测试实锤：`"@src  $HOME"` 补全 `src/main.rs` 后文本 = `"src/main.rs
 * $HOME"`；带空格路径包双引号，同 `insert_selected_path`）。目录引用惯例带尾
 * 斜杠（与文件区分，模型按目录理解）。没有行区间文法——宿主不解析路径后缀，
 * `#L` 只会是正文的一部分。
 *
 * 另一头的前提（决定回执比对能不能工作）：这段文本会**原样**出现在
 * UserPromptSubmit 的 hook 载荷里（`prompt` = Text 项拼接，宿主不改写）。
 */
const CODEX_PATH_REF: PathRefSpec = {
  kinds: ['file', 'dir'],
  lines: false,
  expression: ({ path, kind }) => (kind === 'dir' ? `${path}/` : path),
  recognize: (text) => {
    const out: RecognizedRef[] = [];
    // 双引号形式先行：`"my file.md"` 整段引号内都是路径——宿主只对**含空格**的
    // 路径加引号（`insert_selected_path`），故引号内必须有空白才算引用形状，
    // 普通引语不进候选。前后必须都是空白（与 claude 同一判据：粘着字的宁可当
    // 普通文本）。
    for (const m of text.matchAll(/(?:^|\s)"([^"]*\s[^"]*)"(?=\s|$)/g)) {
      const token = m[1]!;
      const start = m.index! + (m[0]!.startsWith(' ') ? 1 : 0);
      const end = start + token.length + 2;
      if (token.startsWith('/') || token.includes(':')) continue;
      out.push({ start, end, ref: text.slice(start, end), path: token, kind: 'file' });
    }
    // 裸形式：一段不含空白/引号、**长得像路径**的词（含 `/` 或 `.`——补全插的
    // 相对路径至少带目录段或扩展名，普通单词不进候选）。目录带尾斜杠；没有
    // 斜杠的交给调用方按索引判类型。绝对路径、盘符、反斜杠不是项目内引用。
    for (const m of text.matchAll(/(?:^|\s)([^\s"]+)(?=\s|$)/g)) {
      const token = m[1]!;
      if (!/[./]/.test(token)) continue;
      const start = m.index! + (m[0]!.startsWith(' ') ? 1 : 0);
      const end = start + token.length;
      if (token.startsWith('/') || token.includes(':') || token.includes('\\')) continue;
      if (out.some((r) => start >= r.start && end <= r.end)) continue;
      const dir = token.endsWith('/');
      const p = dir ? token.slice(0, -1) : token;
      if (!p) continue;
      out.push({ start, end, ref: text.slice(start, end), path: p, kind: dir ? 'dir' : 'file' });
    }
    return out.sort((a, b) => a.start - b.start);
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
  idleSignals: [...HARNESS_LIFECYCLE.codex.close, 'SessionEnd'],
  paneEnvSource: 'launch',
  attach: CODEX_ATTACH,
  pathRefs: CODEX_PATH_REF,
  sideQuestion: null,
  unsupportedReasons: {
    discovery: 'Codex event ingestion is pending research (BACKLOG §10-6); sessions are not discoverable',
    prompt: 'Codex has no native peer-messaging channel; prompts reach it via its own queue or terminal text injection',
    inject: 'Codex has no synchronous injection channel yet (pending research)',
    headless: 'Codex resume is pending research',
    watch: 'Codex error-ended turns emit no Stop; those rounds never fire idle/turnEnd',
    sideQuestion: 'Codex side chat is pending research (BACKLOG §10-6)',
  },
};
