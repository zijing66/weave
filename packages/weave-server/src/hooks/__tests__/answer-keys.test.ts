import { describe, it, expect } from 'vitest';
import { CLAUDE_BLOCKING_PROMPT } from '@weavecode/harness';
import { composeAnswerAtoms, type AnswerPick } from '../answer-keys.js';

/**
 * 作答拼装（整 call 一次提交）：面顺序 = 宿主 tab 顺序，未作答/多选勾完要补 Tab
 * 走下一个 tab，输入行的尾键自带推进，chat 与收尾屏结束整 call。用例的期望键序
 * 都是实机（claude 2.1.296）定过的序列。
 */
describe('composeAnswerAtoms', () => {
  const parse = (questions: unknown): ReturnType<typeof CLAUDE_BLOCKING_PROMPT.parseQuestions> =>
    CLAUDE_BLOCKING_PROMPT.parseQuestions('AskUserQuestion', { questions });

  const single = { question: 'Pick one', header: 'S1', options: [{ label: 'Yes' }, { label: 'No' }] };
  const multi = {
    question: 'Pick many',
    header: 'M1',
    multiSelect: true,
    options: [{ label: 'Alpha' }, { label: 'Beta' }],
  };
  const submitKey = 'AskUserQuestion:submit';
  const atomsOf = (questions: unknown, picks: AnswerPick[]): string[] => {
    const out = composeAnswerAtoms(parse(questions), picks);
    if (!out.ok) throw new Error(out.error);
    return out.atoms;
  };

  it('一问单选：单击数字即整 call 完成（无 Submit 步）', () => {
    expect(atomsOf([single], [{ questionKey: 'AskUserQuestion:S1', options: [0] }])).toEqual(['1']);
  });

  it('一问多选：勾选数字 + Tab 走到收尾屏 + Tab 兜底 + 提交数字', () => {
    expect(
      atomsOf([multi], [
        { questionKey: 'AskUserQuestion:M1', options: [0] },
        { questionKey: submitKey, options: [0] },
      ]),
    ).toEqual(['1', '\t', '\t', '1']);
    // 多选勾两个 → 两个数字各自成原子（不能拼成「12」：宿主会当筛选字串）
    expect(
      atomsOf([multi], [
        { questionKey: 'AskUserQuestion:M1', options: [0, 1] },
        { questionKey: submitKey, options: [0] },
      ]),
    ).toEqual(['1', '2', '\t', '\t', '1']);
  });

  it('两问（单选 + 多选）：单选数字自带推进，多选答完补 Tab', () => {
    const questions = [single, { ...multi, header: 'M2' }];
    expect(
      atomsOf(questions, [
        { questionKey: 'AskUserQuestion:S1', options: [1] },
        { questionKey: 'AskUserQuestion:M2', options: [1] },
        { questionKey: submitKey, options: [0] },
      ]),
    ).toEqual(['2', '2', '\t', '\t', '1']);
  });

  it('未作答的问题补一记 Tab 跳过（宿主允许空作答）', () => {
    const questions = [single, { ...single, header: 'S2' }];
    expect(
      atomsOf(questions, [
        { questionKey: 'AskUserQuestion:S2', options: [0] },
        { questionKey: submitKey, options: [0] },
      ]),
    ).toEqual(['\t', '1', '\t', '1']);
  });

  it('输入行：单选 = 数字 + 文本 + 回车；多选 = 数字 + ↓×n + 文本 + Tab + 回车', () => {
    expect(
      atomsOf([single], [{ questionKey: 'AskUserQuestion:S1', options: [2], text: '  自定  ' }]),
    ).toEqual(['3', '自定', '\r']);
    expect(
      atomsOf([multi], [
        { questionKey: 'AskUserQuestion:M1', options: [1, 2], text: '自定' },
        { questionKey: submitKey, options: [0] },
      ]),
    ).toEqual(['2', '3', '\x1b[B', '\x1b[B', '自定', '\t', '\r', '\t', '1']);
  });

  it('chat 行结束整 call：只发到它为止，后面的问题与收尾屏都不打', () => {
    const questions = [single, { ...single, header: 'S2' }];
    expect(
      atomsOf(questions, [
        { questionKey: 'AskUserQuestion:S1', options: [3] },
        { questionKey: 'AskUserQuestion:S2', options: [0] },
        { questionKey: submitKey, options: [0] },
      ]),
    ).toEqual(['4']);
  });

  it('收尾屏可取消（第二项 = Cancel）', () => {
    expect(
      atomsOf([single, { ...single, header: 'S2' }], [
        { questionKey: 'AskUserQuestion:S1', options: [0] },
        { questionKey: 'AskUserQuestion:S2', options: [0] },
        { questionKey: submitKey, options: [1] },
      ]),
    ).toEqual(['1', '1', '\t', '2']);
  });

  it('坏输入：越界下标 / 单选多选 / 输入行缺文本 / 未知问题 / 缺收尾选择 / 空面', () => {
    const questions = [single, { ...multi, header: 'M2' }];
    const fail = (picks: AnswerPick[], face: unknown = questions): string => {
      const out = composeAnswerAtoms(parse(face), picks);
      return out.ok ? 'ok' : out.error;
    };
    expect(fail([{ questionKey: 'AskUserQuestion:S1', options: [9] }])).toMatch(/Invalid option/);
    expect(fail([{ questionKey: 'AskUserQuestion:S1', options: [0, 1] }])).toMatch(/Single-select/);
    expect(fail([{ questionKey: 'AskUserQuestion:S1', options: [2] }])).toMatch(/Text required/);
    expect(fail([{ questionKey: 'AskUserQuestion:nope', options: [0] }])).toMatch(/Unknown question/);
    expect(fail([{ questionKey: 'AskUserQuestion:S1', options: [0] }])).toMatch(
      /Submit choice required/,
    );
    expect(fail([], [{ question: 'Q' }])).toMatch(/no answerable options/);
  });
});
