import { describe, it, expect } from 'vitest';
import {
  CODEX_EVENT_SOURCE,
  CodexTurnBuffer,
  metaOfLine,
  promptOfLine,
  type CodexLine,
} from '../event-source.js';

const meta = (cwd = 'C:/work/proj'): CodexLine => ({
  timestamp: '2026-11-01T00:00:00.000Z',
  ordinal: 1,
  type: 'session_meta',
  payload: { session_id: 'th-1', cwd },
});

/** ≤0.150 的用户输入落点。 */
const userMessage = (text: string): CodexLine => ({
  timestamp: '2026-11-01T00:00:10.000Z',
  ordinal: 3,
  type: 'event_msg',
  payload: { type: 'user_message', message: text },
});

/** 0.163 的用户输入落点（`item_completed` 携带）。 */
const itemUserMessage = (text: string): CodexLine => ({
  timestamp: '2026-11-01T00:00:10.000Z',
  ordinal: 3,
  type: 'event_msg',
  payload: {
    type: 'item_completed',
    item: { type: 'UserMessage', content: [{ type: 'text', text }] },
  },
});

const event = (type: string, extra: Record<string, unknown> = {}): CodexLine => ({
  timestamp: '2026-11-01T00:01:00.000Z',
  ordinal: 9,
  type: 'event_msg',
  payload: { type, ...extra },
});

/** 走一遍 `CodexTurnBuffer` 认出事件名，再归一（避免测试自己编事件名）。 */
const normalize = (line: CodexLine, lastAgentMessage?: string | null): Record<string, unknown> => {
  const report = new CodexTurnBuffer().report(line);
  if (!report) throw new Error(`no report for ${JSON.stringify(line)}`);
  if (lastAgentMessage !== undefined) report.payload.lastAgentMessage = lastAgentMessage;
  const built = CODEX_EVENT_SOURCE.normalize(report, 7);
  return JSON.parse(built.payload) as Record<string, unknown>;
};

describe('metaOfLine', () => {
  it('取 session_meta 的会话 id 与 cwd', () => {
    expect(metaOfLine(meta())).toEqual({ sessionId: 'th-1', cwd: 'C:/work/proj' });
  });

  it('缺 session_id / cwd 缺失或空都诚实回落', () => {
    expect(metaOfLine({ type: 'session_meta', payload: {} })).toBeNull();
    expect(metaOfLine({ type: 'session_meta', payload: { session_id: 'x' } })).toEqual({
      sessionId: 'x',
      cwd: null,
    });
    expect(metaOfLine({ type: 'session_meta', payload: { session_id: 'x', cwd: '' } })).toEqual({
      sessionId: 'x',
      cwd: null,
    });
    expect(metaOfLine(userMessage('hi'))).toBeNull();
  });
});

describe('promptOfLine', () => {
  it('两个版本的落点都认', () => {
    expect(promptOfLine(userMessage('看看这个 bug'))).toBe('看看这个 bug');
    expect(promptOfLine(itemUserMessage('看看这个 bug'))).toBe('看看这个 bug');
  });

  it('多段 content 拼成多行', () => {
    const line: CodexLine = {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'UserMessage',
          content: [
            { type: 'text', text: '第一行' },
            { type: 'image', path: 'C:/a.png' },
            { type: 'text', text: '第二行' },
          ],
        },
      },
    };
    expect(promptOfLine(line)).toBe('第一行\n第二行');
  });

  it('转录镜像（response_item message role=user）不算用户输入', () => {
    expect(
      promptOfLine({ type: 'response_item', payload: { type: 'message', role: 'user' } }),
    ).toBeNull();
  });

  it('空正文、别的 item 类型都不算', () => {
    expect(promptOfLine({ type: 'event_msg', payload: { type: 'user_message', message: '' } })).toBeNull();
    expect(
      promptOfLine({
        type: 'event_msg',
        payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [] } },
      }),
    ).toBeNull();
  });
});

describe('CodexTurnBuffer', () => {
  it('一个回合成组：SessionStart → UserPromptSubmit → Stop', () => {
    const buf = new CodexTurnBuffer();
    const types = [meta(), userMessage('跑一下测试'), event('task_complete')]
      .map((line) => buf.report(line)?.eventType)
      .filter(Boolean);
    expect(types).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
  });

  it('last_agent_message 为 null 时用本轮缓存的最后一条 agent_message 补位', () => {
    const buf = new CodexTurnBuffer();
    buf.report(userMessage('改一下颜色'));
    buf.report(event('agent_message', { message: '先看主题文件' }));
    buf.report(event('agent_message', { message: '改完了，浅色也看得清' }));
    const stop = buf.report(event('task_complete', { last_agent_message: null }));
    expect(stop?.payload.lastAgentMessage).toBe('改完了，浅色也看得清');
  });

  it('缓存不跨轮：下一轮 task_complete 不会拿到上一轮的正文', () => {
    const buf = new CodexTurnBuffer();
    buf.report(event('agent_message', { message: '上一轮' }));
    buf.report(event('task_complete'));
    buf.report(userMessage('再来一轮'));
    const stop = buf.report(event('task_complete', { last_agent_message: null }));
    expect(stop?.payload.lastAgentMessage).toBeNull();
  });

  it('用户输入前的那段 agent_message 也清掉（task_started 同样清）', () => {
    const buf = new CodexTurnBuffer();
    buf.report(event('agent_message', { message: '残留' }));
    buf.report(event('task_started'));
    expect(buf.report(event('task_complete'))?.payload.lastAgentMessage).toBeNull();
  });

  it('中断与工具收尾各归各的规范名', () => {
    const buf = new CodexTurnBuffer();
    expect(buf.report(event('turn_aborted', { reason: 'interrupted' }))?.eventType).toBe('TurnAborted');
    expect(buf.report(event('exec_command_end'))?.eventType).toBe('PostToolUse');
    expect(buf.report(event('patch_apply_end'))?.eventType).toBe('PostToolUse');
  });

  it('噪声行一条都不产：agent_message / token_count / turn_context / world_state', () => {
    const buf = new CodexTurnBuffer();
    expect(buf.report(event('agent_message', { message: 'x' }))).toBeNull();
    expect(buf.report(event('token_count', { total: 1 }))).toBeNull();
    expect(buf.report({ type: 'turn_context', payload: {} })).toBeNull();
    expect(buf.report({ type: 'world_state', payload: {} })).toBeNull();
    expect(buf.report({ type: 'response_item', payload: { type: 'message', role: 'user' } })).toBeNull();
  });
});

describe('CodexEventSource.normalize', () => {
  it('用户输入落到 raw.prompt（回执比对与气泡都读它）', () => {
    const built = CODEX_EVENT_SOURCE.normalize(
      { eventType: 'UserPromptSubmit', payload: { line: itemUserMessage('你好') } },
      7,
    );
    expect(built.source).toBe('codex');
    expect(built.eventType).toBe('UserPromptSubmit');
    expect(built.projectId).toBe(7);
    expect((JSON.parse(built.payload) as { raw: { prompt: string } }).raw.prompt).toBe('你好');
  });

  it('TurnAborted 带 reason，不进 error（用户自己断的不算失败）', () => {
    const out = normalize(event('turn_aborted', { reason: 'interrupted', duration_ms: 1200 }));
    expect(out.eventType).toBe('TurnAborted');
    const raw = out.raw as Record<string, unknown>;
    expect(raw.reason).toBe('interrupted');
    expect(raw.duration_ms).toBe(1200);
    expect('error' in raw).toBe(false);
  });

  it('正常收尾贴 last_assistant_message（对话面板读它当气泡）', () => {
    const out = normalize(event('task_complete', { last_agent_message: '搞定' }));
    expect((out.raw as Record<string, unknown>).last_assistant_message).toBe('搞定');
  });

  it('API 错误收尾同时贴 error', () => {
    const out = normalize(
      event('task_complete', { error: { message: 'stream disconnected before completion' } }),
    );
    expect((out.raw as Record<string, unknown>).error).toBe('stream disconnected before completion');
  });

  it('工具事件归一：exec_command 拼命令行、apply_patch 只留路径', () => {
    const exec = normalize(event('exec_command_end', {
      command: ['bash', '-lc', 'pnpm test'],
      cwd: 'C:/work/proj',
      exit_code: 1,
      status: 'failed',
    }));
    expect(exec.toolName).toBe('exec_command');
    expect(exec.toolInput).toEqual({ command: 'bash -lc pnpm test', cwd: 'C:/work/proj' });
    expect(exec.toolResponse).toEqual({ exit_code: 1, status: 'failed' });

    const patch = normalize(event('patch_apply_end', {
      success: true,
      changes: { 'src/a.ts': { content: '巨型正文' } },
    }));
    expect(patch.toolName).toBe('apply_patch');
    expect(patch.toolInput).toEqual({ paths: ['src/a.ts'] });
    expect(patch.toolResponse).toEqual({ success: true });
  });

  it('超长字段被裁（不把整份文件塞进库）', () => {
    const huge = 'x'.repeat(6000);
    const out = normalize(event('exec_command_end', { command: [huge], cwd: 'C:/p' }));
    const command = (out.toolInput as { command: string }).command;
    expect(command.length).toBeLessThan(4100);
    expect(command.endsWith('…')).toBe(true);
  });

  it('行号进 raw.seq，turn_id / call_id 原样带上', () => {
    const out = normalize(event('task_complete', { turn_id: 'turn-9' }));
    const raw = out.raw as Record<string, unknown>;
    expect(raw.seq).toBe(9);
    expect(raw.turn_id).toBe('turn-9');
    expect(raw.call_id).toBeNull();
  });
});
