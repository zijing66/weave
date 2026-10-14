import { describe, it, expect } from 'vitest';
import { HARNESS_LIFECYCLE, INJECTABLE_EVENTS } from '@weavecode/core';
import { CLAUDE_MESSAGING } from '../claude/messaging.js';
import { CLAUDE_PROMPT_RELAY } from '../claude/prompt.js';
import { CLAUDE_RESUME } from '../claude/resume.js';
import { CODEX_MESSAGING } from '../codex/messaging.js';
import { CLAUDE_DRIVER, CODEX_DRIVER } from '../index.js';

/**
 * MessagingSurface 契约（session-orchestration 批 1）：claude 是完整参考实现，
 * codex 是显式不支持面。锁死三条单源约束——headless 对象引用 resume 槽、
 * rideEvents 取值 INJECTABLE_EVENTS、idleSignals 取值 HARNESS_LIFECYCLE。
 */
describe('MessagingSurface 契约', () => {
  it('claude：槽挂载 + capabilities 含 messaging', () => {
    expect(CLAUDE_DRIVER.capabilities).toContain('messaging');
    expect(CLAUDE_DRIVER.messaging).toBe(CLAUDE_MESSAGING);
  });

  it('codex：槽挂载（不支持也是面，不是槽位缺席）', () => {
    expect(CODEX_DRIVER.capabilities).toContain('messaging');
    expect(CODEX_DRIVER.messaging).toBe(CODEX_MESSAGING);
  });

  it('claude：三通道全开，headless = CLAUDE_RESUME 对象引用（单源不复制）', () => {
    expect(CLAUDE_MESSAGING.harness).toBe('claude');
    expect(CLAUDE_MESSAGING.discovery).toBe(true);
    expect(CLAUDE_MESSAGING.inject).toEqual({ rideEvents: INJECTABLE_EVENTS.claude });
    expect(CLAUDE_MESSAGING.headless).toBe(CLAUDE_RESUME);
  });

  it('claude：prompt = CLAUDE_PROMPT_RELAY 对象引用（单源不复制）', () => {
    expect(CLAUDE_MESSAGING.prompt).toBe(CLAUDE_PROMPT_RELAY);
    // 命令行固定参数、无用户内容；stdin 投递指令由 server 拼。
    expect(CLAUDE_PROMPT_RELAY.args.every((a) => !a.includes('\n'))).toBe(true);
    expect(CLAUDE_PROMPT_RELAY.args).toContain('--no-session-persistence');
    expect(CLAUDE_PROMPT_RELAY.args).toContain('--tools');
    expect(CLAUDE_PROMPT_RELAY.senderName).toBe('weave');
    expect(typeof CLAUDE_PROMPT_RELAY.resolve).toBe('function');
  });

  it('claude：中继指令含单向注记——目标读到的载荷先声明无需回复，再是原文', () => {
    const instruction = CLAUDE_PROMPT_RELAY.instruction('peer-a', 'go check the build');
    expect(instruction).toContain('"peer-a"');
    expect(instruction).toContain('SendMessage');
    expect(instruction).toContain('go check the build');
    // 注记在载荷头部（先于原文）
    expect(instruction.indexOf('one-way')).toBeLessThan(
      instruction.indexOf('go check the build'),
    );
  });

  it('claude：idleSignals 取值生命周期表（close + 会话级终点），不手抄', () => {
    expect(CLAUDE_MESSAGING.idleSignals).toEqual([
      ...HARNESS_LIFECYCLE.claude.close,
      'SessionEnd',
    ]);
    expect(CLAUDE_MESSAGING.idleSignals).toContain('Stop');
  });

  it('claude：headless 规格 promptStdin——args 不含 prompt（命令行无用户内容）', () => {
    expect(CLAUDE_RESUME.promptStdin).toBe(true);
    expect(CLAUDE_RESUME.args('sid-1', '任意 prompt')).toEqual(['--resume', 'sid-1', '-p']);
  });

  it('codex：全通道 null/空 + 五通道 reasons 齐全（可渲染「为什么置灰」）', () => {
    expect(CODEX_MESSAGING.harness).toBe('codex');
    expect(CODEX_MESSAGING.discovery).toBe(false);
    expect(CODEX_MESSAGING.prompt).toBeNull();
    expect(CODEX_MESSAGING.inject).toBeNull();
    expect(CODEX_MESSAGING.headless).toBeNull();
    expect(CODEX_MESSAGING.idleSignals).toEqual([]);
    for (const channel of ['discovery', 'prompt', 'inject', 'headless', 'watch'] as const) {
      expect(CODEX_MESSAGING.unsupportedReasons?.[channel]).toBeTruthy();
    }
  });
});
