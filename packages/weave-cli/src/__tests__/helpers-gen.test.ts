import { describe, it, expect } from 'vitest';
import { WEAVE_VERSION } from '@weavecode/server';
import { generateHookHandler, generateAutoMemoryHook } from '../init/helpers-gen';

describe('generateHookHandler', () => {
  it('emits a CJS shebang script', () => {
    const out = generateHookHandler();
    expect(out.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('reads stdin and exits 0', () => {
    const out = generateHookHandler();
    expect(out).toContain("process.stdin.on('data'");
    expect(out).toContain('process.exit(0)');
  });

  it('includes a weave version stamp', () => {
    const out = generateHookHandler();
    expect(out).toContain(`weave@${WEAVE_VERSION}`);
  });

  it('forwards reports to the daemon /hooks endpoint', () => {
    const out = generateHookHandler();
    expect(out).toContain("path: '/hooks'");
    expect(out).toContain("method: 'POST'");
    expect(out).toContain("'Bearer '");
    expect(out).toContain('readProjectToken');
    expect(out).toContain('readDaemonPort');
  });

  it('reads the project token from .weave/token', () => {
    const out = generateHookHandler();
    expect(out).toContain("'.weave'");
    expect(out).toContain("'token'");
  });

  it('never blocks Claude Code: exits 0 on every path', () => {
    const out = generateHookHandler();
    // success, error, timeout, missing config, catch-all — at least one per path
    const exitCount = (out.match(/process\.exit\(0\)/g) ?? []).length;
    expect(exitCount).toBeGreaterThanOrEqual(4);
  });

  it('relays additionalContext/sessionTitle from the daemon response', () => {
    const out = generateHookHandler();
    // 读响应体并解析
    expect(out).toContain("res.on('end'");
    expect(out).toContain('JSON.parse(data)');
    // 命中 inject 规则时输出 hookSpecificOutput.additionalContext
    expect(out).toContain('additionalContext');
    expect(out).toContain('sessionTitle');
    expect(out).toContain('hookSpecificOutput');
    expect(out).toContain('hookEventName');
    // 解析失败静默退出（catch 空块）
    expect(out).toContain('} catch {}');
  });
});

describe('generateAutoMemoryHook', () => {
  it('emits a Node shebang script', () => {
    expect(generateAutoMemoryHook().startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('exits 0', () => {
    expect(generateAutoMemoryHook()).toContain('process.exit(0)');
  });
});
