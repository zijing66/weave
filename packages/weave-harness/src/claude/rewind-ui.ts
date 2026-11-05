import type {
  RewindPickerItem,
  RewindPickerOption,
  RewindPickerSpec,
  RewindPickerView,
} from '../driver.js';

/**
 * claude 的 `/rewind` 面板文法（2.1.296 bundle 逆向 + 活体读屏校）。
 *
 * 面板两屏：
 * 1. **列表屏**：标题 `Rewind` + 头 `Restore the code and/or conversation to the point
 *    before…`（没开文件检查点时是 `Restore and fork the conversation to the point
 *    before…`），下面每条 = 该条 prompt 一行（长文按宽度截断）+ 可选的「改了几个
 *    文件 +N -M」元数据行，末尾恒有一条 `(current)`（当前点）。窗口装不下时用
 *    `↑ N more` / `↓ N more` 两行报告上/下被裁掉的条数——**这两个计数是纯文本**，
 *    屏上就能算出每条的列表绝对索引。焦点行有行首指针 `❯`（2026-11-04 活体读屏
 *    实测；bundle 逆向时只看到颜色标记、漏了它）⇒「焦点落在哪条」也读得出来，
 *    选完可以先核对再回车。
 * 2. **确认屏**：`Confirm you want to restore to the point before you sent this
 *    message:` + 被选中的那条原文（可用来核对落点）+ 描述行（随焦点变：`The
 *    conversation will be forked.` / `The conversation will be unchanged.` 与 `The
 *    code will be unchanged.` / `The code will be restored …`）+ **编号选项表**
 *    （`❯ 1. Restore conversation` / `2. Summarize from here` / `3. Summarize up to
 *    here` / `4. Never mind`…）。选项随**选中的那条消息**变：同一条列表头上，
 *    消息没挂文件改动就只有 `Restore conversation`、没有代码档 ⇒ 档位只能从这一屏读。
 *
 * 键：Select 上下文里 up/down/enter/escape；claude 开着 Kitty 键盘协议，方向键仍是
 * `ESC[A`/`ESC[B`（协议只重编 Esc/Enter 等），Enter = CR。
 */
// 头行在窄屏会被折成两行（`… to the` / `point before…`），故锚只取尾巴
const LIST_HEADER = /point before/;

/** 面板里非条目的行：元数据（`foo.ts +3 -1` / `foo.ts +35` / `N files changed +3 -1`）与空态。 */
const META_LINE =
  /^No code changes$|^No code restore$|^\d+\s+files?\s+changed(?:\s+[+-]\d+)*$|^\S*[./]\S*\s+[+-]\d+(?:\s+[+-]\d+)?$/;
/** 溢出行：`↑ 3 more` / `↓ 2 more`（箭头字形不写死，方向按位置判）。 */
const MORE_LINE = /^\S*\s*(\d+)\s+more$/;
/** 列表屏结束：底部引导 / 分隔线——再往下是 TUI 的常驻 chrome。 */
const STOP_LINE = /^[╭╮╰╯─━]{3,}|esc(?:ape)?\s+(?:to\s+)?cancel|enter to continue/i;

/** 面板是带边框的框：剥掉左右框线与首尾空白；行首的 `❯` 是焦点指针
 *  （2026-11-04 活体实测：焦点行有它、其余行没有）——它是屏上唯一能读出焦点的证据。 */
function stripFrame(line: string): { text: string; focused: boolean } {
  let s = line.replace(/^\s*[│|]\s?/, '');
  let focused = false;
  const m = /^\s*❯\s?/.exec(s);
  if (m) {
    focused = true;
    s = s.slice(m[0].length);
  }
  return { text: s.replace(/\s*[│|]\s*$/, '').trim(), focused };
}

function isCurrentRow(line: string): boolean {
  return line === '(current)';
}

function isPreviousSessionRow(line: string): boolean {
  return /^\/resume \S* ?\(previous session\)$/.test(line);
}

/** 解析列表屏当前一屏；不是列表屏 → null。 */
export function parseRewindList(screen: string): RewindPickerView | null {
  // 确认屏的头也含 `point before`，不先排掉会把选项行当成条目
  if (isRewindConfirm(screen)) return null;
  const lines = screen.split('\n').map((l) => l.replace(/\s+$/, ''));
  const head = lines.findIndex((l) => LIST_HEADER.test(l));
  if (head < 0) return null;
  const items: RewindPickerItem[] = [];
  let moreAbove = 0;
  let moreBelow = 0;
  for (let i = head + 1; i < lines.length; i++) {
    const { text: line, focused } = stripFrame(lines[i]!);
    if (!line) continue;
    const more = MORE_LINE.exec(line);
    if (more) {
      // 第一个溢出行在条目之前 = 上方被裁掉；之后 = 下方
      if (items.length === 0 && moreBelow === 0 && moreAbove === 0) moreAbove = Number(more[1]);
      else moreBelow = Number(more[1]);
      continue;
    }
    if (STOP_LINE.test(line)) break;
    // 元数据行只出现在某条消息之后（首条位置上的「+35 结尾」是用户原文）
    if (items.length > 0 && META_LINE.test(line)) continue;
    const text = isCurrentRow(line) || isPreviousSessionRow(line) ? null : line;
    items.push({ index: moreAbove + items.length, text, focused });
  }
  if (items.length === 0) return null;
  return { items, moreAbove, moreBelow };
}

/** 屏上是不是确认屏（`The conversation will be…` 描述行只在确认屏出现）。 */
export function isRewindConfirm(screen: string): boolean {
  return /The conversation will be (?:forked|unchanged)\./.test(screen)
    || /The code will be (?:unchanged|restored|has not changed)/.test(screen);
}

/** 确认屏的编号选项行（`❯ 1. Restore conversation`）；引用块里的正文（`│ …`）不算。 */
const OPTION_LINE = /^(❯)?\s*(\d+)\.\s+(.+?)\s*$/;
const CANCEL_LABEL = /^never mind$/i;

/**
 * 确认屏的选项表（宿主真实渲染的那份——同一会话不同消息能退的东西不一样，
 * 故档位**只能从屏上读**，不许自己编）。不是确认屏 → null。
 */
export function parseRewindOptions(screen: string): RewindPickerOption[] | null {
  if (!isRewindConfirm(screen)) return null;
  const out: RewindPickerOption[] = [];
  for (const raw of screen.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('│') || line.startsWith('|')) continue;
    const m = OPTION_LINE.exec(line);
    if (!m) continue;
    const label = m[3]!.trim();
    out.push({ label, selected: m[1] === '❯', cancel: CANCEL_LABEL.test(label) });
  }
  return out.length > 0 ? out : null;
}

/** 确认屏里被选中的那条消息原文（核对落点用；取引用块里的第一行）。 */
export function rewindConfirmPrompt(screen: string): string | null {
  const lines = screen.split('\n').map((l) => l.replace(/\s+$/, ''));
  const head = lines.findIndex((l) => /you sent this message/.test(l));
  if (head < 0) return null;
  for (let i = head + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    const m = /^[│|]\s?(.*)$/.exec(raw.trim());
    if (m) return m[1]!.trim();
    if (raw.trim() && !/^[│|]/.test(raw.trim())) break;
  }
  return null;
}

/**
 * 输入框里还没发出去的内容：输入行是**最下面那条**以 `❯` 开头的行（上面的 `❯ …`
 * 是转录里的用户气泡，别拿错）。空框 → `''`。
 */
export function pendingInputOf(screen: string): string | null {
  const lines = screen.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^❯\s?(.*)$/.exec(lines[i]!.replace(/\s+$/, ''));
    if (m) return m[1]!.trim();
  }
  return null;
}

/** 回合在跑的屏上证据（与中断梯子同一判据）：此刻敲 `/rewind` 会被当普通消息排队。 */
export function rewindBusyOf(screen: string): boolean {
  return /esc\s+to\s+interrupt/i.test(screen);
}

/** 面板开着但一条可回退的都没有（回退会 fork 对话，退过一次的历史可能就没得退了）。 */
export function rewindEmptyOf(screen: string): boolean {
  return /Nothing to rewind to yet/i.test(screen);
}

export const CLAUDE_REWIND_PICKER: RewindPickerSpec = {
  openCommand: '/rewind',
  listHeader: LIST_HEADER,
  parseList: parseRewindList,
  parseConfirm: parseRewindOptions,
  confirmPrompt: rewindConfirmPrompt,
  pendingInputOf,
  busyOf: rewindBusyOf,
  emptyOf: rewindEmptyOf,
  // 0x15 = Ctrl+U（活体实测：清空输入行；Kitty 协议下裸控制字节照收）
  keys: { up: '\x1b[A', down: '\x1b[B', accept: '\r', cancel: '\x1b[27u', clearInput: '\x15' },
};
