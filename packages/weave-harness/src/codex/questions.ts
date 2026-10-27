import type { BlockingPromptSpec, BlockingQuestion, BlockingQuestionOption } from '../driver.js';

/**
 * Codex 阻塞式交互面（0.164 实证）：审批对话框本身是 transient EventMsg——
 * 不落 rollout、不是 hook 事件，weave 的采集链路看不见它；但宿主在对话框弹出
 * **前**发 `PermissionRequest` hook（`codex-rs/core/src/tools/approvals.rs`
 * request_approval 的第一优先级），载荷自带 `tool_name` / `tool_input` /
 * `permission_mode`，问题面由它合成。weave 只采集不裁决：handler 不回 JSON
 * decision，宿主照常弹框等人。
 *
 * **作答键位的安全设计**：exec 对话框的行集随 available_decisions 变（2-4 行，
 * hook 载荷不带该字段 ⇒ 数字映射不可知），但**稳定字母快捷键与行集无关**
 * （`codex-rs/tui/src/keymap.rs` 硬编码默认）：`y`=approve（恒第一行 Accept）、
 * `n`=decline（恒末行 Cancel/Abort）。中间行（a=会话级放行 / p=前缀放行 /
 * d=拒绝）是否在行集里随对话框形态变——绝不进选项面，增强选项留给用户在
 * 终端里按。两个特例的行集**恒定**，才有第三个键：
 * - write_stdin 恒 2 行 `[Approved, Abort]`（available_decisions 显式给定）；
 * - request_permissions 的 permissions overlay 恒 4 行（`permissions_options`
 *   无条件固定 vec），`d`=Deny（deny 键去掉 Esc 后恒 `d`）。
 *
 * MCP 工具审批走另一套 overlay（RequestUserInputOverlay，数字选中即提交），
 * 行集同样可变（2-4 行），但 `'1'` 恒 = 第一行 Accept（mcp_tool_call.rs 的
 * options 构造恒以 ACCEPT 开头）——只发 `'1'`，其余行留给终端。
 */

/** exec / apply_patch / write_stdin 审批的稳定两端（字母键与行数无关）。 */
const APPROVE_KEY = 'y';
const DECLINE_KEY = 'n';

/** request_permissions 的 permissions overlay（恒 4 行）：d = Deny 行。 */
const DENY_KEY = 'd';

/** MCP 工具审批（RequestUserInputOverlay）：数字选中即提交，'1' 恒 = Accept。 */
const MCP_ACCEPT_KEY = '1';

/** 解析不出来的兜底问题面：看得见阻塞、没有远程作答（诚实缺席）。 */
const OPAQUE_QUESTION: BlockingQuestion = {
  key: 'codex:opaque',
  header: null,
  question: 'The session is waiting for input (options unavailable — answer in its terminal)',
  multiSelect: false,
  options: [],
};

/** exec 审批的 question 文案（载荷 command 数组拼一行，截 200 字）。 */
function execQuestionOf(toolInput: unknown): string {
  const input = toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {};
  const command = Array.isArray(input['command'])
    ? (input['command'] as unknown[]).filter((c) => typeof c === 'string').join(' ')
    : typeof input['command'] === 'string'
      ? input['command']
      : '';
  const desc = typeof input['description'] === 'string' ? input['description'] : null;
  const text = command || desc || 'Codex wants to run a command';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** apply_patch 审批的 question 文案（tool_input.command = 整份 patch，取目标文件概要）。 */
function patchQuestionOf(toolInput: unknown): string {
  const input = toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {};
  const patch = typeof input['command'] === 'string' ? input['command'] : '';
  if (!patch) return 'Codex wants to apply a patch';
  const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]!);
  const summary = files.length > 0 ? files.join(', ') : (patch.split('\n')[0] ?? 'patch');
  return summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
}

/** MCP 工具审批的 question 文案（tool_input = 原始 arguments 对象）。 */
function mcpQuestionOf(toolName: string, toolInput: unknown): string {
  const args =
    toolInput && typeof toolInput === 'object' && Object.keys(toolInput as object).length > 0
      ? JSON.stringify(toolInput)
      : '';
  const head = `Codex wants to call ${toolName}`;
  const text = args ? `${head} ${args}` : head;
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** 两端选项面（approve / decline；label 取宿主 overlay 的行文案）。 */
function approveDeclineOptions(approveLabel: string, declineLabel: string): BlockingQuestionOption[] {
  return [
    { keys: [APPROVE_KEY], label: approveLabel },
    { keys: [DECLINE_KEY], label: declineLabel },
  ];
}

/**
 * Codex 阻塞式交互规格。codex 没有阻塞工具（`request_user_input` 的事件
 * transient 且不落 rollout，hook 采集链路不可达——Plan 模式的结构化问答暂缓），
 * `blockingTools` 恒空、`parseQuestions` 不可达；权限确认走 `eventQuestion`
 * （PermissionRequest 事件），不经 Notification（`permissionNotificationType`
 * = null ⇒ tracker 的 Notification 分支对 codex 永远短路）。
 */
export const CODEX_QUESTIONS: BlockingPromptSpec = {
  plan: null,
  blockingTools: [],
  permissionNotificationType: null,
  // bypassPermissions = 宿主 Never 档：审批在更上游被跳过、hook 不发。名单是
  // 防御性声明（tracker 的 Notification 分支对 codex 不可达，真正生效的判据
  // 在下方 eventQuestion 里——「弹不弹」归 harness）。
  silentPermissionModes: ['bypassPermissions'],
  permissionQuestion() {
    // 不可达（permissionNotificationType = null）；防御性返回诚实缺席。
    return { ...OPAQUE_QUESTION, key: 'codex:permission' };
  },
  parseQuestions() {
    // 不可达（blockingTools 空 ⇒ PreToolUse 分支恒不命中）；防御性返回诚实缺席。
    return [{ ...OPAQUE_QUESTION }];
  },
  eventQuestion(eventType, payload) {
    if (eventType !== 'PermissionRequest') return null;
    const input = payload.raw && typeof payload.raw === 'object' ? (payload.raw as Record<string, unknown>) : {};
    const toolName = payload.toolName;
    const toolInput = payload.toolInput;
    const mode = typeof input['permission_mode'] === 'string' ? input['permission_mode'] : null;
    // Never 档不弹审批框（宿主在更上游跳过审批）；hook 若仍到达（防御），不摆面。
    if (mode === 'bypassPermissions') return null;
    if (toolName == null) return null;
    // MCP 工具（`mcp__server__tool` 线形）走 RequestUserInputOverlay：数字键。
    if (toolName.startsWith('mcp__')) {
      return {
        key: 'PermissionRequest:mcp',
        header: 'MCP tool approval',
        question: mcpQuestionOf(toolName, toolInput),
        multiSelect: false,
        options: [{ keys: [MCP_ACCEPT_KEY], label: 'Yes, run the tool and continue' }],
      };
    }
    if (toolName === 'apply_patch') {
      return {
        key: 'PermissionRequest:patch',
        header: 'Apply patch',
        question: patchQuestionOf(toolInput),
        multiSelect: false,
        options: approveDeclineOptions('Yes, proceed', 'No, and tell Codex what to do differently'),
      };
    }
    if (toolName === 'request_permissions') {
      // permissions overlay 恒 4 行：y=本轮授予 / r=严格自动复审 / a=本会话授予 /
      // d=拒绝。中间两行是授权范围的增强选项，不进面（r 的语义随版本演进）。
      return {
        key: 'PermissionRequest:permissions',
        header: 'Permissions',
        question: execQuestionOf(toolInput),
        multiSelect: false,
        options: [
          { keys: [APPROVE_KEY], label: 'Yes, grant these permissions for this turn' },
          { keys: [DENY_KEY], label: 'No, continue without permissions' },
        ],
      };
    }
    if (toolName === 'write_stdin') {
      // 向运行中进程注入按键的审批：available_decisions 显式恒 2 行
      // [Approved, Abort]（approvals.rs request_user_approval）——y/n 两端即全行集。
      return {
        key: 'PermissionRequest:write_stdin',
        header: 'Command approval',
        question: execQuestionOf(toolInput),
        multiSelect: false,
        options: approveDeclineOptions('Yes, proceed', 'No, cancel'),
      };
    }
    // exec（tool_name = "Bash"）与其余未知工具：行集 2-4 行可变，只发稳定两端
    // （y=Accept 恒第一行、n=Cancel/Abort 恒末行）。
    return {
      key: 'PermissionRequest:exec',
      header: 'Command approval',
      question: execQuestionOf(toolInput),
      multiSelect: false,
      options: approveDeclineOptions('Yes, proceed', 'No, and tell Codex what to do differently'),
    };
  },
};
