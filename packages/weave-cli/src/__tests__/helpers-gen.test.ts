import { describe, it, expect } from 'vitest';
import { generateHookHandler, generateStatusline, generateAutoMemoryHook } from '../init/helpers-gen';

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
    expect(out).toContain('weave@0.1.0');
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
});

describe('generateStatusline', () => {
  it('outputs a one-line status', () => {
    const out = generateStatusline();
    expect(out).toContain('console.log');
    expect(out).toContain('weave v0.1.0');
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
