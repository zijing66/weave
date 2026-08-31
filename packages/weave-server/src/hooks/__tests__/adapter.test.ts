import { describe, it, expect } from 'vitest';
import { ClaudeCodeAdapter } from '../adapter';
import type { HookReport } from '../types';

describe('ClaudeCodeAdapter', () => {
  const adapter = new ClaudeCodeAdapter();

  it('declares its source', () => {
    expect(adapter.source).toBe('claude');
  });

  it('normalizes snake_case stdin fields into a structured payload', () => {
    const raw = {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-1',
      tool_name: 'Edit',
      tool_input: { file: 'a.ts' },
      tool_response: { ok: true },
      cwd: '/proj',
      transcript_path: '/proj/t.jsonl',
    };
    const report: HookReport = {
      source: 'claude',
      eventType: 'PostToolUse',
      sessionId: null,
      cwd: '/proj',
      payload: JSON.stringify(raw),
    };
    const out = adapter.normalize(report, 42);
    expect(out.projectId).toBe(42);
    expect(out.source).toBe('claude');
    expect(out.eventType).toBe('PostToolUse');
    expect(out.sessionId).toBe('sess-1');
    const norm = JSON.parse(out.payload);
    expect(norm.toolName).toBe('Edit');
    expect(norm.toolInput).toEqual({ file: 'a.ts' });
    expect(norm.toolResponse).toEqual({ ok: true });
    expect(norm.cwd).toBe('/proj');
    expect(norm.transcriptPath).toBe('/proj/t.jsonl');
    expect(norm.raw).toEqual(raw);
  });

  it('falls back to hook_event_name when report.eventType is empty', () => {
    const report: HookReport = {
      source: 'claude',
      eventType: '',
      payload: JSON.stringify({ hook_event_name: 'PreToolUse' }),
    };
    expect(adapter.normalize(report, 1).eventType).toBe('PreToolUse');
  });

  it('reports unknown when no event type is available anywhere', () => {
    const report: HookReport = { source: 'claude', eventType: '', payload: '{}' };
    expect(adapter.normalize(report, 1).eventType).toBe('unknown');
  });

  it('tolerates malformed JSON payload without throwing', () => {
    const report: HookReport = {
      source: 'claude',
      eventType: 'PostToolUse',
      payload: 'not-json',
    };
    const out = adapter.normalize(report, 7);
    expect(out.eventType).toBe('PostToolUse');
    const norm = JSON.parse(out.payload);
    expect(norm.raw).toEqual({});
    expect(norm.toolName).toBeNull();
  });

  it('prefers report.sessionId over raw.session_id', () => {
    const report: HookReport = {
      source: 'claude',
      eventType: 'SessionStart',
      sessionId: 'from-report',
      payload: JSON.stringify({ session_id: 'from-raw' }),
    };
    expect(adapter.normalize(report, 1).sessionId).toBe('from-report');
  });

  it('prefers report.cwd over raw.cwd', () => {
    const report: HookReport = {
      source: 'claude',
      eventType: 'PostToolUse',
      cwd: '/from-report',
      payload: JSON.stringify({ cwd: '/from-raw' }),
    };
    const norm = JSON.parse(adapter.normalize(report, 1).payload);
    expect(norm.cwd).toBe('/from-report');
  });

  it('accepts camelCase stdin aliases', () => {
    const report: HookReport = {
      source: 'claude',
      eventType: 'PostToolUse',
      payload: JSON.stringify({ toolName: 'Write', toolInput: { x: 1 } }),
    };
    const norm = JSON.parse(adapter.normalize(report, 1).payload);
    expect(norm.toolName).toBe('Write');
    expect(norm.toolInput).toEqual({ x: 1 });
  });
});
