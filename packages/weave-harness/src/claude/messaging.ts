import { HARNESS_LIFECYCLE, INJECTABLE_EVENTS } from '@weavecode/core';
import type { AttachSpec, MessagingSurface, PathRefSpec, RecognizedRef } from '../driver.js';
import { CLAUDE_PROMPT_INBOX } from './prompt-inbox.js';
import { CLAUDE_PROMPT_RELAY } from './prompt.js';
import { CLAUDE_RESUME } from './resume.js';
import { CLAUDE_SIDE_QUESTION } from './side-question.js';

/**
 * Claude 附件对齐面：**裸绝对路径、不加任何说明**、一行一条。
 *
 * - 图片：用户自己往输入框粘贴一条图片路径时它就是这么认的（粘贴处理器按
 *   `\.(png|jpe?g|gif|webp)$` 切出路径 → 读文件 → 输入框变 `[Image #N]` 占位 +
 *   消息里出真 image block）。路径放**独立一行**：粘贴处理器先按空格切路径边界、
 *   再按换行切行，行首的路径照样命中。
 * - 其它文件：宿主**没有附件形态**（占位符只有图片有），这行路径在 TUI 里就是
 *   一段原文，模型按需 `Read`。所以文件也走同一种形状，没有第二种语法。
 */
export const CLAUDE_ATTACH: AttachSpec = {
  kinds: ['image', 'file'],
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
 * Claude 路径引用面：`@<相对路径>` 就是它自己的 mention 文法（输入框里按 `@`
 * 唤起的补全插进去的也是这个形状）。相对路径相对会话 cwd，而会话 cwd = 项目根。
 * 目录同样可引用（宿主会列出目录内容），且**惯例带尾斜杠**——实机转录里
 * 手敲的目录引用都是 `@docs/plan/zcode/` 这个形状。
 *
 * **带空格的路径用双引号包**：`@"my file.md"`。2026-10-26 实测（scratch 会话
 * 逐形状发、转录里看 `attachment.type=file` 条目）：双引号形状宿主认（文件内容
 * 直接进上下文），`@my\ file.md`（转义）、`@'my file.md'`（单引号）、裸空格
 * `@my file.md` 都不认（模型只能自己 Read）；引号 + `#L` 行区间组合同样认
 * （`@"my file.md"#L1` 实测出 attachment）。无空格路径不加引号——与宿主
 * 补全插进去的形状一致。
 *
 * 另一头的前提（决定回执比对能不能工作）：这段文本会**原样**出现在
 * `UserPromptSubmit` 的 prompt 里，不会被宿主改写成别的表示法——实测抓到的
 * 事件里 `@.bench/ev.json @docs/plan/zcode/ 分优先级…` 逐字都在。
 *
 * 行区间是 `#L<起>` / `#L<起>-<止>`：同样来自实机转录里手敲的形状
 * （`…/application-30861.yml#L153-163`、`…/work@2026-09-14.md#L81`），
 * 不是我们发明的表示法。
 */
const CLAUDE_PATH_REF: PathRefSpec = {
  kinds: ['file', 'dir'],
  lines: true,
  expression: ({ path, kind, lines }) => {
    // 含空格才加引号：无空格路径保持裸形状（宿主补全插的就是它）。引号 + #L
    // 组合同样被实测背书（`@"my file.md"#L1` 转录出 file attachment）。
    const quoted = /\s/.test(path) ? `"${path}"` : path;
    if (kind === 'dir') return `@${quoted}/`;
    if (!lines) return `@${quoted}`;
    return lines.start === lines.end
      ? `@${quoted}#L${lines.start}`
      : `@${quoted}#L${lines.start}-${lines.end}`;
  },
  recognize: (text) => {
    const out: RecognizedRef[] = [];
    // 词取到空白 / 另一个 `@` / 全角标点为止：中文句子里的引用后面常直接跟「，还有」，
    // 而全角标点不可能出现在路径里（CJK 字母可以，`@文档/说明.md` 照样能认）。
    // 双引号形式先行：`@"my file.md"` 整段引号内都是路径（含空格），闭引号后
    // 照样要求空白（与裸形式同一判据）。
    for (const m of text.matchAll(/(?:^|\s)@"([^"@，。；：！？、（）【】「」『』《》…]+)"/g)) {
      const token = m[1]!;
      // m[0] = [前导空白]@["][token]["]：从尾部倒推 `@` 的下标（闭引号+token+开引号+@）
      const start = m.index + m[0].length - token.length - 3;
      let end = start + token.length + 3; // 闭引号之后
      // 闭引号后照样要求空白（与裸形式同一判据）；`#L` 行区间紧跟闭引号是
      // 手敲的自然延伸，一并认走
      const line = /#L(\d+)(?:-(\d+))?/.exec(text.slice(end, end + 16));
      if (line && line.index === 0) end += line[0].length;
      const next = text[end];
      if (next !== undefined && !/\s/.test(next)) continue;
      if (!token || token.startsWith('/') || token.includes(':') || token.includes('#')) continue;
      out.push({
        start,
        end,
        ref: text.slice(start, end),
        path: token,
        kind: 'file',
        ...(line ? { lines: { start: Number(line[1]), end: Number(line[2] ?? line[1]) } } : {}),
      });
    }
    // 裸形式（无空格路径）：词法同前，但跳过已被双引号形式认走的区间
    for (const m of text.matchAll(/(?:^|\s)@([^\s@，。；：！？、（）【】「」『』《》“”‘’…]+)/g)) {
      const token = m[1]!;
      const start = m.index + m[0].length - token.length - 1; // 那枚 `@` 的下标
      const end = start + 1 + token.length;
      // **前后必须都是空白**（或行首/行尾）：`看@src/a.ts`、`@src/a.ts，还有` 都不算——
      // 只要有一边粘着别的字，宁可当普通文本（误认会把话改成一条引用）
      const next = text[end];
      if (next !== undefined && !/\s/.test(next)) continue;
      const line = /#L(\d+)(?:-(\d+))?$/.exec(token);
      const rest = line ? token.slice(0, line.index) : token;
      // 目录惯例带尾斜杠；没有斜杠的交给调用方按索引判类型
      const dir = rest.endsWith('/');
      const path = dir ? rest.slice(0, -1) : rest;
      // 绝对路径、盘符、另一个 `#` 都不是项目内引用；`"` 开头是双引号形式的领地
      if (!path || path.startsWith('/') || path.includes(':') || path.includes('#')) continue;
      if (path.startsWith('"')) continue;
      // 双引号形式已认走这段（含空格路径）就不再按裸词法切它
      if (out.some((r) => start >= r.start && end <= r.end)) continue;
      const from = line ? Number(line[1]) : null;
      const to = line?.[2] ? Number(line[2]) : from;
      out.push({
        start,
        end,
        ref: text.slice(start, end),
        path,
        kind: dir ? 'dir' : 'file',
        ...(from != null ? { lines: { start: from, end: to! } } : {}),
      });
    }
    return out.sort((a, b) => a.start - b.start);
  },
};

/**
 * Claude 消息能力面（完整参考实现）：四通道全支持——
 * - prompt：原生 peer 消息经受限中继（SendMessage，寻址 = peer 注册表）；
 * - promptInbox：会话本地 inbox socket 直投（毫秒级、零进程零 LLM）；
 * - inject：outbox → 会话下一拍 hook 事件随 additionalContext 进会话（非抢占）；
 * - headless：resume 槽规格**对象直接引用**（单源，不复制）；
 * - watch：空闲信号取值源自 HARNESS_LIFECYCLE（close + 会话级终点），不手抄；
 * - attach：附件按 claude 自己的「粘贴路径」文法对齐（见上）；
 * - pathRefs：路径按 `@<相对路径>`（目录带尾斜杠）的 mention 文法对齐（见上）。
 */
export const CLAUDE_MESSAGING: MessagingSurface = {
  harness: 'claude',
  discovery: true,
  prompt: CLAUDE_PROMPT_RELAY,
  promptInbox: CLAUDE_PROMPT_INBOX,
  queuedPrompt: null,
  inject: { rideEvents: INJECTABLE_EVENTS.claude },
  headless: CLAUDE_RESUME,
  idleSignals: [...HARNESS_LIFECYCLE.claude.close, 'SessionEnd'],
  paneEnvSource: 'hook',
  attach: CLAUDE_ATTACH,
  pathRefs: CLAUDE_PATH_REF,
  sideQuestion: CLAUDE_SIDE_QUESTION,
};
