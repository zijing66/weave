import { describe, it, expect } from 'vitest';
import {
  CLAUDE_REWIND_PICKER,
  isRewindConfirm,
  parseRewindList,
  parseRewindOptions,
  pendingInputOf,
  rewindBusyOf,
  rewindEmptyOf,
  rewindConfirmPrompt,
} from '../rewind-ui.js';

/** 一屏列表（含元数据行、溢出行、current 行与焦点指针）。 */
const LIST_SCREEN = [
  '╭──────────────────────────────────────────────╮',
  '│ Rewind                                        │',
  '│                                              │',
  '│ Restore the code and/or conversation to the   │',
  '│ point before…                                 │',
  '│ ↑ 2 more                                     │',
  '│ 修一下登录页                                  │',
  '│ login.ts +3 -1                                │',
  '│                                              │',
  '│ 加个测试                                      │',
  '│ No code changes                               │',
  '│                                              │',
  '│ ❯ (current)                                   │',
  '│                                              │',
  '╰──────────────────────────────────────────────╯',
  '  enter continue   escape cancel',
  '❯ ',
].join('\n');

/** 活体读屏原样（2026-11-04，119 列无边框、单文件元数据只有 `+N`）。 */
const LIVE_SCREEN = [
  '───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
  '  Rewind',
  '                                                                                                                       ',
  '  Restore the code and/or conversation to the point before…',
  '                                                                                                                       ',
  '  ❯ rewind测试',
  '    conversation.test.ts +35',
  '                                                                                                                       ',
  '    (current)',
  '',
  '',
  '',
  '  Enter to continue · Esc to cancel',
].join('\n');

describe('parseRewindList（/rewind 列表屏）', () => {
  it('条目按屏上顺序出、绝对索引含上方被裁掉的条数、焦点在 current 行', () => {
    const view = parseRewindList(LIST_SCREEN);
    expect(view).not.toBeNull();
    expect(view!.moreAbove).toBe(2);
    expect(view!.moreBelow).toBe(0);
    expect(view!.items).toEqual([
      { index: 2, text: '修一下登录页', focused: false },
      { index: 3, text: '加个测试', focused: false },
      { index: 4, text: null, focused: true }, // (current)
    ]);
  });

  it('元数据行与底部 chrome 不进条目', () => {
    const view = parseRewindList(LIST_SCREEN)!;
    const texts = view.items.map((i) => i.text);
    expect(texts).not.toContain('login.ts +3 -1');
    expect(texts).not.toContain('No code changes');
    expect(texts.some((t) => t?.includes('escape cancel'))).toBe(false);
  });

  it('活体屏：`+35` 单文件元数据不进条目、`(current)` 不被指针行截断、焦点可读', () => {
    const view = parseRewindList(LIVE_SCREEN)!;
    expect(view.moreAbove).toBe(0);
    expect(view.moreBelow).toBe(0);
    expect(view.items).toEqual([
      { index: 0, text: 'rewind测试', focused: true },
      { index: 1, text: null, focused: false },
    ]);
  });

  it('下方溢出计数单独记（moreBelow）', () => {
    const screen = LIST_SCREEN.replace('│ ↑ 2 more', '│ 上一轮的问题').replace(
      '│ ❯ (current)',
      '│ 下一轮\n│ ↓ 4 more\n│ ❯ (current)',
    );
    const view = parseRewindList(screen)!;
    expect(view.moreAbove).toBe(0);
    expect(view.moreBelow).toBe(4);
  });

  it('前会话行不算可回退条目，但仍占索引', () => {
    const screen = LIST_SCREEN.replace(
      '│ ↑ 2 more',
      '│ ↑ 1 more\n│ /resume 0f9c1a2b (previous session)',
    );
    const view = parseRewindList(screen)!;
    expect(view.items[0]).toEqual({ index: 1, text: null, focused: false });
    expect(view.items[1]).toEqual({ index: 2, text: '修一下登录页', focused: false });
  });

  it('首条位置上的「+35 结尾」是用户原文，不当元数据吞掉', () => {
    const screen = ['Rewind', 'Restore the code and/or conversation to the point before…', '  api.ts +35', '  (current)'].join('\n');
    expect(parseRewindList(screen)!.items[0]).toEqual({
      index: 0,
      text: 'api.ts +35',
      focused: false,
    });
  });

  it('没有列表头 / 没有条目 → null', () => {
    expect(parseRewindList('❯ hello')).toBeNull();
    expect(
      parseRewindList('Restore the code and/or conversation to the point before…\n\n❯ '),
    ).toBeNull();
  });
});

describe('确认屏文法', () => {
  /** 活体原样（2026-11-05，无代码档那一路）：描述行 + 编号选项 + `❯` 焦点。 */
  const confirm = (desc: string, code: string, options: string[]): string =>
    [
      '  Rewind',
      '',
      '  Confirm you want to restore to the point before you sent this message:',
      '',
      '  │ 修一下登录页',
      '  │ (4m ago)',
      '',
      `  ${desc}`,
      `  ${code}`,
      '',
      ...options.map((o, i) => (i === 0 ? `  ❯ 1. ${o}` : `    ${i + 1}. ${o}`)),
    ].join('\n');

  const CONV_ONLY = ['Restore conversation', 'Summarize from here', 'Summarize up to here', 'Never mind'];
  const WITH_CODE = ['Restore code and conversation', ...CONV_ONLY];

  it('isRewindConfirm 只认确认屏', () => {
    expect(isRewindConfirm(confirm('The conversation will be forked.', 'The code will be unchanged.', CONV_ONLY))).toBe(true);
    expect(isRewindConfirm(LIST_SCREEN)).toBe(false);
  });

  it('确认屏不解析成列表（两者头都含 `point before`）', () => {
    expect(parseRewindList(confirm('The conversation will be forked.', 'The code will be unchanged.', CONV_ONLY))).toBeNull();
  });

  it('选项表按屏上原样读：文案 + 焦点 + 哪项是「什么都不做」', () => {
    const opts = parseRewindOptions(confirm('The conversation will be forked.', 'The code will be unchanged.', CONV_ONLY))!;
    expect(opts.map((o) => o.label)).toEqual(CONV_ONLY);
    expect(opts.filter((o) => o.selected).map((o) => o.label)).toEqual(['Restore conversation']);
    expect(opts.filter((o) => o.cancel).map((o) => o.label)).toEqual(['Never mind']);
    // 有代码档那一路多一项，weave 不编、照读
    const withCode = parseRewindOptions(confirm('The conversation will be forked.', 'The code will be restored in a.ts.', WITH_CODE))!;
    expect(withCode[0]).toEqual({ label: 'Restore code and conversation', selected: true, cancel: false });
    expect(withCode).toHaveLength(5);
  });

  it('引用块里的正文不误认成选项；不是确认屏 → null', () => {
    const screen = ['  The conversation will be forked.', '  │ 1. 这不是选项', '  ❯ 1. Never mind'].join('\n');
    expect(parseRewindOptions(screen)!.map((o) => o.label)).toEqual(['Never mind']);
    expect(parseRewindOptions(LIST_SCREEN)).toBeNull();
  });

  it('确认屏能读出选中的原文（核对落点）', () => {
    expect(rewindConfirmPrompt(confirm('The conversation will be forked.', 'The code will be unchanged.', CONV_ONLY))).toBe('修一下登录页');
  });

  it('键字节：方向键 / 回车 / Kitty 的 Esc', () => {
    expect(CLAUDE_REWIND_PICKER.keys).toEqual({
      up: '\x1b[A',
      down: '\x1b[B',
      accept: '\r',
      cancel: '\x1b[27u',
      clearInput: '\x15',
    });
    expect(CLAUDE_REWIND_PICKER.openCommand).toBe('/rewind');
  });
});

describe('pendingInputOf（输入框里没发出去的内容）', () => {
  it('取最下面那条 `❯` 行（上面的 `❯ …` 是转录里的用户气泡）', () => {
    const screen = [
      '❯ 上一条用户消息',
      '● 助手回复',
      '───────────────',
      '❯ 草稿内容',
      '───────────────',
      '  ▊ weave',
    ].join('\n');
    expect(pendingInputOf(screen)).toBe('草稿内容');
  });

  it('空框 = 空串；屏上没有输入行 = null', () => {
    expect(pendingInputOf(['❯ 旧消息', '────────', '❯ ', '────────'].join('\n'))).toBe('');
    expect(pendingInputOf('Rewind\n  ❯ (current)')).toBeNull();
  });
});

describe('rewindBusyOf（回合在跑）', () => {
  it('只认屏上的 `esc to interrupt`', () => {
    expect(rewindBusyOf('✻ Working… (esc to interrupt)')).toBe(true);
    expect(rewindBusyOf('❯ ')).toBe(false);
  });
});

describe('rewindEmptyOf（空面板）', () => {
  it('认得「没有可回退的点」那一屏', () => {
    const screen = ['  Rewind', '', '  Nothing to rewind to yet.', '', '  Esc to cancel'].join('\n');
    expect(rewindEmptyOf(screen)).toBe(true);
    expect(CLAUDE_REWIND_PICKER.emptyOf!(screen)).toBe(true);
    expect(rewindEmptyOf(LIVE_SCREEN)).toBe(false);
    expect(parseRewindList(screen)).toBeNull(); // 空面板解析不出条目，只能靠这个判据认
  });
});
