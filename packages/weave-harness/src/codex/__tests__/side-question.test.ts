import { describe, it, expect } from 'vitest';
import { CODEX_SIDE_QUESTION } from '../side-question.js';

/** 0.164 实测屏幕样本（2026-10-27 spike）：单轮侧问完成态。 */
const SCREEN_ONE_ROUND = [
  '',
  '› what is 2+2? answer in one short line',
  '',
  '• 2+2 = 4',
  '',
  '  Worked for 7s • 14:31',
  '',
  '',
  '› Ask a follow-up question',
  '  ftm-flash default · D:\\repo · code-tools · Agent',
  '  Side from main thread · ctrl+/ to switch · ctrl+c to close',
].join('\n');

/** 多轮同屏累积（第二问带 Tip 附加行）。 */
const SCREEN_TWO_ROUNDS = [
  '  Worked for 7s • 14:31',
  '› and 3+3?',
  '• 3+3 = 6',
  '  └ Tip: Use /init to create an AGENTS.md with project-specific guidance.',
  '  Worked for 6s • 14:32',
  '› Ask a follow-up question',
  '  Side from main thread · ctrl+/ to switch · ctrl+c to close',
].join('\n');

/** 跑动中（Working 状态行）。 */
const SCREEN_WORKING = [
  '› and 3+3?',
  '• Working (3s • esc to interrupt)',
  '› Ask a follow-up question',
  '  Side from main thread · ctrl+/ to switch · ctrl+c to close',
].join('\n');

describe('CODEX_SIDE_QUESTION', () => {
  it('validate：单行原文放行；空 / 超长 / 控制字符拒', () => {
    expect(CODEX_SIDE_QUESTION.validate('  what is 2+2?  ')).toEqual({
      ok: true,
      text: 'what is 2+2?',
    });
    expect(CODEX_SIDE_QUESTION.validate('   ').ok).toBe(false);
    expect(CODEX_SIDE_QUESTION.validate('x'.repeat(2001)).ok).toBe(false);
    expect(CODEX_SIDE_QUESTION.validate('two\nlines').ok).toBe(false);
  });

  it('command：问句原样（codex 不用斜杠前缀，问句直接进面板输入框）', () => {
    expect(CODEX_SIDE_QUESTION.command('hi there')).toBe('hi there');
  });

  it('answerOf：恒 null（零落盘零事件，读屏是唯一信源）', () => {
    expect(CODEX_SIDE_QUESTION.answerOf('SubagentStop', {})).toBeNull();
  });

  it('screen.panelOpen：底条指纹判面板在否', () => {
    expect(CODEX_SIDE_QUESTION.screen!.panelOpen(SCREEN_ONE_ROUND)).toBe(true);
    expect(
      CODEX_SIDE_QUESTION.screen!.panelOpen('› Ask Codex to do anything\n  ← for agents · ? for shortcuts'),
    ).toBe(false);
  });

  it('extractAnswer：单轮——锚定问句行取 • 块', () => {
    const got = CODEX_SIDE_QUESTION.screen!.extractAnswer(
      'what is 2+2? answer in one short line',
      '',
      SCREEN_ONE_ROUND,
    );
    expect(got.done).toBe(true);
    expect(got.answer).toBe('2+2 = 4');
  });

  it('extractAnswer：多轮同屏——取最后一条匹配问句的块，Tip 行不进正文', () => {
    const got = CODEX_SIDE_QUESTION.screen!.extractAnswer('and 3+3?', '', SCREEN_TWO_ROUNDS);
    expect(got.done).toBe(true);
    expect(got.answer).toBe('3+3 = 6');
  });

  it('extractAnswer：Working 中 = 未落定（done=false）', () => {
    const got = CODEX_SIDE_QUESTION.screen!.extractAnswer('and 3+3?', '', SCREEN_WORKING);
    expect(got.done).toBe(false);
    expect(got.answer).toBeNull();
  });

  it('extractAnswer：问句还没上屏 = 判不出（done=true、answer=null）', () => {
    const got = CODEX_SIDE_QUESTION.screen!.extractAnswer('never asked', '', SCREEN_ONE_ROUND);
    expect(got.done).toBe(true);
    expect(got.answer).toBeNull();
  });

  it('extractAnswer：面板被用户关掉（无 Side 指纹）后旧屏残留不误认', () => {
    // 用户关面板：底条指纹消失，问句与回答还在屏上——但 Working/Worked 判据
    // 仍按文本走；panelOpen 由编排层单独闸收尾，extractAnswer 不管这件事
    const closed = SCREEN_TWO_ROUNDS.replace('  Side from main thread · ctrl+/ to switch · ctrl+c to close', '');
    const got = CODEX_SIDE_QUESTION.screen!.extractAnswer('and 3+3?', '', closed);
    expect(got.done).toBe(true);
    expect(got.answer).toBe('3+3 = 6');
  });
});
