import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { api } from '@/lib/api';
import type { HarnessCommandRow } from '@/lib/api';
import type { PickItem, PickTarget } from './FilePicker';
import {
  applyDraftSnapshot,
  buildSegments,
  cmdChipClass,
  hasRefCandidate,
  pickerIntent,
  readDraftSnapshot,
  serializeDraft,
  textBeforeCaret,
  writeDraftSnapshot,
  draftSnapshotOf,
  CMD_ATTR,
  CMD_SIG_ATTR,
  CMD_SRC_ATTR,
  REF_ATTR,
  REF_KIND_ATTR,
  REF_LINES_ATTR,
  REF_PATH_ATTR,
  REF_CHIP_CLASS,
  type CmdSigil,
  type CmdSource,
} from './draft-editor';
import { settledUploads, type StagedFile } from './attach';

/** 草稿写盘的抖动量：逐键写 sessionStorage 没必要，停手一小拍再写。 */
const DRAFT_SAVE_MS = 250;

/** `nodeType` 的取值写死成字面量：测试环境是 node（没有 `Node` 全局），
 *  而这些数与 DOM 规范同寿，不会变。 */
const TEXT_NODE = 3;

/**
 * 草稿编辑器域：contenteditable composer 的全部 DOM 手术（光标/插入/胶囊/命令菜单/
 * 引用选择器接线）与草稿持久化（刷新还原 + 抖动写盘）。真源是 DOM，`draft` 只是
 * 给按钮置灰/占位/关闭确认读的镜像。
 */
export function useDraftEditor(deps: {
  sessionId: string;
  /** `/` 菜单候选（能力面下发；null = 还没取到）。 */
  commands: HarnessCommandRow[] | null;
  /** 触发符 + 名字 → 候选（主组件持有：事件链组头同款判据）。 */
  commandInfoOf: (sigil: CmdSigil, name: string) =>
    { source: HarnessCommandRow['source']; sigil: CmdSigil } | undefined;
  /** 附件暂存（草稿快照的 staged 半份；上传中不进快照）。 */
  staged: StagedFile[];
  setStaged: Dispatch<SetStateAction<StagedFile[]>>;
  /** 引用选择器开着（`chip` 非空 = 在改那枚胶囊）。 */
  picker: { chip: HTMLElement | null; initial?: PickTarget } | null;
  setPicker: (p: { chip: HTMLElement | null; initial?: PickTarget } | null) => void;
}) {
  const { sessionId, commands, commandInfoOf, staged, setStaged, picker, setPicker } = deps;
  /** 输入框的**镜像**（真源是 contenteditable 的 DOM）：只给按钮置灰、占位、关闭
   *  确认这几处读；发出去的内容恒从 DOM 序列化，不信这份。 */
  const [draft, setDraft] = useState('');
  /** `/` 命令菜单：`query` 是已经敲进去的那截命令名，`active` 是键盘高亮项。 */
  const [cmdMenu, setCmdMenu] = useState<{ sigil: CmdSigil; query: string; active: number } | null>(null);
  /** `@` 触发时那枚 `@` 被删掉了，记下它的位置：取消就补回去，落定就地插胶囊。 */
  const atRange = useRef<Range | null>(null);
  /** composer 用 contenteditable 而不是 textarea：内联引用胶囊要成原子块
   *  （`contenteditable=false` 的 span 里退格整枚删、光标进不去）。 */
  const draftRef = useRef<HTMLDivElement>(null);

const caretInDraft = (el: HTMLDivElement): Range | null => {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return el.contains(range.commonAncestorContainer) ? range : null;
};

/** 在光标处插节点；框里没有有效选区就追加到末尾。光标落在插入内容之后，
 *  并滚进视野（插入的行可能落在框外）。 */
const insertNodes = (nodes: Node[]): void => {
  const el = draftRef.current;
  if (!el) return;
  el.focus({ preventScroll: true });
  // 选择器开着时焦点不在框里，浏览器那份选区已经没了；`@` 触发的那次要回到
  // 那枚 `@` 的位置，而不是末尾（focus 之后才设，否则会被 focus 抢走）。
  const saved = atRange.current;
  atRange.current = null;
  // 等落定的这段时间里那截文字可能已经被删掉（粘贴要先问一趟服务端）：
  // 挂一个游离节点的 Range 会抛，退回末尾追加
  if (saved && el.contains(saved.startContainer)) {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(saved);
  }
  const range = caretInDraft(el);
  if (range) {
    range.deleteContents();
    const frag = document.createDocumentFragment();
    nodes.forEach((n) => frag.appendChild(n));
    const tail = nodes[nodes.length - 1] ?? null;
    range.insertNode(frag);
    if (tail) {
      const after = document.createRange();
      after.setStartAfter(tail);
      after.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(after);
    }
  } else {
    // 追加到末尾：手上那截若不是空白结尾，先补一个空格——否则胶囊会粘在字上
    const last = el.lastChild;
    const tail = last?.nodeType === TEXT_NODE ? (last.nodeValue ?? '') : '';
    if (tail && !/\s$/.test(tail)) el.appendChild(document.createTextNode(' '));
    nodes.forEach((n) => el.appendChild(n));
  }
  setDraft(serializeDraft(el));
};

/** 插纯文本（换行钮 / 粘贴 / 出队回填）。走 `execCommand` 是为了留在浏览器的
 *  撤销栈里；不支持就退回手插节点（那条路没有撤销，但不至于插不进去）。 */
const insertText = (text: string): void => {
  const el = draftRef.current;
  if (!el) return;
  el.focus({ preventScroll: true });
  if (!caretInDraft(el)) {
    // 没选区时 execCommand 会落在一个不可预期的位置，直接追加更可控
    insertNodes([document.createTextNode(text)]);
    return;
  }
  let ok = false;
  try {
    ok = document.execCommand('insertText', false, text);
  } catch {
    ok = false;
  }
  if (!ok) insertNodes([document.createTextNode(text)]);
  else setDraft(serializeDraft(el));
};

/** 换行（移动端那枚按钮）：移动端没有 Shift+Enter 这个手势。 */
const insertNewline = (): void => insertText('\n');

/** 造一枚胶囊：正文 = 服务端算好的表达式，另存路径/类型/行区间供再次编辑。 */
const buildChip = (ref: string, target: PickTarget): HTMLElement => {
  const chip = document.createElement('span');
  chip.setAttribute('contenteditable', 'false');
  chip.setAttribute(REF_ATTR, ref);
  chip.setAttribute(REF_PATH_ATTR, target.path);
  chip.setAttribute(REF_KIND_ATTR, target.kind);
  if (target.lines) chip.setAttribute(REF_LINES_ATTR, `${target.lines.start}-${target.lines.end}`);
  chip.className = REF_CHIP_CLASS;
  chip.textContent = ref;
  chip.title = ref; // 长路径被截断时，悬停还看得见全文
  return chip;
};

/** 造一枚命令胶囊：值 = 命令名（不含 `/`），发出去时还原成 `/name`。
 *  颜色按来源（skill/插件红、官方命令黄）；草稿快照里带着来源就用它，
 *  否则按当下取到的候选表查。 */
const buildCmdChip = (name: string, source?: CmdSource, sigil?: CmdSigil): HTMLElement => {
  const sig = sigil ?? '/';
  const src = source ?? commandInfoOf(sig, name)?.source;
  const chip = document.createElement('span');
  chip.setAttribute('contenteditable', 'false');
  chip.setAttribute(CMD_ATTR, name);
  if (src) chip.setAttribute(CMD_SRC_ATTR, src);
  if (sig !== '/') chip.setAttribute(CMD_SIG_ATTR, sig);
  chip.className = cmdChipClass(src);
  chip.textContent = `${sig}${name}`;
  return chip;
};

/** 光标前是不是正在敲一条命令（空白后的 `/word` 或 `$word`）：是就把触发符
 *  与已敲的名字片段交出来。`/` 在句首才是官方命令，但 skill 句中也能用，
 *  故两种触发符都按「空白后」认。 */
const commandQueryAt = (el: HTMLDivElement): { sigil: CmdSigil; query: string } | null => {
  const range = caretInDraft(el);
  if (!range) return null;
  const m = /(?:^|\s)([/$])([A-Za-z0-9:_-]*)$/.exec(textBeforeCaret(el, range));
  return m ? { sigil: m[1] as CmdSigil, query: m[2]! } : null;
};

/** 敲字时同步命令菜单：不再是命令词就收起（发送/点走/删光都走这一处）。 */
const syncCmdMenu = (el: HTMLDivElement): void => {
  const hit = commandQueryAt(el);
  if (!hit || !commands || commands.length === 0) {
    if (cmdMenu) setCmdMenu(null);
    return;
  }
  const known = commands.some((c) => (c.sigil ?? '/') === hit.sigil);
  if (!known) {
    if (cmdMenu) setCmdMenu(null);
    return;
  }
  setCmdMenu({ sigil: hit.sigil, query: hit.query, active: 0 });
};

/** 落定一条命令：把已敲的 `/query` 换成胶囊（颜色随来源），光标停在它后面一格
 *  （参数接着敲就行）。 */
const insertCommand = (name: string, sigil: CmdSigil): void => {
  const el = draftRef.current;
  if (!el) return;
  const range = caretInDraft(el);
  setCmdMenu(null);
  if (!range) return;
  const hit = commandQueryAt(el);
  const node = range.startContainer;
  if (!hit || node.nodeType !== TEXT_NODE) return;
  const start = range.startOffset - (hit.query.length + 1);
  if (start < 0) return;
  const r = document.createRange();
  r.setStart(node, start);
  r.setEnd(node, range.startOffset);
  r.deleteContents();
  const chip = buildCmdChip(name, undefined, sigil);
  r.insertNode(chip);
  const space = document.createTextNode(' ');
  chip.after(space);
  const after = document.createRange();
  after.setStart(space, 1);
  after.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(after);
  el.focus({ preventScroll: true });
  setDraft(serializeDraft(el));
};

/** 菜单里的候选：前缀命中的排前面，其余按包含排后面（都按大小写不敏感比）。 */
const cmdMatches = useMemo(() => {
  if (!cmdMenu || !commands) return [];
  const q = cmdMenu.query.toLowerCase();
  const same = commands.filter((c) => (c.sigil ?? '/') === cmdMenu.sigil);
  const prefix = same.filter((c) => c.name.toLowerCase().startsWith(q));
  const rest = same.filter(
    (c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q),
  );
  return [...prefix, ...rest].slice(0, 40);
}, [cmdMenu, commands]);

/** 刷新后把没发出去的草稿还回来（每个会话只还一次；键按会话分，多扇对话互不覆盖）。 */
const draftRestored = useRef<string | null>(null);
useEffect(() => {
  if (draftRestored.current === sessionId) return;
  draftRestored.current = sessionId;
  const el = draftRef.current;
  const snap = readDraftSnapshot(sessionId);
  if (!el || !snap) return;
  applyDraftSnapshot(el, snap, buildChip, buildCmdChip);
  setDraft(serializeDraft(el));
  if (snap.staged.length > 0)
    setStaged(
      snap.staged.map((u) => ({
        key: `d:${u.id}`,
        name: u.name,
        mediaType: u.mediaType,
        size: u.size ?? 0,
        progress: 1,
        state: 'done' as const,
        upload: u,
      })),
    );
  // buildChip 每次渲染都是新函数，不进门依赖（restored 闸已保证只跑一次）
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [sessionId]);

/** 草稿落 sessionStorage：输入/插图后延一小拍写成（逐键写盘没必要）。发送清空即删键。 */
useEffect(() => {
  const timer = window.setTimeout(() => {
    writeDraftSnapshot(sessionId, draftSnapshotOf(draftRef.current, settledUploads(staged)));
  }, DRAFT_SAVE_MS);
  return () => window.clearTimeout(timer);
}, [draft, staged, sessionId]);

/** 落定一批引用：在改既有胶囊就就地换掉（位置不动、只换一枚），否则在光标处
 *  依次插入。**引用前后必须是空白**（服务端认引用的判据）——紧贴字就补一个
 *  空格，本来就空着的不重复补（`atRange` 留给 `insertNodes` 消费：那才是
 *  「唤出选择器时那枚 `@` 的位置」，不是末尾）。 */
const insertRefs = (items: PickItem[]): void => {
  const head = items[0];
  if (!head) return;
  const editing = picker?.chip ?? null;
  setPicker(null);
  if (editing) {
    editing.replaceWith(buildChip(head.ref, head.target));
    setDraft(serializeDraft(draftRef.current));
    return;
  }
  let lead = false;
  let trail = true;
  const saved = atRange.current;
  if (saved?.startContainer.nodeType === TEXT_NODE) {
    const value = saved.startContainer.nodeValue ?? '';
    const at = saved.startOffset;
    lead = at > 0 && !/\s/.test(value[at - 1] ?? '');
    if (at < value.length) trail = !/\s/.test(value[at] ?? '');
  }
  const nodes: Node[] = [];
  if (lead) nodes.push(document.createTextNode(' '));
  items.forEach((it, i) => {
    nodes.push(buildChip(it.ref, it.target));
    if (i < items.length - 1 || trail) nodes.push(document.createTextNode(' '));
  });
  insertNodes(nodes);
};

/** 粘贴回填：先把这段文本交给服务端认引用（文法归 harness、存在性归索引），
 *  认到的片段落成胶囊、其余照原文插入。认不出或这趟挂了就整段当纯文本——
 *  粘贴不能因为一个可选的服务而丢字。 */
const insertRichText = (text: string): void => {
  const el = draftRef.current;
  if (!el) return;
  const range = caretInDraft(el);
  atRange.current = range ? range.cloneRange() : null;
  const plain = (): void => insertNodes([document.createTextNode(text)]);
  // 快路：整段没有一个「行首/空白后的 @」，就不可能含引用表达式——直接插，
  // 不等那一趟服务端认引用（粘贴卡顿的主因：纯文本也要等网络来回才落字）
  if (!hasRefCandidate(text)) {
    plain();
    return;
  }
  api.recognizeRefs(sessionId, text).then((refs) => {
    insertNodes(
      buildSegments(text, refs).flatMap((seg): Node[] =>
        seg.kind === 'text'
          ? [document.createTextNode(seg.text)]
          : [buildChip(seg.item.ref, seg.item.target)],
      ),
    );
  }, plain);
};

/** 关掉选择器：**不动正文**，只把光标放回唤出它的那枚 `@` 原来的位置（那枚 `@`
 *  已经是选择器自己的记账，不补回去——「点蒙版收起」不该是一次改写输入框的动作，
 *  想打字面 `@` 用 `\@`）。 */
const closePicker = (): void => {
  setPicker(null);
  const saved = atRange.current;
  atRange.current = null;
  if (!saved) return;
  draftRef.current?.focus({ preventScroll: true });
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(saved);
};

/** 点胶囊 = 改这条引用：带上它的路径与行区间重开选择器。 */
const openChip = (chip: HTMLElement): void => {
  const path = chip.getAttribute(REF_PATH_ATTR);
  const kind = chip.getAttribute(REF_KIND_ATTR);
  if (!path || (kind !== 'file' && kind !== 'dir')) return;
  const m = /^(\d+)-(\d+)$/.exec(chip.getAttribute(REF_LINES_ATTR) ?? '');
  setPicker({
    chip,
    initial: m
      ? { path, kind, lines: { start: Number(m[1]), end: Number(m[2]) } }
      : { path, kind },
  });
};

/** `\@` 是转义：吃掉反斜杠、留下字面 `@`、不弹选择器。 */
const escapeAt = (el: HTMLDivElement): void => {
  const sel = window.getSelection();
  const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
  const node = range?.startContainer;
  const off = range?.startOffset ?? 0;
  if (node && node.nodeType === TEXT_NODE && off >= 2) {
    const value = node.nodeValue ?? '';
    if (value[off - 1] === '@' && value[off - 2] === '\\') {
      node.nodeValue = `${value.slice(0, off - 2)}@${value.slice(off)}`;
      const after = document.createRange();
      after.setStart(node, off - 1);
      after.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(after);
    }
  }
  setDraft(serializeDraft(el));
};

/** 敲 `@` 直接唤出选择器（`\@` 除外）。返回 true = 这次输入已被接管。 */
const maybeOpenPicker = (el: HTMLDivElement, native: InputEvent): boolean => {
  // 只认真的敲进来一个半角 `@`：IME 组字、粘贴、替换都不算
  if (native.inputType !== 'insertText' || native.data !== '@') return false;
  const range = caretInDraft(el);
  if (!range) return false;
  // 光标之前那截文字（含刚敲进来的 `@`）。胶囊按词边界算，`@` 紧跟胶囊之后
  // 照样弹；粘在 `foo` 后面（邮箱）不弹；`\@` 是转义，只吃反斜杠不弹框。
  const intent = pickerIntent(textBeforeCaret(el, range));
  if (intent === 'ignore') return false;
  if (intent === 'escape') {
    escapeAt(el);
    return true;
  }

  document.execCommand('delete'); // 收掉这枚 `@`：胶囊自己带
  const caret = window.getSelection();
  atRange.current = caret?.rangeCount ? caret.getRangeAt(0).cloneRange() : null;
  setDraft(serializeDraft(el));
  setPicker({ chip: null });
  return true;
};

/** 整段写回（出队编辑 / 发走清空）：DOM 与镜像一起换。胶囊在这里退化回
 *  表达式原文——那是它本来就等于的东西，再拼回去也不能保证还是同一枚。 */
const setDraftText = (text: string): void => {
  const el = draftRef.current;
  if (el) el.textContent = text;
  setDraft(text);
};
  return {
    draft, setDraft,
    draftRef, atRange,
    cmdMenu, setCmdMenu,
    caretInDraft, insertNodes, insertText, insertNewline,
    buildChip, buildCmdChip,
    syncCmdMenu, insertCommand, cmdMatches,
    insertRefs, insertRichText,
    closePicker, openChip, escapeAt, maybeOpenPicker,
    setDraftText,
  };
}
