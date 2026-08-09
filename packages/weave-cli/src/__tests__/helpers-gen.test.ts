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
