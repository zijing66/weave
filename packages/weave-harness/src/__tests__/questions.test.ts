import { describe, it, expect } from 'vitest';
import { CLAUDE_BLOCKING_PROMPT } from '../claude/questions.js';

/**
 * claude 阻塞问答面契约（实机 claude 2.1.296 定标）：键序按原子下发、多选数字
 * 只勾选（故问题尾部补一记 Tab 推进）、Submit 步只在宿主真给这个 tab 时下发。
 */
describe('claude 阻塞问答面', () => {
  const parse = (questions: unknown): ReturnType<typeof CLAUDE_BLOCKING_PROMPT.parseQuestions> =>
    CLAUDE_BLOCKING_PROMPT.parseQuestions('AskUserQuestion', { questions });

  const single = { question: 'Pick one', header: 'S1', options: [{ label: 'Yes' }, { label: 'No' }] };
  const multi = {
    question: 'Pick many',
    header: 'M1',
    multiSelect: true,
    options: [{ label: 'Alpha' }, { label: 'Beta' }],
  };

  it('选项键序 = 单数字原子（多选数字只勾选，不补 CR）', () => {
    const [q] = parse([multi]);
    expect(q!.options.map((o) => o.keys)).toEqual([['1'], ['2'], ['3'], ['4']]);
    expect(q!.multiSelect).toBe(true);
  });

  it('尾行两模式都有：n+1 Other（多选要先 ↓ 到该行、文本后 Tab+回车）、n+2 Chat', () => {
    const [singleQ] = parse([single]);
    expect(singleQ!.options.map((o) => o.label)).toEqual([
      'Yes',
      'No',
      'Type something',
      'Chat about this',
    ]);
    const singleOther = singleQ!.options[2]!;
    expect(singleOther).toMatchObject({ input: true, textTail: ['\r'] });
    expect(singleOther.textFocus).toBeUndefined();
    expect(singleQ!.options[3]!.chat).toBe(true);

    const [multiQ] = parse([multi]);
    const multiOther = multiQ!.options[2]!;
    // 两行选项 → ↓ 两次到 Other 行；文本后 Tab 移出文本框、回车走到内联 Submit/Next。
    expect(multiOther).toMatchObject({
      input: true,
      textFocus: ['\x1b[B', '\x1b[B'],
      textTail: ['\t', '\r'],
    });
    expect(multiQ!.options[3]).toMatchObject({ label: 'Chat about this', keys: ['4'], chat: true });
  });

  it('Submit 步：一问单选取无，其余取全在末尾（键序 = Tab 到收尾屏 + 数字）', () => {
    expect(parse([single]).some((q) => q.submit)).toBe(false);

    const oneMulti = parse([multi]);
    expect(oneMulti.at(-1)).toMatchObject({
      key: 'AskUserQuestion:submit',
      submit: true,
      options: [{ keys: ['\t', '1'] }, { keys: ['\t', '2'] }],
    });

    const twoSingle = parse([single, { ...single, header: 'S2' }]);
    expect(twoSingle.map((q) => q.submit === true)).toEqual([false, false, true]);
  });

  it('计划确认与权限确认：键序同为原子、单问不追加 Submit 步', () => {
    const plan = CLAUDE_BLOCKING_PROMPT.parseQuestions('ExitPlanMode', {});
    expect(plan).toHaveLength(1);
    expect(plan[0]!.options.map((o) => o.keys)).toEqual([['1'], ['2'], ['3']]);
    const perm = CLAUDE_BLOCKING_PROMPT.permissionQuestion({ toolName: 'Bash', toolInput: {} });
    expect(perm.options.map((o) => o.keys)).toEqual([['1'], ['2'], ['3']]);
  });

  it('解析不出问题面 → OPAQUE 兜底（无选项、无 Submit 步）', () => {
    const opaque = parse([{ question: 'Q' }]);
    expect(opaque).toEqual([
      expect.objectContaining({ key: 'AskUserQuestion:opaque', options: [], multiSelect: false }),
    ]);
    expect(CLAUDE_BLOCKING_PROMPT.parseQuestions('AskUserQuestion', {})[0]!.options).toEqual([]);
  });
});
