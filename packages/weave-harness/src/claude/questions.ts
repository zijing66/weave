import { HARNESS_LIFECYCLE } from '@weavecode/core';
import type { BlockingPromptSpec, BlockingQuestion, BlockingQuestionOption } from '../driver.js';

/**
 * 阻塞式交互问答（AskUserQuestion / 计划确认 / 权限确认）的 claude 规格：
 * 三类交互都会挂起会话等键盘输入，dashboard 侧要「看得到问题 + 按一键作答」。
 * 实证（本机 weave.db 36k+ 事件）：
 * - `PreToolUse(AskUserQuestion)` 的 toolInput 带全问题面
 *   （`questions[].question/header/options[].label+description/multiSelect`），
 *   `PostToolUse(AskUserQuestion)` 带 answers（阻塞解除）；
 * - `ExitPlanMode` 的 Pre toolInput 恒空、Post 的 toolResponse 带 plan filePath——
 *   问题面是合成的（宿主 UI 固定三选项）；
 * - `Notification` 的 `raw.notification_type = permission_prompt` = 权限对话框
 *   （不带工具面，由 tracker 补最近一次 PreToolUse 的上下文）。
 *
 * 作答键序 = 宿主模态框的数字快捷键（模态框只吃键盘，inbox/中继投递答不了）；
 * 单选数字即提交，多选补一记 CR。选项文案刻意保留英文原文——dashboard 显示的
 * 就是终端里那个英文模态框将发生的事。
 */

/** 计划确认的合成问题（ExitPlanMode 的 toolInput 恒空，宿主 UI 选项固定）。 */
const PLAN_QUESTION: BlockingQuestion = {
  key: 'ExitPlanMode:approve',
  header: 'Plan approval',
  question: 'Approve this plan and start execution?',
  multiSelect: false,
  options: [
    { keys: '1', label: 'Yes, and auto-accept edits' },
    { keys: '2', label: 'Yes, and manually approve edits' },
    { keys: '3', label: 'No, keep planning' },
  ],
};

/** 解析不出来的兜底问题面：看得见阻塞、没有远程作答（诚实缺席）。 */
const OPAQUE_QUESTION: BlockingQuestion = {
  key: 'AskUserQuestion:opaque',
  header: null,
  question: 'The session is asking a question (options unavailable — answer in its terminal)',
  multiSelect: false,
  options: [],
};

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

/** 选项序号键：单选数字即提交；多选数字只勾选、补一记 CR 确认。 */
function optionKeys(displayIndex: number, multiSelect: boolean): string {
  return multiSelect ? `${displayIndex + 1}\r` : String(displayIndex + 1);
}

/**
 * 宿主在选项列表尾部追加的自有行（实测模态框渲染）：`n+1` = Other（选中即变
 * 文本框，**键序不含 CR**——文本与提交 CR 由作答侧拼在后面）、`n+2` = Chat
 * about this（**仅单选**，按数字即结束整个提问回到聊天）。n = 该问题自己的
 * 选项数，故每问各算。
 */
function hostRows(optionCount: number, multiSelect: boolean): BlockingQuestionOption[] {
  const rows: BlockingQuestionOption[] = [
    {
      keys: String(optionCount + 1),
      label: 'Other',
      description: multiSelect ? 'Type something' : 'Type something.',
      input: true,
    },
  ];
  if (!multiSelect) {
    rows.push({ keys: String(optionCount + 2), label: 'Chat about this', chat: true });
  }
  return rows;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** `questions[].options` → 选项面（坏项跳过，键序按显示位重排）。 */
function parseOptions(raw: unknown, multiSelect: boolean): BlockingQuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: BlockingQuestionOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const label = str((item as { label?: unknown }).label);
    if (!label) continue;
    const description = (item as { description?: unknown }).description;
    out.push({
      keys: optionKeys(out.length, multiSelect),
      label,
      description: typeof description === 'string' && description ? description : null,
    });
  }
  return out;
}

export const CLAUDE_BLOCKING_PROMPT: BlockingPromptSpec = {
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
    return {
      key: 'permission:confirm',
      header: 'Permission',
      question: detail
        ? `Claude needs your permission: ${detail}`
        : 'Claude needs your permission',
      multiSelect: false,
      options: [
        { keys: '1', label: 'Yes' },
        { keys: '2', label: "Yes, and don't ask again this session" },
        { keys: '3', label: 'No (esc)' },
      ],
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
        const options = parseOptions((q as { options?: unknown }).options, multiSelect);
        if (!question || options.length === 0) continue;
        const face = header ?? question.slice(0, 24);
        out.push({
          key: `AskUserQuestion:${face}`,
          header,
          question,
          options: [...options, ...hostRows(options.length, multiSelect)],
          multiSelect,
        });
      }
      return out.length > 0 ? out : [OPAQUE_QUESTION];
    }
    // ExitPlanMode：toolInput 恒空——合成计划确认问题
    return [PLAN_QUESTION];
  },
};
