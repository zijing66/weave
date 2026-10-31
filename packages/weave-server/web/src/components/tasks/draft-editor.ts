import type { CommandInputModeRow, HarnessCommandRow, RecognizedRef, UploadFile } from '@/lib/api';
import { isImageUpload } from './attach';
import type { PickItem, PickTarget } from './FilePicker';

/** 输入框里一枚引用胶囊的标记属性：`contenteditable="false"` 让它成原子块——
 *  退格整枚删、光标进不去；它的值就是 harness 的引用表达式（服务端算好的）。 */
export const REF_ATTR = 'data-ref';
/** 胶囊自己留的账（路径 / 类型 / 行区间）：点它要能回到这个文件再改一次。
 *  这几项是服务端给过的原值，不是对表达式的解析——前端始终不认识 `@` 与 `#L`。 */
export const REF_PATH_ATTR = 'data-ref-path';
export const REF_KIND_ATTR = 'data-ref-kind';
export const REF_LINES_ATTR = 'data-ref-lines';

/** 命令胶囊：值是命令名（不含 `/`），发出去时还原成 `/name`。 */
export const CMD_ATTR = 'data-cmd';
/** 胶囊的来源（builtin/command/skill/plugin）：只决定颜色。 */
export const CMD_SRC_ATTR = 'data-cmd-src';
/** 胶囊的触发符（缺省 `/`；codex 的 skill 是 `$`）：序列化时原样拼回去。 */
export const CMD_SIG_ATTR = 'data-cmd-sig';

/** 附件占位胶囊：值 = 上传件 id（暂存格与它一一对应）。 */
export const ATTACH_ATTR = 'data-attach';
/** 胶囊自己留的账（展示名 / 落盘路径 / 媒体类型）：序列化与「是不是图」都从这取，
 *  不对 id 反查——DOM 是唯一真源。展示名单独存：落盘路径是 hash 名，还原胶囊
 *  （快照/全屏往返）还得靠它。 */
export const ATTACH_NAME_ATTR = 'data-attach-name';
export const ATTACH_PATH_ATTR = 'data-attach-path';
export const ATTACH_MEDIA_ATTR = 'data-attach-media';

/** 会话目标胶囊（`#` 引用）：值 = 目标会话 id。**发送语义 = 本会话的一次普通
 *  prompt**：序列化把胶囊展开成 `#<会话名>` 标注（模型可读的收件人指示），由
 *  当前会话的模型自己整理内容并调宿主原生 SendMessage——weave 不代投。名字
 *  单独存：还原胶囊（快照往返）与序列化都靠它。 */
export const SESSION_ATTR = 'data-session-target';
export const SESSION_NAME_ATTR = 'data-session-name';

/** `nodeType` 的取值写死成字面量：测试环境是 node（没有 `Node` 全局），
 *  而这些数与 DOM 规范同寿，不会变。 */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** 换行容器：Chrome 的 contenteditable 用这些块表达「换了一行」（Shift+Enter 走
 *  `execCommand`、粘多行文本都落成 `<div>`，不是 `<br>`）。 */
const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3']);

/** 输入框 DOM 摊平后的片段：一段文本、一枚引用胶囊、一枚命令胶囊、一枚附件占位
 *  胶囊或一枚会话目标胶囊。 */
type DraftToken =
  | { text: string }
  | { ref: string; path: string; kind: PickTarget['kind']; lines?: { start: number; end: number } }
  | { cmd: string; sigil?: CmdSigil; source?: CmdSource }
  | { attach: string; name: string; path: string; mediaType: string }
  | { session: string; name: string };

/** composer DOM → 线性 token。**换行规则只说这一处**：
 *  - `<br>` = 一个换行；
 *  - 块级元素 = 新的一行（与前一个兄弟之间补 `\n`），块尾那枚 `<br>` 是浏览器给
 *    空行留的占位、不算换行——这样「连续回车留下的空行」原样保留；
 *  - 引用胶囊取 `data-ref*`（表达式绝不在前端拼）。
 *  `serializeDraft`（发出原文）与 `draftSnapshotOf`（草稿快照）共用这一份。 */
function draftTokensOf(root: Node | null): DraftToken[] {
  if (!root || root.nodeType !== ELEMENT_NODE) return [];
  const out: DraftToken[] = [];
  const text = (t: string): void => {
    if (t !== '') out.push({ text: t });
  };
  const chip = (el: HTMLElement, ref: string): void => {
    const [start, end] = (el.getAttribute(REF_LINES_ATTR) ?? '').split('-').map(Number);
    out.push({
      ref,
      path: el.getAttribute(REF_PATH_ATTR) ?? '',
      kind: el.getAttribute(REF_KIND_ATTR) === 'dir' ? 'dir' : 'file',
      ...(Number.isFinite(start) && Number.isFinite(end)
        ? { lines: { start: start!, end: end! } }
        : {}),
    });
  };
  const leaf = (node: Node): void => {
    if (node.nodeType === TEXT_NODE) {
      text(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const cmd = el.getAttribute(CMD_ATTR);
    if (cmd != null) {
      const source = el.getAttribute(CMD_SRC_ATTR) as CmdSource | null;
      const sigil = el.getAttribute(CMD_SIG_ATTR) as CmdSigil | null;
      out.push({ cmd, ...(source ? { source } : {}), ...(sigil ? { sigil } : {}) });
      return;
    }
    const ref = el.getAttribute(REF_ATTR);
    if (ref != null) {
      chip(el, ref);
      return;
    }
    const attach = el.getAttribute(ATTACH_ATTR);
    if (attach != null) {
      out.push({
        attach,
        name: el.getAttribute(ATTACH_NAME_ATTR) ?? '',
        path: el.getAttribute(ATTACH_PATH_ATTR) ?? '',
        mediaType: el.getAttribute(ATTACH_MEDIA_ATTR) ?? '',
      });
      return;
    }
    const session = el.getAttribute(SESSION_ATTR);
    if (session != null) {
      out.push({ session, name: el.getAttribute(SESSION_NAME_ATTR) ?? '' });
      return;
    }
    if (el.tagName === 'BR') {
      text('\n');
      return;
    }
    kids(el);
  };
  const kids = (parent: Node): void => {
    let seen = 0;
    Array.from(parent.childNodes).forEach((kid) => {
      const el = kid.nodeType === ELEMENT_NODE ? (kid as HTMLElement) : null;
      if (!el || !BLOCK_TAGS.has(el.tagName)) {
        leaf(kid);
        seen++;
        return;
      }
      // 块 = 新的一行：与前面的兄弟之间补一个换行（第一个不补）
      if (seen > 0) text('\n');
      seen++;
      const ref = el.getAttribute(REF_ATTR);
      if (ref != null) {
        chip(el, ref);
        return;
      }
      const session = el.getAttribute(SESSION_ATTR);
      if (session != null) {
        out.push({ session, name: el.getAttribute(SESSION_NAME_ATTR) ?? '' });
        return;
      }
      const inner = Array.from(el.childNodes);
      inner.forEach((g, gi) => {
        const filler =
          gi === inner.length - 1 && g.nodeType === ELEMENT_NODE && (g as HTMLElement).tagName === 'BR';
        if (!filler) leaf(g);
      });
    });
  };
  kids(root);
  return out;
}

/** composer DOM → 要发出去的原文（胶囊取 `data-ref`，换行还原成 `\n`）。
 *  附件占位胶囊**原地展开**：文件 = 落盘绝对路径（真·原地引用，回执比对原样含它）；
 *  图片 = **独立成行的落盘路径**（宿主粘贴处理器只认独立成行的图片路径——句中
 *  内联是死文本；转成 `[Image #N]` 后占位记号留在原位置，气泡按它内联回图）。
 *  胶囊前后各补一个换行（已有行边界则不重复补），保证路径独立成行。 */
export function serializeDraft(root: Node | null): string {
  const out = draftTokensOf(root)
    .map((t, i, all) => {
      if ('text' in t) return t.text;
      if ('ref' in t) return t.ref;
      if ('cmd' in t) return `${t.sigil ?? '/'}${t.cmd}`;
      // 会话目标胶囊 = 收件人标注：展开成 `#<会话 id>`（名字会重名也会改，
      // 正文里认会话只认 id；胶囊上仍显示名字，那是给人看的）
      if ('session' in t) return `#${t.session}`;
      // 附件胶囊：文件 = 路径；图片 = 独立成行的路径（前后补行边界）
      if (!isImageUpload({ mediaType: t.mediaType })) return t.path;
      // 行边界 = 没有邻居，或邻居是文本且贴着的那头已是换行；胶囊邻居（序列化成
      // 路径/表达式）不算边界，同样要补
      const prev = all[i - 1];
      const next = all[i + 1];
      const lead =
        prev === undefined || (('text' in prev ? prev.text : '') as string).endsWith('\n');
      const trail =
        next === undefined || (('text' in next ? next.text : '') as string).startsWith('\n');
      return `${lead ? '' : '\n'}${t.path}${trail ? '' : '\n'}`;
    })
    .join('');
  // 末尾那个 <br> 是浏览器给空行留的占位，不当换行算
  return out.endsWith('\n') && out.trim() === '' ? '' : out;
}

/** 输入框草稿的快照（按会话分键存 sessionStorage：刷新/重开面板都还回来）。
 *  **存结构化条目、不存 HTML**：胶囊按 data-* 还原，正文按文本 + 换行还原，
 *  这样既不用 innerHTML 吃不可信标记，也不怕类名/结构将来改。 */
export interface DraftSnapshot {
  parts: Array<
    | { t: string }
    | { r: string; path: string; kind: PickTarget['kind']; lines?: { start: number; end: number } }
    | { c: string; s?: CmdSource; g?: CmdSigil }
    | { a: string; p: string; n: string; m: string }
    | { ss: string; n: string }
  >;
  /** 已落盘、还没发出去的文件（同一条草稿的附件）。 */
  staged: UploadFile[];
}

const DRAFT_KEY_PREFIX = 'weave:draft:';
const DRAFT_KEY = (sessionId: string): string => `${DRAFT_KEY_PREFIX}${sessionId}`;

/** 草稿写盘/清空的变更信号：真源恒是 sessionStorage，事件只负责喊「该重读了」
 *  ——会话卡片的「草稿未发送」图标靠它跟着输入框动。 */
const DRAFT_CHANGED_EVENT = 'weave:draft-changed';

export function subscribeDraftChanges(listener: () => void): () => void {
  window.addEventListener(DRAFT_CHANGED_EVENT, listener);
  return () => window.removeEventListener(DRAFT_CHANGED_EVENT, listener);
}

/** 当前有未发送草稿的会话集合（扫 sessionStorage 键前缀：草稿只在浏览器本地，
 *  服务端一无所知，卡片图标因此纯前端判定）。 */
export function draftSessionIds(): Set<string> {
  const ids = new Set<string>();
  try {
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (!key?.startsWith(DRAFT_KEY_PREFIX)) continue;
      const id = key.slice(DRAFT_KEY_PREFIX.length);
      // 只剩空白/换行的快照不算「有草稿」（空输入框的占位 <br> 会存成一截 '\n'）
      const snap = readDraftSnapshot(id);
      if (!snap) continue;
      if (snap.staged.length > 0 || snap.parts.some((p) => !('t' in p) || p.t.trim() !== '')) {
        ids.add(id);
      }
    }
  } catch {
    // 隐私模式读不到：当作没有草稿
  }
  return ids;
}

/** 输入框 DOM → 快照；空草稿（没字也没附件）返回 null（调用方据此删键）。 */
export function draftSnapshotOf(
  root: HTMLElement | null,
  staged: readonly UploadFile[],
): DraftSnapshot | null {
  if (!root) return null;
  // 相邻文本段合并（token 化会把块边界切出多段）
  const parts: DraftSnapshot['parts'] = [];
  for (const token of draftTokensOf(root)) {
    if ('text' in token) {
      const last = parts[parts.length - 1];
      if (last && 't' in last) last.t += token.text;
      else parts.push({ t: token.text });
    } else if ('cmd' in token) {
      parts.push({
        c: token.cmd,
        ...(token.source ? { s: token.source } : {}),
        ...(token.sigil ? { g: token.sigil } : {}),
      });
    } else if ('attach' in token) {
      parts.push({ a: token.attach, p: token.path, n: token.name, m: token.mediaType });
    } else if ('session' in token) {
      parts.push({ ss: token.session, n: token.name });
    } else {
      parts.push({ r: token.ref, path: token.path, kind: token.kind, ...(token.lines ? { lines: token.lines } : {}) });
    }
  }
  return parts.length > 0 || staged.length > 0 ? { parts, staged: [...staged] } : null;
}

/** 快照 → 输入框 DOM（全部新建节点；胶囊的 DOM 形状归调用方传进来的 `buildChip`）。
 *  附件胶囊的还原回调缺席时退化成纯文本（展示名），不丢位置。 */
export function applyDraftSnapshot(
  root: HTMLElement,
  snap: DraftSnapshot,
  buildChip: (ref: string, target: PickTarget) => HTMLElement,
  buildCmdChip?: (name: string, source?: CmdSource, sigil?: CmdSigil) => HTMLElement,
  buildAttachChip?: (part: { a: string; p: string; n: string; m: string }) => HTMLElement,
  buildSessionChip?: (sessionId: string, name: string) => HTMLElement,
): void {
  root.replaceChildren();
  for (const part of snap.parts) {
    if ('c' in part) {
      if (buildCmdChip) root.appendChild(buildCmdChip(part.c, part.s, part.g));
      else root.appendChild(document.createTextNode(`${part.g ?? '/'}${part.c}`));
      continue;
    }
    if ('ss' in part) {
      if (buildSessionChip) root.appendChild(buildSessionChip(part.ss, part.n));
      // 无构造器时落成正文形（`#<id>`）：退化路也要发出同一个标识
      else root.appendChild(document.createTextNode(`#${part.ss}`));
      continue;
    }
    if ('a' in part) {
      if (buildAttachChip) root.appendChild(buildAttachChip(part));
      else root.appendChild(document.createTextNode(part.n));
      continue;
    }
    if ('r' in part) {
      const target: PickTarget = {
        path: part.path,
        kind: part.kind,
        ...(part.lines ? { lines: part.lines } : {}),
      };
      root.appendChild(buildChip(part.r, target));
      continue;
    }
    // 输入框里的换行是 `<br>`（serializeDraft 同口径），逐行还原
    part.t.split('\n').forEach((line, i) => {
      if (i > 0) root.appendChild(document.createElement('br'));
      if (line !== '') root.appendChild(document.createTextNode(line));
    });
  }
}

export function readDraftSnapshot(sessionId: string): DraftSnapshot | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DraftSnapshot>;
    return Array.isArray(parsed.parts) && Array.isArray(parsed.staged)
      ? { parts: parsed.parts as DraftSnapshot['parts'], staged: parsed.staged }
      : null;
  } catch {
    return null;
  }
}

export function writeDraftSnapshot(sessionId: string, snap: DraftSnapshot | null): void {
  try {
    if (snap) sessionStorage.setItem(DRAFT_KEY(sessionId), JSON.stringify(snap));
    else sessionStorage.removeItem(DRAFT_KEY(sessionId));
    window.dispatchEvent(new Event(DRAFT_CHANGED_EVENT));
  } catch {
    // 隐私模式写不进去：本次会话内照常，刷新后丢草稿，不影响别的
  }
}

/** 一段文本里**有没有可能**含引用表达式（`@` 前面是空白或行首）。
 *  粘贴走这条快路：整段连一个候选都没有，就不必往服务端问一趟认引用——
 *  纯文本粘贴卡顿的主因就是那一趟网络来回。 */
export function hasRefCandidate(text: string): boolean {
  return /(^|\s)@/.test(text);
}

/** 敲下 `@` 之后该怎么处理（纯函数，DOM 那边只负责把「光标之前那截」喂进来）：
 *  `escape` = `\@`，吃掉反斜杠留字面 `@`；`ignore` = 前面不是空白；`open` = 唤出选择器。
 *  **`@` 前面必须是空白（或行首）**——与服务端认引用的文法同一套判据：粘在字里
 *  （邮箱 `foo@bar`、中文 `看@a.ts`）既不是引用，也就不该弹框。 */
export type PickerIntent = 'open' | 'escape' | 'ignore';

export function pickerIntent(before: string): PickerIntent {
  if (!before.endsWith('@')) return 'ignore';
  if (before.endsWith('\\@')) return 'escape';
  const prev = before[before.length - 2];
  if (prev !== undefined && !/\s/.test(prev)) return 'ignore';
  return 'open';
}

/** 触发符的说明文案键（placeholder 的「`@` 文件 · `#` 会话」用）。 */
export const SIGIL_KEY: Record<
  string,
  'tasks.sigilFile' | 'tasks.sigilSession' | 'tasks.sigilCommand' | 'tasks.sigilBash' | 'tasks.sigilSkill'
> = {
  '@': 'tasks.sigilFile',
  '#': 'tasks.sigilSession',
  '/': 'tasks.sigilCommand',
  '!': 'tasks.sigilBash',
  '$': 'tasks.sigilSkill',
};

/** 输入框能敲出引用块的触发符（placeholder 按它出）：`@` 文件引用看能力面
 *  `pathRefs`、`#` 会话引用恒有（weave 自带，与 harness 无关）、命令形态的
 *  sigil 随能力面下发（`/` 命令、claude 的 `!` bash）、skill 的 `$` 随候选
 *  清单出现（codex）。顺序 = 用户最常敲的在前，同一枚只出一次。 */
export function refSigilsOf(
  pathRefs: boolean,
  modes: readonly CommandInputModeRow[],
  commands: readonly HarnessCommandRow[] | null,
): string[] {
  const out: string[] = [];
  if (pathRefs) out.push('@');
  out.push('#');
  for (const m of modes) if (!out.includes(m.sigil)) out.push(m.sigil);
  for (const c of commands ?? []) if (c.sigil && !out.includes(c.sigil)) out.push(c.sigil);
  return out;
}

/** 敲下 `#` 之后该怎么处理（与 `pickerIntent` 同一套形状）：`#` 是会话引用的
 *  触发键——`@` 归文件、`/` 归命令、`!` 归 bash、`$` 归 codex skill，全 harness
 *  空闲的引用惯例符只剩它。markdown 标题（行首 `# `）撞同一枚键：选择器关掉时
 *  会把 `#` 补回去（见 use-draft-editor 的 closeSessionPicker），标题照敲不误。 */
export function sessionPickerIntent(before: string): PickerIntent {
  if (!before.endsWith('#')) return 'ignore';
  if (before.endsWith('\\#')) return 'escape';
  const prev = before[before.length - 2];
  if (prev !== undefined && !/\s/.test(prev)) return 'ignore';
  return 'open';
}

/** 粘贴回填切成的一小段：一段原文，或一枚认出来的引用（`PickItem` 直接能喂给
 *  `insertRefs`，与选择器落定走同一条路）。 */
export type DraftSegment = { kind: 'text'; text: string } | { kind: 'ref'; item: PickItem };

/** 文本 + 服务端认出来的引用区间 → 交替的片段（粘贴时把表达式还原成胶囊）。
 *  区间按起点排序、重叠或越界的一律跳过（服务端给的是原文坐标，认错也不该吞字）。 */
export function buildSegments(text: string, refs: readonly RecognizedRef[]): DraftSegment[] {
  const out: DraftSegment[] = [];
  let at = 0;
  for (const r of [...refs].sort((a, b) => a.start - b.start)) {
    if (r.start < at || r.end > text.length || r.end <= r.start) continue;
    if (r.start > at) out.push({ kind: 'text', text: text.slice(at, r.start) });
    out.push({
      kind: 'ref',
      item: { ref: r.ref, target: { path: r.path, kind: r.kind, ...(r.lines ? { lines: r.lines } : {}) } },
    });
    at = r.end;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}

/** 光标之前那截文字。`Range.toString()` 不吐 `<br>` 的换行，而行首那枚 `@` 正靠
 *  「前面是空白」才成立——所以自己走一遍，`<br>` 折成 `\n`。 */
export function textBeforeCaret(root: Node, range: Range): string {
  let out = '';
  let hit = false;
  const walk = (node: Node): void => {
    if (hit) return;
    if (node === range.startContainer) {
      if (node.nodeType === TEXT_NODE) {
        out += (node.nodeValue ?? '').slice(0, range.startOffset);
      } else {
        const limit = Math.min(range.startOffset, node.childNodes.length);
        for (let i = 0; i < limit; i++) walk(node.childNodes[i]!);
      }
      hit = true;
      return;
    }
    if (node.nodeType === TEXT_NODE) {
      out += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    if ((node as HTMLElement).tagName === 'BR') {
      out += '\n';
      return;
    }
    for (const child of Array.from(node.childNodes)) {
      if (hit) return;
      walk(child);
    }
  };
  if (root === range.startContainer) {
    const limit = Math.min(range.startOffset, root.childNodes.length);
    for (let i = 0; i < limit; i++) walk(root.childNodes[i]!);
    return out;
  }
  for (const child of Array.from(root.childNodes)) {
    if (hit) break;
    walk(child);
  }
  return out;
}

/** 胶囊的样式（动态建元素也想吃 Tailwind：类名写死在源码里才生成得出）。
 *  称呼与发送出去的表达式一致，不做好看的别名——用户看见的就是会发出去的。 */
export const REF_CHIP_CLASS =
  'mx-0.5 inline-block max-w-[16rem] truncate rounded-full border border-blue-500/40 bg-blue-500/15 px-1.5 align-baseline font-mono text-11 leading-[1.5] text-blue-200';

/** 附件占位胶囊：绿色系（与引用蓝、命令黄/红区分开），微缩略图 + 截短名。 */
export const ATTACH_CHIP_CLASS =
  'mx-0.5 inline-flex max-w-[12rem] items-center gap-1 truncate rounded-full border border-emerald-500/40 bg-emerald-500/15 px-1.5 align-middle font-mono text-11 leading-[1.5] text-emerald-200';

/** 命令胶囊：黄色系、**不截断**（命令名本来就短，截断只会藏掉分辨它们的最后几位）。 */
const CMD_CHIP_CLASS =
  'mx-0.5 inline-block whitespace-nowrap rounded-full border border-amber-500/40 bg-amber-500/15 px-1.5 align-baseline font-mono text-11 leading-[1.5] text-amber-200';

/** skill / 插件命令：红色系——它们与官方命令不是一类东西（插在句子里也一样生效）。 */
const SKILL_CHIP_CLASS =
  'mx-0.5 inline-block whitespace-nowrap rounded-full border border-red-500/40 bg-red-500/15 px-1.5 align-baseline font-mono text-11 leading-[1.5] text-red-200';

/** 会话目标胶囊：紫色系（跨会话这个概念全站一色）。 */
export const SESSION_CHIP_CLASS =
  'mx-0.5 inline-block max-w-[14rem] truncate rounded-full border border-violet-500/40 bg-violet-500/15 px-1.5 align-baseline text-11 leading-[1.5] text-violet-200';

export type CmdSource = HarnessCommandRow['source'];
export type CmdSigil = '/' | '$';

/** 一枚命令胶囊该长什么样：skill/插件红、官方与自定义命令黄。 */
export function cmdChipClass(source: CmdSource | undefined): string {
  return source === 'skill' || source === 'plugin' ? SKILL_CHIP_CLASS : CMD_CHIP_CLASS;
}

/** 输入框里当前草稿命中的命令形态（触发符表来自服务端能力面）：null = 普通 prompt。
 *  判据与宿主一致——trim 后以触发符开头；`named` 的还要求紧跟命令名（`/name`），
 *  bash 模式（`!`）是整行命令行，不要求。 */
export function commandModeOf(
  text: string,
  modes: readonly CommandInputModeRow[],
): CommandInputModeRow | null {
  const t = text.trim();
  for (const mode of modes) {
    if (!t.startsWith(mode.sigil)) continue;
    if (mode.named && !/^[A-Za-z][A-Za-z0-9:_-]*(\s|$)/.test(t.slice(mode.sigil.length))) continue;
    return mode;
  }
  return null;
}

/** 输入框的模式色：claude 的输入框在 bash 模式换成品红边框（`bashBorder`），
 *  斜杠命令用与命令胶囊同色系的琥珀——一眼看出这条会不会被宿主当 prompt 提交。 */
export function commandModeClass(mode: CommandInputModeRow): string {
  return mode.kind === 'bash'
    ? 'border-[#ff0087]/60 ring-1 ring-[#ff0087]/25'
    : 'border-amber-500/50 ring-1 ring-amber-500/20';
}

/** 气泡里认出命令 token：**整条输入开头**（前面只有空白）的走宿主命令分派、全部
 *  可用；句中的只有宿主 mention 扫描认得出的（能力面 `inline`——claude 的
 *  prompt 型命令与 codex 的 `$skill`，前后必须是空白，与引用表达式同一条判据）。
 *  触发符也归能力面（claude 全 `/`、codex 的 skill 是 `$`）。
 *  认不出的名字一律当普通文字，不猜。 */
export interface CmdInfo {
  source: CmdSource;
  sigil: CmdSigil;
  /** 宿主能在句子中间（前后空白）认出这条命令；缺省 = 只在整条输入开头可用。 */
  inline?: boolean;
}
export type CmdToken =
  | { text: string }
  | { cmd: string; source: CmdSource | undefined; sigil: CmdSigil };

export function commandTokensOf(
  text: string,
  infoOf: (sigil: CmdSigil, name: string) => CmdInfo | undefined,
): CmdToken[] {
  const out: CmdToken[] = [];
  let at = 0;
  const re = /(^|\s)([/$])([A-Za-z][A-Za-z0-9:_-]*)(?=\s|$)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const sigil = m[2] as CmdSigil;
    const name = m[3]!;
    const info = infoOf(sigil, name);
    if (!info) continue;
    const start = m.index + m[1]!.length;
    // 整条输入开头（前面只有空白）才走命令分派；句中只认宿主 mention 得起的
    const head = text.slice(0, start).trim() === '';
    if (!head && !info.inline) continue;
    if (start > at) out.push({ text: text.slice(at, start) });
    out.push({ cmd: name, source: info.source, sigil });
    at = start + name.length + 1;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** 光标前那截文字里的命令触发位（空白后的 `/word` / `$word`）：交出触发符、已敲的
 *  名字片段与「是否整条输入开头」。head 判据与宿主分派一致——整条输入 trim 后以
 *  触发符开头才算，多行第二行的行首不算（宿主也不会分派它）。 */
export interface CmdQueryHit {
  sigil: CmdSigil;
  query: string;
  head: boolean;
}

export function cmdQueryIn(before: string): CmdQueryHit | null {
  const m = /(?:^|\s)([/$])([A-Za-z0-9:_-]*)$/.exec(before);
  if (!m) return null;
  return { sigil: m[1] as CmdSigil, query: m[2]!, head: before.slice(0, m.index).trim() === '' };
}

/** 这个位置敲下触发符，菜单有没有可给的候选：开头位全量可用；句中只摆宿主认
 *  mention 的（inline）——内建命令句中发了就是死文本，不如不弹。 */
export function cmdMenuShouldOpen(
  commands: readonly HarnessCommandRow[],
  sigil: CmdSigil,
  head: boolean,
): boolean {
  return commands.some((c) => (c.sigil ?? '/') === sigil && (head || c.inline === true));
}

/** 菜单候选：位置先筛（同上），再按前缀命中的排前面、包含命中的排后面（都按
 *  大小写不敏感比），截前 40。 */
export function cmdMenuMatches(
  commands: readonly HarnessCommandRow[],
  sigil: CmdSigil,
  query: string,
  head: boolean,
): HarnessCommandRow[] {
  const pool = commands.filter((c) => (c.sigil ?? '/') === sigil && (head || c.inline === true));
  const q = query.toLowerCase();
  const low = (c: HarnessCommandRow): string => c.name.toLowerCase();
  const prefix = pool.filter((c) => low(c).startsWith(q));
  const rest = pool.filter((c) => !low(c).startsWith(q) && low(c).includes(q));
  return [...prefix, ...rest].slice(0, 40);
}
