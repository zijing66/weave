import { useEffect, useMemo, useRef, useState, type Dispatch, type DragEvent as ReactDragEvent, type SetStateAction } from 'react';
import { api, API_BASE } from '@/lib/api';
import type { HarnessCommandRow, UploadFile } from '@/lib/api';
import type { PickItem, PickTarget } from './FilePicker';
import {
  applyDraftSnapshot,
  buildSegments,
  cmdChipClass,
  cmdMenuMatches,
  cmdMenuShouldOpen,
  cmdQueryIn,
  hasRefCandidate,
  pickerIntent,
  readDraftSnapshot,
  serializeDraft,
  textBeforeCaret,
  writeDraftSnapshot,
  draftSnapshotOf,
  ATTACH_ATTR,
  ATTACH_MEDIA_ATTR,
  ATTACH_NAME_ATTR,
  ATTACH_PATH_ATTR,
  CMD_ATTR,
  CMD_SIG_ATTR,
  CMD_SRC_ATTR,
  REF_ATTR,
  REF_KIND_ATTR,
  REF_LINES_ATTR,
  REF_PATH_ATTR,
  REF_CHIP_CLASS,
  ATTACH_CHIP_CLASS,
  SESSION_ATTR,
  SESSION_NAME_ATTR,
  SESSION_CHIP_CLASS,
  sessionPickerIntent,
  type CmdQueryHit,
  type CmdSigil,
  type CmdSource,
} from './draft-editor';
import { isImageUpload, settledUploads, type StagedFile } from './attach';

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
  /** `/` 命令菜单：`query` 是已经敲进去的那截命令名，`head` = 触发位在整条输入
   *  开头（决定候选池），`active` 是键盘高亮项。 */
  const [cmdMenu, setCmdMenu] = useState<{ sigil: CmdSigil; query: string; head: boolean; active: number } | null>(null);
  /** `#` 会话选择器开着（引用目标会话的挑选）。 */
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  /** `@` 触发时那枚 `@` 被删掉了，记下它的位置：取消就补回去，落定就地插胶囊。 */
  const atRange = useRef<Range | null>(null);
  /** `#` 触发时那枚 `#` 同样被删掉了：取消（Escape/蒙版）补回去——markdown 标题
   *  （行首 `# `）撞的就是这枚键，不补回去标题就丢字了。 */
  const hashRange = useRef<Range | null>(null);
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
  // 选择器开着时焦点不在框里，浏览器那份选区已经没了；`@` / `#` 触发的那次要
  // 回到那枚触发符的位置，而不是末尾（focus 之后才设，否则会被 focus 抢走）。
  const saved = atRange.current ?? hashRange.current;
  atRange.current = null;
  hashRange.current = null;
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

/** 插纯文本（Enter 换行 / 移动端换行钮 / 关选择器补 `#`）。走
 *  `execCommand('insertText')` 是为了留在浏览器的撤销栈里；不支持就退回手插
 *  节点（那条路没有撤销，但不至于插不进去）。**这条路的撤销语义是「并入打字
 *  组」**——单字符插入与前后打字同组撤销正合直觉，且换行后光标正确落在新行
 *  （insertHTML 插 `\n` 会把光标留在换行之前）；粘贴不能走它（见 insertPasted）。 */
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

/** 插一段**粘贴来的**文本：必须走 `execCommand('insertHTML')`——`insertText`
 *  会把插入并进「打字」撤销组，Ctrl+Z 一口气把粘贴连同之前的打字全撤掉；
 *  `insertHTML` 是独立撤销步，与原生粘贴一致（2026-10-31 Chromium 实测）。
 *  文本经 createTextNode 转义成 HTML，换行保持字面 `\n`（pre-wrap 下照常
 *  渲染、序列化单换行；换成 `<br>` 反倒在文本交界被 Chromium 塞进额外的
 *  `\n` 变双倍换行）。不支持时退回手插节点（那条路没有撤销，但不至于插不进）。 */
const insertPasted = (text: string): void => {
  const el = draftRef.current;
  if (!el) return;
  el.focus({ preventScroll: true });
  if (!caretInDraft(el)) {
    insertNodes([document.createTextNode(text)]);
    return;
  }
  const wrapper = document.createElement('div');
  wrapper.appendChild(document.createTextNode(text));
  let ok = false;
  try {
    ok = document.execCommand('insertHTML', false, wrapper.innerHTML);
  } catch {
    ok = false;
  }
  if (!ok) insertNodes([document.createTextNode(text)]);
  else setDraft(serializeDraft(el));
};

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

/** 造一枚会话目标胶囊：值 = 目标会话 id，展示 = 会话名。发送时序列化展开成
 *  `#<名>` 收件人标注（发送仍是本会话的 prompt，模型自己转发）。 */
const buildSessionChip = (sessionId: string, name: string): HTMLElement => {
  const chip = document.createElement('span');
  chip.setAttribute('contenteditable', 'false');
  chip.setAttribute(SESSION_ATTR, sessionId);
  chip.setAttribute(SESSION_NAME_ATTR, name);
  chip.className = SESSION_CHIP_CLASS;
  chip.textContent = `#${name}`;
  chip.title = name; // 长名被截断时，悬停还看得见全文
  return chip;
};

/** 落定引用目标：**单目标**——先摘掉既有目标胶囊再在 `#` 的位置插新的一枚。
 *  光标停在胶囊后面一格（正文接着敲就行）。 */
const insertSessionTarget = (sessionId: string, name: string): void => {
  const el = draftRef.current;
  if (!el) return;
  hashRange.current = null;
  el.querySelector(`[${SESSION_ATTR}]`)?.remove();
  insertNodes([buildSessionChip(sessionId, name), document.createTextNode(' ')]);
};

/** 附件占位胶囊：图 = 微缩略图 + 截短名，文件 = 图标 + 截短名。
 *  序列化语义归 draft-editor（文件 → 落盘路径、图片 → 空串），这里只管长相。
 *  入参加快照 part 形状（a/p/n/m）：applyDraftSnapshot 还原与 insertAttach 新建
 *  走同一个构造器，不备两份。拖动载荷由容器级 `onChipDragStart` 委托（execCommand
 *  插回来的节点绑不上监听器，委托对两条来路都生效）。 */
const buildAttachChip = (part: { a: string; p: string; n: string; m: string }): HTMLElement => {
  const chip = document.createElement('span');
  chip.setAttribute('contenteditable', 'false');
  chip.setAttribute(ATTACH_ATTR, part.a);
  chip.setAttribute(ATTACH_NAME_ATTR, part.n);
  chip.setAttribute(ATTACH_PATH_ATTR, part.p);
  chip.setAttribute(ATTACH_MEDIA_ATTR, part.m);
  chip.className = ATTACH_CHIP_CLASS;
  chip.title = part.n; // 长名被截短时，悬停还看得见全文
  chip.draggable = true; // 拖动调位置（载荷 = 附件 id，drop 时按它找到这枚）
  if (isImageUpload({ mediaType: part.m })) {
    const img = document.createElement('img');
    img.src = `${API_BASE}/images/${part.a}`;
    img.alt = part.n;
    img.className = 'h-4 w-4 rounded-sm object-cover';
    chip.appendChild(img);
  } else {
    const icon = document.createElement('span');
    icon.className = 'font-mono text-9 leading-none';
    icon.textContent = '⌘';
    chip.appendChild(icon);
  }
  const label = document.createElement('span');
  label.className = 'min-w-0 truncate';
  label.textContent = part.n.length > 12 ? `${part.n.slice(0, 11)}…` : part.n;
  chip.appendChild(label);
  return chip;
};

/** 在光标处摆一枚附件占位胶囊；框里没有可落的光标（从未聚焦 / 选区在别处）就
 *  贴在最后方。**文件胶囊前后必须是空白**（与引用胶囊同一判据：序列化出来的是
 *  一条路径，粘着字就成了另一段文字）；图片胶囊序列化时自己补行边界（独立成行
 *  是宿主认图的前提），前后不补空格。插入走 `execCommand('insertHTML')`——
 *  粘贴文件后的自动摆入必须留在浏览器撤销栈里，Ctrl+Z 才能整步撤掉（手插节点
 *  那条路没有撤销，undo 会跳过粘贴直接撤更早的打字）；不支持时退回手插。 */
const insertAttach = (upload: UploadFile): void => {
  const el = draftRef.current;
  if (!el) return;
  const chip = buildAttachChip({ a: upload.id, p: upload.path ?? '', n: upload.name, m: upload.mediaType });
  if (caretInDraft(el) == null && atRange.current == null) {
    // 末尾追加：收尾若是非空白文本或胶囊，先补一个空格——否则路径粘在字上
    // （两枚文件胶囊背靠背时路径会连成一串）；BR 收尾 = 已是新行，不用补
    const last = el.lastChild;
    const glued =
      last != null &&
      (last.nodeType === TEXT_NODE
        ? !/\s$/.test(last.nodeValue ?? '')
        : (last as HTMLElement).tagName !== 'BR');
    if (glued) el.appendChild(document.createTextNode(' '));
    el.appendChild(chip);
    setDraft(serializeDraft(el));
    return;
  }
  const pad = !isImageUpload(upload);
  let lead = false;
  let trail = false;
  const range = caretInDraft(el);
  if (range?.startContainer.nodeType === TEXT_NODE) {
    const value = range.startContainer.nodeValue ?? '';
    const at = range.startOffset;
    lead = at > 0 && !/\s/.test(value[at - 1] ?? '');
    trail = at < value.length && !/\s/.test(value[at] ?? '');
  }
  const wrapper = document.createElement('div');
  if (pad && lead) wrapper.appendChild(document.createTextNode(' '));
  wrapper.appendChild(chip);
  if (pad && trail) wrapper.appendChild(document.createTextNode(' '));
  // execCommand 落在当前选区（insertNodes 同款：先恢复 saved 选区）；wrapper 的
  // 孩子逐个插，HTML 外壳不进 DOM
  const saved = atRange.current;
  atRange.current = null;
  if (saved && el.contains(saved.startContainer)) {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(saved);
  } else {
    el.focus({ preventScroll: true });
  }
  let ok = false;
  try {
    ok = document.execCommand('insertHTML', false, wrapper.innerHTML);
  } catch {
    ok = false;
  }
  if (ok) {
    setDraft(serializeDraft(el));
    return;
  }
  insertNodes(Array.from(wrapper.childNodes));
};

/** 光标前是不是正在敲一条命令（空白后的 `/word` 或 `$word`）：是就把触发符、
 *  已敲的名字片段与「是否整条输入开头」交出来。文法归 draft-editor 的纯函数
 *  （与宿主分派判据同源），这里只做 DOM 取料。 */
const commandQueryAt = (el: HTMLDivElement): CmdQueryHit | null => {
  const range = caretInDraft(el);
  if (!range) return null;
  return cmdQueryIn(textBeforeCaret(el, range));
};

/** 敲字时同步命令菜单：不再是命令词、或这个位置宿主根本不认（句中敲 `/` 而该
 *  触发符下没有 inline 候选）就收起（发送/点走/删光都走这一处）。 */
const syncCmdMenu = (el: HTMLDivElement): void => {
  const hit = commandQueryAt(el);
  if (
    !hit ||
    !commands ||
    commands.length === 0 ||
    !cmdMenuShouldOpen(commands, hit.sigil, hit.head)
  ) {
    if (cmdMenu) setCmdMenu(null);
    return;
  }
  setCmdMenu({ sigil: hit.sigil, query: hit.query, head: hit.head, active: 0 });
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

/** 菜单里的候选：位置先筛（句中只摆宿主认 mention 的），再前缀命中的排前面、
 *  其余按包含排后面（都按大小写不敏感比）。 */
const cmdMatches = useMemo(() => {
  if (!cmdMenu || !commands) return [];
  return cmdMenuMatches(commands, cmdMenu.sigil, cmdMenu.query, cmdMenu.head);
}, [cmdMenu, commands]);

/** 刷新后把没发出去的草稿还回来（每个会话只还一次；键按会话分，多扇对话互不覆盖）。 */
const draftRestored = useRef<string | null>(null);
useEffect(() => {
  if (draftRestored.current === sessionId) return;
  draftRestored.current = sessionId;
  const el = draftRef.current;
  const snap = readDraftSnapshot(sessionId);
  if (!el || !snap) return;
  applyDraftSnapshot(el, snap, buildChip, buildCmdChip, buildAttachChip, buildSessionChip);
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
 *  粘贴不能因为一个可选的服务而丢字。两条路都走 `execCommand('insertHTML')`
 *  （独立撤销步，Ctrl+Z 撤粘贴靠它；手插节点不进撤销栈，undo 会跳过粘贴）：
 *  纯文本走 `insertPasted`，胶囊混合体把节点摊平成 HTML 一次插入。 */
const insertRichText = (text: string): void => {
  const el = draftRef.current;
  if (!el) return;
  const range = caretInDraft(el);
  atRange.current = range ? range.cloneRange() : null;
  const plain = (): void => insertPasted(text);
  // 快路：整段没有一个「行首/空白后的 @」，就不可能含引用表达式——直接插，
  // 不等那一趟服务端认引用（粘贴卡顿的主因：纯文本也要等网络来回才落字）
  if (!hasRefCandidate(text)) {
    plain();
    return;
  }
  api.recognizeRefs(sessionId, text).then((refs) => {
    const nodes = buildSegments(text, refs).flatMap((seg): Node[] =>
      seg.kind === 'text'
        ? [document.createTextNode(seg.text)]
        : [buildChip(seg.item.ref, seg.item.target)],
    );
    // 摊平成 HTML 走 insertHTML（独立撤销步）；wrapper 的孩子逐个搬，外壳不进 DOM
    const wrapper = document.createElement('div');
    nodes.forEach((n) => wrapper.appendChild(n));
    el.focus({ preventScroll: true });
    const saved = atRange.current;
    atRange.current = null;
    if (saved && el.contains(saved.startContainer)) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(saved);
    }
    if (!caretInDraft(el)) {
      insertNodes(nodes);
      return;
    }
    let ok = false;
    try {
      ok = document.execCommand('insertHTML', false, wrapper.innerHTML);
    } catch {
      ok = false;
    }
    if (!ok) insertNodes(nodes);
    else setDraft(serializeDraft(el));
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

/** 敲 `#` 唤出会话选择器（`\#` 除外；判据见 sessionPickerIntent）。返回 true =
 *  这次输入已被接管。 */
const maybeOpenSessionPicker = (el: HTMLDivElement, native: InputEvent): boolean => {
  // 只认真的敲进来一个半角 `#`：IME 组字、粘贴、替换都不算
  if (native.inputType !== 'insertText' || native.data !== '#') return false;
  const range = caretInDraft(el);
  if (!range) return false;
  const intent = sessionPickerIntent(textBeforeCaret(el, range));
  if (intent === 'ignore') return false;
  if (intent === 'escape') {
    escapeHash(el);
    return true;
  }

  document.execCommand('delete'); // 收掉这枚 `#`：胶囊自己带
  const caret = window.getSelection();
  hashRange.current = caret?.rangeCount ? caret.getRangeAt(0).cloneRange() : null;
  setDraft(serializeDraft(el));
  setSessionPickerOpen(true);
  return true;
};

/** 关掉会话选择器：把那枚 `#` 补回原位（markdown 标题撞的就是这枚键，不补回去
 *  标题就丢字了——想引用会话就选中一个目标，而不是关掉它）。 */
const closeSessionPicker = (): void => {
  setSessionPickerOpen(false);
  const saved = hashRange.current;
  hashRange.current = null;
  const el = draftRef.current;
  if (!el) return;
  el.focus({ preventScroll: true });
  if (!saved) return;
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(saved);
  insertText('#');
};

/** `\#` 是转义：吃掉反斜杠、留下字面 `#`、不弹选择器。 */
const escapeHash = (el: HTMLDivElement): void => {
  const sel = window.getSelection();
  const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
  const node = range?.startContainer;
  const off = range?.startOffset ?? 0;
  if (node && node.nodeType === TEXT_NODE && off >= 2) {
    const value = node.nodeValue ?? '';
    if (value[off - 1] === '#' && value[off - 2] === '\\') {
      node.nodeValue = `${value.slice(0, off - 2)}#${value.slice(off)}`;
      const after = document.createRange();
      after.setStart(node, off - 1);
      after.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(after);
    }
  }
  setDraft(serializeDraft(el));
};

/** 整段写回（出队编辑 / 发走清空）：DOM 与镜像一起换。胶囊在这里退化回
 *  表达式原文——那是它本来就等于的东西，再拼回去也不能保证还是同一枚。 */
const setDraftText = (text: string): void => {
  const el = draftRef.current;
  if (el) el.textContent = text;
  setDraft(text);
};

/** 拖动落点记账（dragover 实时更新；drop 消费）。 */
const dropBefore = useRef<Node | null>(null);

/** 附件胶囊的拖动起点（容器级委托）：载荷 = 附件 id。execCommand 插回来的胶囊
 *  绑不上逐节点监听器，委托对「新建」与「undo 还原」两条来路都生效。 */
const onChipDragStart = (e: ReactDragEvent): void => {
  const chip = (e.target as HTMLElement).closest?.(`[${ATTACH_ATTR}]`);
  if (!(chip instanceof HTMLElement)) return;
  e.dataTransfer.setData('text/plain', chip.getAttribute(ATTACH_ATTR) ?? '');
  e.dataTransfer.effectAllowed = 'move';
};

/** 拖动经过：算落点（指针在胶囊左半 = 落它前面，右半 = 落它后面）。
 *  只接「文本载荷」的拖动（胶囊自己的 dragstart 设 text/plain）；文件拖放
 *  （types 含 Files）不接——那是面板层 stageFiles 的事。 */
const onChipDragOver = (e: ReactDragEvent): void => {
  const el = draftRef.current;
  if (!el) return;
  if (e.dataTransfer.types.includes('Files')) return;
  const chip = (e.target as HTMLElement).closest?.(`[${ATTACH_ATTR}],[${REF_ATTR}],[${CMD_ATTR}]`);
  if (!chip) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const rect = (chip as HTMLElement).getBoundingClientRect();
  dropBefore.current = e.clientX < rect.left + rect.width / 2 ? chip : chip.nextSibling;
};

/** 松手：把拖着的胶囊挪到落点（同一枚是移动不是复制），镜像同步。
 *  拖动载荷 = 附件 id（只有附件胶囊可拖；引用/命令胶囊路过时也接，但
 *  找不到对应节点就收手）。 */
const onChipDrop = (e: ReactDragEvent): void => {
  const el = draftRef.current;
  if (!el) return;
  if (e.dataTransfer.types.includes('Files')) return;
  const id = e.dataTransfer.getData('text/plain');
  const node = id ? el.querySelector(`[${ATTACH_ATTR}="${CSS.escape(id)}"]`) : null;
  if (!(node instanceof HTMLElement)) return;
  e.preventDefault();
  const anchor = (e.target as HTMLElement).closest?.(`[${ATTACH_ATTR}],[${REF_ATTR}],[${CMD_ATTR}]`);
  const target = dropBefore.current ?? (anchor instanceof HTMLElement ? anchor.nextSibling : null);
  el.insertBefore(node, target);
  dropBefore.current = null;
  setDraft(serializeDraft(el));
};

/** 拖动收尾：落点记账清掉。 */
const onChipDragEnd = (): void => {
  dropBefore.current = null;
};
  return {
    draft, setDraft,
    draftRef, atRange,
    cmdMenu, setCmdMenu,
    sessionPickerOpen, setSessionPickerOpen,
    caretInDraft, insertNodes, insertText, insertNewline,
    buildChip, buildCmdChip, buildAttachChip, insertAttach,
    syncCmdMenu, insertCommand, cmdMatches,
    insertRefs, insertRichText,
    closePicker, openChip, escapeAt, maybeOpenPicker,
    buildSessionChip, insertSessionTarget, maybeOpenSessionPicker, closeSessionPicker,
    onChipDragOver, onChipDrop, onChipDragEnd, onChipDragStart,
    setDraftText,
  };
}
