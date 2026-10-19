import type { PlanDraft, PlanSpec } from '../driver.js';

/**
 * 计划模式（claude）：ExitPlanMode 把计划交给用户批阅。正文的落点随宿主版本变：
 * - 老模型塞在 `tool_input.plan`（本机 8 月的事件里还是这个形状）；
 * - 2.1.296 起 tool_input **恒空**，宿主改成在计划模式提醒里给出计划文件路径、
 *   让模型自己写盘再提交（"write your plan to this file before calling
 *   ExitPlanMode"），正文于是只在那次 Write/Edit 的 content 里；
 * - Post 的 `tool_response.filePath` 指同一份文件，但那是批准之后才到，文件这时
 *   多半已被宿主删掉（实测 plan_mode_exit 附件 `planExists: false`）。
 * 计划文件路径不固定（`~/.claude/plans/<slug>.md`，可用 `plansDirectory` 挪到
 * 项目内），故只按形状认：某个 `plans` 目录下的 `.md`。
 */
const PLAN_FILE = /[\\/]plans[\\/][^\\/]+\.md$/i;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

export const CLAUDE_PLAN: PlanSpec = {
  tool: 'ExitPlanMode',
  writeTools: ['Write', 'Edit', 'MultiEdit'],
  fileHint: 'plans',
  draftOf(toolName, toolInput, toolResponse): PlanDraft | null {
    const input = obj(toolInput);
    const response = obj(toolResponse);
    if (toolName === 'ExitPlanMode') {
      return { text: str(input.plan) ?? str(response.plan), filePath: str(input.planFilePath) ?? str(response.filePath) };
    }
    if (toolName === null || toolName === undefined) return null;
    if (!CLAUDE_PLAN.writeTools.includes(toolName)) return null;
    const filePath = str(input.file_path) ?? str(response.filePath);
    if (!filePath || !PLAN_FILE.test(filePath)) return null;
    // Edit 只带片段，认不出整份计划：正文留空，交给 server 去读文件。
    return { text: str(input.content), filePath };
  },
};
