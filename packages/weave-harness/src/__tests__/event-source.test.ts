import { describe, it, expect } from 'vitest';
import { ClaudeEventSource, expandPayloadRefs } from '../claude/index.js';

const source = new ClaudeEventSource();

const normalize = (stdin: Record<string, unknown>, cwd?: string) =>
  JSON.parse(
    source.normalize(
      {
        source: 'claude',
        eventType: String(stdin.hook_event_name ?? ''),
        sessionId: null,
        ...(cwd ? { cwd } : {}),
        payload: JSON.stringify(stdin),
      },
      1,
    ).payload,
  );

describe('ClaudeEventSource 重复字段折叠', () => {
  const stdin = {
    hook_event_name: 'PostToolUse',
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'pnpm test' },
    tool_response: { stdout: '…' },
    cwd: '/p',
    transcript_path: '/p/t.jsonl',
    agent_id: 'a1',
    prompt: 'hi',
  };

  it('raw 的重复键折叠为指回外层的引用，非重复键原样保留', () => {
    const payload = normalize(stdin, '/p');
    expect(payload.raw).toEqual({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      agent_id: 'a1',
      prompt: 'hi',
      tool_name: '<$.toolName>',
      tool_input: '<$.toolInput>',
      tool_response: '<$.toolResponse>',
      cwd: '<$.cwd>',
      transcript_path: '<$.transcriptPath>',
    });
  });

  it('expandPayloadRefs 按 JSONPath 还原成原始 stdin', () => {
    const payload = normalize(stdin, '/p');
    expect(expandPayloadRefs(payload).raw).toEqual(stdin);
  });

  it('camelCase 键形同样折叠', () => {
    const camel = {
      hook_event_name: 'PreToolUse',
      toolName: 'Write',
      toolInput: { file: 'a.ts' },
      toolResponse: null,
      transcriptPath: '/x.jsonl',
    };
    const payload = normalize(camel);
    expect(payload.raw).toEqual({
      hook_event_name: 'PreToolUse',
      toolName: '<$.toolName>',
      toolInput: '<$.toolInput>',
      toolResponse: '<$.toolResponse>',
      transcriptPath: '<$.transcriptPath>',
    });
    expect(expandPayloadRefs(payload).raw).toEqual(camel);
  });

  it('没有 raw 对象（畸形 payload）时原样返回', () => {
    expect(expandPayloadRefs({ raw: null })).toEqual({ raw: null });
    expect(expandPayloadRefs({ raw: 'x' })).toEqual({ raw: 'x' });
  });
});
