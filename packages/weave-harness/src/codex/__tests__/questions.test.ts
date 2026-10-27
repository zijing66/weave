import { describe, it, expect } from 'vitest';
import { CODEX_QUESTIONS } from '../questions.js';

/**
 * Codex 阻塞式交互面：PermissionRequest hook → 审批问题面。锁死两条安全约束——
 * 只发行集无关的稳定键（y/n/d/1，中间增强选项绝不进面）、bypassPermissions 不摆面
 * （宿主 Never 档不弹框，摆了就是幽灵问题）。
 */

/** 归一化视图的测试构造（tracker 传给 eventQuestion 的形状）。 */
const view = (toolName: string | null, toolInput: unknown, permissionMode?: string) => ({
  raw: permissionMode === undefined ? {} : { permission_mode: permissionMode },
  toolName,
  toolInput,
});

describe('codex 阻塞问答面（PermissionRequest）', () => {
  it('exec 审批：y/n 两端（行集 2-4 行可变，中间键绝不进面）', () => {
    const q = CODEX_QUESTIONS.eventQuestion('PermissionRequest', view('Bash', { command: ['git', 'status'] }))!;
    expect(q.key).toBe('PermissionRequest:exec');
    expect(q.question).toBe('git status');
    expect(q.options.map((o) => o.keys)).toEqual([['y'], ['n']]);
    expect(q.options.map((o) => o.label)).toEqual(['Yes, proceed', 'No, and tell Codex what to do differently']);
    expect(q.multiSelect).toBe(false);
  });

  it('exec 载荷无 command 时回落 description / 缺省文案；超长截 200', () => {
    const byDesc = CODEX_QUESTIONS.eventQuestion('PermissionRequest', view('Bash', { description: 'list files' }))!;
    expect(byDesc.question).toBe('list files');
    const fallback = CODEX_QUESTIONS.eventQuestion('PermissionRequest', view('Bash', {}))!;
    expect(fallback.question).toBe('Codex wants to run a command');
    const long = CODEX_QUESTIONS.eventQuestion(
      'PermissionRequest',
      view('Bash', { command: ['x'.repeat(300)] }),
    )!;
    expect(long.question).toHaveLength(201);
    expect(long.question.endsWith('…')).toBe(true);
  });

  it('apply_patch：y/n 两端，question 取 patch 目标文件', () => {
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** End Patch';
    const q = CODEX_QUESTIONS.eventQuestion('PermissionRequest', view('apply_patch', { command: patch }))!;
    expect(q.key).toBe('PermissionRequest:patch');
    expect(q.question).toBe('src/a.ts');
    expect(q.options.map((o) => o.keys)).toEqual([['y'], ['n']]);
  });

  it('write_stdin：恒 2 行 [Approved, Abort]，y/n 两端', () => {
    const q = CODEX_QUESTIONS.eventQuestion(
      'PermissionRequest',
      view('write_stdin', { chars: 'q', session_id: 'p1' }),
    )!;
    expect(q.key).toBe('PermissionRequest:write_stdin');
    expect(q.options.map((o) => o.keys)).toEqual([['y'], ['n']]);
  });

  it('request_permissions：permissions overlay 恒 4 行，y=授予 / d=拒绝', () => {
    const q = CODEX_QUESTIONS.eventQuestion(
      'PermissionRequest',
      view('request_permissions', { reason: 'need net', permissions: {} }),
    )!;
    expect(q.key).toBe('PermissionRequest:permissions');
    expect(q.options.map((o) => o.keys)).toEqual([['y'], ['d']]);
    expect(q.options[1]!.label).toBe('No, continue without permissions');
  });

  it('MCP 工具（mcp__ 前缀）：RequestUserInputOverlay 数字键，1 恒 = Accept', () => {
    const q = CODEX_QUESTIONS.eventQuestion(
      'PermissionRequest',
      view('mcp__calendar__send', { to: 'a@b.c' }),
    )!;
    expect(q.key).toBe('PermissionRequest:mcp');
    expect(q.question).toContain('mcp__calendar__send');
    expect(q.options.map((o) => o.keys)).toEqual([['1']]);
  });

  it('bypassPermissions（Never 档）不摆面——宿主不弹框，摆了就是幽灵问题', () => {
    expect(
      CODEX_QUESTIONS.eventQuestion('PermissionRequest', view('Bash', { command: ['ls'] }, 'bypassPermissions')),
    ).toBeNull();
  });

  it('非 PermissionRequest / 缺 tool_name → null（不猜）', () => {
    expect(CODEX_QUESTIONS.eventQuestion('Stop', view('Bash', {}))).toBeNull();
    expect(CODEX_QUESTIONS.eventQuestion('PermissionRequest', view(null, {}))).toBeNull();
  });

  it('不可达路径的防御面：permissionQuestion / parseQuestions 返回诚实缺席（不 throw 炸 ingest）', () => {
    const pq = CODEX_QUESTIONS.permissionQuestion({
      toolName: null,
      toolInput: null,
      message: null,
      permissionMode: null,
    });
    expect(pq.options).toHaveLength(0);
    const parsed = CODEX_QUESTIONS.parseQuestions('anything', {});
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.options).toHaveLength(0);
  });

  it('规格形状：无阻塞工具、无 Notification 通道、无计划概念', () => {
    expect(CODEX_QUESTIONS.plan).toBeNull();
    expect(CODEX_QUESTIONS.blockingTools).toEqual([]);
    expect(CODEX_QUESTIONS.permissionNotificationType).toBeNull();
    expect(CODEX_QUESTIONS.silentPermissionModes).toContain('bypassPermissions');
  });
});
