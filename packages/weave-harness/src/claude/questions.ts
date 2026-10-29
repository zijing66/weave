import { HARNESS_LIFECYCLE } from '@weavecode/core';
import type { BlockingPromptSpec, BlockingQuestion, BlockingQuestionOption } from '../driver.js';
import { CLAUDE_PLAN } from './plan.js';
import { defaultPermissionModeOf } from './model-aliases.js';
import { preQuestionTextAt } from './transcript.js';
import { readTail } from './transcript-cursor.js';

/** 提问前说明的取数窗口：锚点（阻塞工具调用）恒在文件末尾附近。 */
const PRE_QUESTION_TAIL_BYTES = 512 * 1024;

/**
 * 阻塞式交互问答（AskUserQuestion / 计划确认 / 权限确认）的 claude 规格：
 * 三类交互都会挂起会话等键盘输入，dashboard 侧要「看得到问题 + 按一键作答」。
 * 实证（本机 weave.db 36k+ 事件）：
 * - `PreToolUse(AskUserQuestion)` 的 toolInput 带全问题面
 *   （`questions[].question/header/options[].label+description/multiSelect`），
 *   `PostToolUse(AskUserQuestion)` 带 answers（阻塞解除）；
 * - `ExitPlanMode` 的 Pre toolInput 恒空、Post 的 toolResponse 带 plan filePath——
 *   问题面是合成的（行数随会话默认权限模式变，见 `planApprovalOptions`）；
 * - `Notification` 的 `raw.notification_type = permission_prompt` = 权限对话框
 *   （不带工具面，由 tracker 补最近一次 PreToolUse 的上下文）。
 *
 * 作答键序 = 宿主模态框的数字快捷键（模态框只吃键盘，inbox/中继投递答不了），
 * 按**原子**下发（每个元素一次击键写：宿主把同一批多个文本字符当一次粘贴，
 * 实测「11」会被当筛选字串一个都不选）。实机（claude 2.1.296）口径：
 * - 单选数字 = 选中 + 推进到下一 tab（无 Submit 步时即完成整 call）；
 * - 多选数字 = 只勾选、不推进（故多选问题答完要补一记 Tab 走下一个 tab）；
 * - tab 条 = 每问一个 tab 外加 `✔ Submit`（当且仅当 `questions≥2 || 任一 multiSelect`）；
 * - 每问尾部宿主自有行 = `n+1` Other（`+↓×n+文本+尾巴`）、`n+2` Chat（两模式都有，
 *   按数字即结束整个提问）；
 * - 选项文案刻意保留英文原文——dashboard 显示的就是终端里那个英文模态框将发生的事。
 *
 * **预览模式**（单选且任一选项带 `preview` 时宿主换的左右分栏形态；多选即使带预览
 * 也落回上表旧形态）：左栏选项（**不渲染描述**）、右栏预览 + `Notes:` 行、下方
 * `Chat about this`——数字只挪高亮、**回车才提交**、`n` 进备注框、↓ 到最后一项再按
 * 才进聊天行（那里回车即结束提问）。没有 Other 行，自定义文本改走备注行；备注只挂
 * 在「挪过高亮」的选项上，只填备注不选选项则宿主自己答成 `(notes only)` 字串。
 */

/** 下移（模态框行间导航）。 */
const DOWN = '\x1b[B';
/** 下一个 tab（多选勾完、或跳过未作答的问题；Submit 屏上再按是空操作——实测不绕回）。 */
const TAB = '\t';
/** 反馈提交键：plan 第 3 行的反馈文本框里，shift+tab = 带反馈批准（宿主原文提示）。 */
const SHIFT_TAB = '\x1b[Z';

/** 预览模式（宿主左右分栏形态）的原文字串——实机 claude 2.1.296 口径。 */
const PREVIEW_MAX_CHARS = 2000;
/** 宿主右栏在预览过长 / 含隐形字符时的原文（预览不被展示，选项面就该被比较）。 */
const PREVIEW_WITHHELD =
  '(preview cannot be shown in full — compare the option labels and descriptions instead)';
/** 宿主右栏在某选项不带预览时的原文。 */
const PREVIEW_NONE = 'No preview available';
/** 备注行的焦点键：宿主预览面里按 `n` 进备注框（不是数字，故与选项行不同型）。 */
const NOTES_KEY = 'n';
/** 备注行未聚焦时宿主的原文（dim italic 提示）。 */
const NOTES_HINT = 'press n to add notes';
/** 隐形 / 双向控制字符（宿主会把它们中和掉，改得动就整条不展示）。 */
const INVISIBLE_CHARS = /[\p{M}\u200b-\u200f\u2028-\u202e\u2060-\u206f\u180b-\u180f\ufe0e\ufe0f]/u;

/**
 * 计划确认的选项面（ExitPlanMode 的 toolInput 恒空，只能合成）。**行数随会话默认
 * 权限模式变**——同一个数字键在两种形态下语义不同，照错形态发键就是「想拒绝却
 * 批准了」。实测（claude 2.1.296）：
 * - 默认模式 = `default`：2 行，第 1 行批准并切到默认（ask each time）、第 2 行
 *   就是拒绝（`No`）；
 * - 默认模式 = `bypassPermissions`（本机 `permissions.defaultMode`）：3 行，
 *   `1` 批准并切 bypass、`2` 批准但每次编辑手动确认、`3` 拒绝并说明（打完反馈
 *   shift+tab 提交）。
 * 默认模式取自设置文件（hook 事件的 `permission_mode` 在 plan 模式下恒为 plan，
 * 带不出这个事实）。**已知残余**：其他非 default 模式（acceptEdits 等）宿主也可能
 * 出 3 行，但那两种形态的文案未取证，先按缺省 2 行走——按错会像本轮这样被用户
 * 抓到，届时按实测补表。
 */
const PLAN_OPTIONS_DEFAULT: readonly BlockingQuestionOption[] = [
  { keys: ['1'], label: 'Yes, and switch to default (ask each time) for this session' },
  { keys: ['2'], label: 'No' },
];

/** 非 default 模式下第 1 行的模式显示名（实测原文；表外模式按 id 原样补）。 */
const PLAN_SWITCH_LABEL: Record<string, string> = {
  bypassPermissions: 'BYPASS PERMISSIONS (no further prompts)',
};

/** 计划确认选项面（纯函数：按默认权限模式给行）。 */
export function planApprovalOptions(
  defaultMode: string | null,
): BlockingQuestionOption[] {
  if (defaultMode == null || defaultMode === 'default' || defaultMode === 'plan') {
    return PLAN_OPTIONS_DEFAULT.map((o) => ({ ...o }));
  }
  return [
    {
      keys: ['1'],
      label: `Yes, and switch to ${PLAN_SWITCH_LABEL[defaultMode] ?? defaultMode} for this session`,
    },
    { keys: ['2'], label: 'Yes, manually approve edits' },
    {
      // 第 3 行 = 反馈输入行（宿主按 3 进文本框、打完 shift+tab 带反馈批准）：
      // 标成 input 行 web 才出输入框，键序 = 数字 + 文本 + shift+tab。
      keys: ['3'],
      label: 'Tell Claude what to change',
      description: 'shift+tab to approve with this feedback',
      input: true,
      textTail: [SHIFT_TAB],
    },
  ];
}

/**
 * 权限对话框的两种形态——**选项行数与键义完全不同**，按错形态发键就是「想批准
 * 却拒了」。文案取自宿主二进制字符串表（claude 2.1.296）：
 * - 经典 = 3 行：`Yes` / `Yes, and don't ask again for <规则>` / `No, and tell
 *   Claude what to do differently (esc)`；
 * - auto 模式分类器升级 = 2 行：`Yes, and tell Claude what to do next` / `No`
 *   （第 2 行在这里是**拒绝**，在经典里是「别再问」）。
 */
const CLASSIC_PERMISSION_OPTIONS: readonly BlockingQuestionOption[] = [
  { keys: ['1'], label: 'Yes' },
  { keys: ['2'], label: "Yes, and don't ask again for this tool" },
  { keys: ['3'], label: 'No, and tell Claude what to do differently (esc)' },
];
const AUTO_PERMISSION_OPTIONS: readonly BlockingQuestionOption[] = [
  { keys: ['1'], label: 'Yes, and tell Claude what to do next' },
  { keys: ['2'], label: 'No' },
];

/** 解析不出来的兜底问题面：看得见阻塞、没有远程作答（诚实缺席）。 */
const OPAQUE_QUESTION: BlockingQuestion = {
  key: 'AskUserQuestion:opaque',
  header: null,
  question: 'The session is asking a question (options unavailable — answer in its terminal)',
  multiSelect: false,
  options: [],
};

/**
 * 模型切换确认（宿主 `/model <名>` 那句「Switch model?」）：PreModelSwitch 事件的
 * raw 带 from_model/to_model 与 prompt_cache_warm。对话框**只在缓存要作废时**弹
 * （宿主自己的判据：有历史响应、目标模型 ≠ 当前、且这次缓存作废还没被确认过），
 * 故按 prompt_cache_warm && to ≠ from 认——不成立就不给问题面，否则面板有问、
 * 终端无框，键序会打进输入框。残余缺口（同一批输出里连切两次、第二次宿主不再弹）
 * 由 PostModelSwitch 落定压掉。
 */
function switchQuestion(raw: unknown): BlockingQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const fields = raw as Record<string, unknown>;
  const to = str(fields['to_model']);
  const from = str(fields['from_model']);
  if (!to || !from || to === from) return null;
  if (fields['prompt_cache_warm'] !== true) return null;
  return {
    key: 'model:switch',
    header: 'Switch model?',
    question:
      'Your next response will be slower and use more tokens. This conversation is cached for ' +
      `the current model. Switching to ${to} means the full history gets re-read on your next message.`,
    multiSelect: false,
    options: [
      { keys: ['1'], label: `Yes, switch to ${to}` },
      { keys: ['2'], label: 'No, go back' },
    ],
  };
}

/** 权限上下文的工具输入预览（紧凑 JSON，截 160 字）。 */
function previewOf(toolInput: unknown): string {
  if (toolInput == null || typeof toolInput !== 'object') return '';
  try {
    const text = JSON.stringify(toolInput);
    if (!text || text === '{}') return '';
    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
  } catch {
    return '';
  }
}

/**
 * 宿主在选项列表尾部追加的自有行（实测模态框渲染，两模式都有）：`n+1` = Other
 * （单选数字即变文本框，`textTail` = 回车；多选数字只勾选、要 ↓ 到该行才能打字，
 * 打完 Tab 移出文本框到内联 Next/Submit 再回车）、`n+2` = Chat about this
 * （按数字即结束整个提问回到聊天）。n = 该问题自己的选项数，故每问各算。
 */
function hostRows(optionCount: number, multiSelect: boolean): BlockingQuestionOption[] {
  return [
    multiSelect
      ? {
          keys: [String(optionCount + 1)],
          label: 'Type something',
          input: true,
          textFocus: Array.from({ length: optionCount }, () => DOWN),
          textTail: [TAB, '\r'],
        }
      : {
          keys: [String(optionCount + 1)],
          label: 'Type something',
          input: true,
          textTail: ['\r'],
        },
    { keys: [String(optionCount + 2)], label: 'Chat about this', chat: true },
  ];
}

/**
 * 提交步（`questions≥2 || 任一 multiSelect` 时宿主才给这个 tab）：整 call 的收尾屏，
 * 键序 = 走到 Submit tab（问题内的推进键已把焦点带来，多按一记 Tab 是空操作，留作
 * 兜底）再按数字。它不是宿主的第 n 个问题，web 渲染成弹窗底部动作。
 */
function submitStep(): BlockingQuestion {
  return {
    key: 'AskUserQuestion:submit',
    header: 'Submit',
    question: 'Review your answers',
    multiSelect: false,
    submit: true,
    options: [
      { keys: [TAB, '1'], label: 'Submit answers' },
      { keys: [TAB, '2'], label: 'Cancel' },
    ],
  };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** `questions[].options` → 选项面（坏项跳过，键序按显示位重排）。 */
function parseOptions(raw: unknown): BlockingQuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: BlockingQuestionOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const label = str((item as { label?: unknown }).label);
    if (!label) continue;
    const description = (item as { description?: unknown }).description;
    out.push({
      keys: [String(out.length + 1)],
      label,
      description: typeof description === 'string' && description ? description : null,
      preview: previewPaneText((item as { preview?: unknown }).preview),
    });
  }
  return out;
}

/**
 * 宿主右栏的原文（`h3` 的 preview 归一）：无可见内容 = 该选项**没有预览**（返回 null，
 * 连模式判据都不算它一个）；超长 / 含隐形字符 = 内容不被展示（右栏给固定原文）。
 */
function previewPaneText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length > PREVIEW_MAX_CHARS) return PREVIEW_WITHHELD;
  if (!raw.replace(/�/g, '').trim()) return null;
  return INVISIBLE_CHARS.test(raw) ? PREVIEW_WITHHELD : raw;
}

/**
 * 预览模式的选项键：数字**只挪高亮**、回车才提交，且宿主只为「挪过高亮」的选项
 * 保存备注（备注挂在当前高亮项上、没挪过则退化成「(notes only)」）——故先挪到
 * 别处、第二记落在目标上。单选项无处可挪，这时备注行整个不给（见 `previewTail`）。
 */
function previewMoveKeys(index: number, count: number): string[] {
  if (count < 2) return [String(index + 1)];
  return [String(index === 0 ? 2 : 1), String(index + 1)];
}

/** 预览模式的选项行：提交另需回车；右栏原文随行下发（无预览 = 宿主的占位原文）。 */
function previewOptionRows(options: readonly BlockingQuestionOption[]): BlockingQuestionOption[] {
  return options.map((option, i) => ({
    keys: previewMoveKeys(i, options.length),
    commit: ['\r'],
    label: option.label,
    description: option.description,
    preview: option.preview ?? PREVIEW_NONE,
  }));
}

/**
 * 预览模式的尾行（**没有** `n+1` Other 行——自定义文本改走 `n` 备注行）：
 * 备注行 = `n` 进文本框（文本非空才发得出去）；聊天行 = 数字到最后一项再 ↓ 才进得去，
 * 那里按回车即结束整个提问。
 */
function previewTail(count: number): BlockingQuestionOption[] {
  const rows: BlockingQuestionOption[] = [];
  if (count >= 2) {
    rows.push({
      keys: [NOTES_KEY],
      label: 'Notes:',
      description: NOTES_HINT,
      input: true,
      textTail: ['\r'],
    });
  }
  rows.push({ keys: [String(count), DOWN, '\r'], label: 'Chat about this', chat: true });
  return rows;
}

export const CLAUDE_BLOCKING_PROMPT: BlockingPromptSpec = {
  plan: CLAUDE_PLAN,
  blockingTools: HARNESS_LIFECYCLE.claude.questionTools,
  permissionNotificationType: 'permission_prompt',
  // 宿主自身模式表（`claude --help` 的 permission mode 说明）里只有这两个
  // 结构上不弹权限框：bypassPermissions = 跳过全部检查；dontAsk = 不提示、
  // 未预批准直接拒。acceptEdits 只自动放行文件编辑（命令仍弹，实测有真对话框）、
  // auto 由分类器裁决但仍可能落到用户、plan 的计划批准就是从这来的——都不进名单。
  silentPermissionModes: ['bypassPermissions', 'dontAsk'],
  permissionQuestion(ctx) {
    const detail = ctx.toolName
      ? `${ctx.toolName}${ctx.toolInput ? ` ${previewOf(ctx.toolInput)}` : ''}`
      : '';
    // 形态判据：auto 模式把人叫起来的一定是分类器升级（2 行）；原文提到 classifier
    // 也算。认不出来按经典 3 行走——那是不带 auto 时的默认对话框。
    const autoFace = ctx.permissionMode === 'auto' || /classifier/i.test(ctx.message ?? '');
    const head = ctx.message?.trim() || 'Claude needs your permission';
    return {
      key: 'permission:confirm',
      header: autoFace ? 'Permission (auto mode)' : 'Permission',
      question: detail ? `${head}\n${detail}` : head,
      multiSelect: false,
      options: [...(autoFace ? AUTO_PERMISSION_OPTIONS : CLASSIC_PERMISSION_OPTIONS)],
    };
  },
  parseQuestions(toolName, toolInput) {
    if (toolName === 'AskUserQuestion') {
      const raw =
        toolInput && typeof toolInput === 'object'
          ? (toolInput as { questions?: unknown }).questions
          : undefined;
      if (!Array.isArray(raw)) return [OPAQUE_QUESTION];
      const out: BlockingQuestion[] = [];
      for (const q of raw) {
        if (!q || typeof q !== 'object') continue;
        const question = str((q as { question?: unknown }).question);
        const header = str((q as { header?: unknown }).header);
        const multiSelect = (q as { multiSelect?: unknown }).multiSelect === true;
        const options = parseOptions((q as { options?: unknown }).options);
        if (!question || options.length === 0) continue;
        const face = header ?? question.slice(0, 24);
        // 宿主预览模式（单选 + 任一选项带预览；多选即使带预览也落回旧形态）。
        const previewMode = !multiSelect && options.some((o) => o.preview != null);
        out.push({
          key: `AskUserQuestion:${face}`,
          header,
          question,
          options: previewMode
            ? [...previewOptionRows(options), ...previewTail(options.length)]
            : [...options, ...hostRows(options.length, multiSelect)],
          multiSelect,
          previewMode,
        });
      }
      if (out.length === 0) return [OPAQUE_QUESTION];
      // 一问单选时宿主自己就没有 Submit 屏（数字即完成整 call），不下发这一步。
      if (out.length >= 2 || out.some((q) => q.multiSelect)) out.push(submitStep());
      return out;
    }
    // ExitPlanMode：toolInput 恒空——按会话默认权限模式合成选项面（2 行 / 3 行）
    return [
      {
        key: 'ExitPlanMode:approve',
        header: 'Exit plan mode?',
        question: 'Claude wants to exit plan mode',
        multiSelect: false,
        options: planApprovalOptions(defaultPermissionModeOf()),
      },
    ];
  },
  eventQuestion(eventType, payload) {
    if (eventType === 'PreModelSwitch') return switchQuestion(payload.raw);
    return null;
  },
  async preQuestion(transcriptPath) {
    if (!transcriptPath) return null;
    // 只读尾部：提问前那段话与阻塞工具调用是相邻行（同一 message 被拆成几行），
    // 此刻宿主正卡在提问上、后面没有内容——整份读几十 MB 纯属浪费。
    const tail = readTail(transcriptPath, PRE_QUESTION_TAIL_BYTES);
    return tail === null ? null : preQuestionTextAt(tail);
  },
};
