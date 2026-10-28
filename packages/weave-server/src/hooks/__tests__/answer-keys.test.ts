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

  it('plan 反馈行（ExitPlanMode 第 3 项）：数字 + 文本 + shift+tab 提交', () => {
    const plan = CLAUDE_BLOCKING_PROMPT.parseQuestions('ExitPlanMode', {});
    const feedback = plan[0]!.options.findIndex((o) => o.input);
    if (feedback < 0) return; // 本机默认模式是 2 行面（无反馈行）——形态断言在 harness 测试
    const out = composeAnswerAtoms(plan, [
      { questionKey: 'ExitPlanMode:approve', options: [feedback], text: '先别动数据库' },
    ]);
    if (!out.ok) throw new Error(out.error);
    expect(out.atoms).toEqual(['3', '先别动数据库', '\x1b[Z']);
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

  describe('预览模式（单选 + 选项带 preview）', () => {
    const previewed = {
      question: 'Pick a layout',
      header: 'P1',
      options: [
        { label: 'Sidebar', preview: '|nav| main' },
        { label: 'Stacked', preview: 'nav\nmain' },
      ],
    };

    it('只选选项：挪高亮的两记数字 + 回车（提交靠选项的 commit）', () => {
      expect(atomsOf([previewed], [{ questionKey: 'AskUserQuestion:P1', options: [1] }])).toEqual([
        '1',
        '2',
        '\r',
      ]);
    });

    it('选项 + 备注：挪高亮 → `n` → 文本 → 回车（备注挂在挪过高亮的选项上）', () => {
      expect(
        atomsOf([previewed], [
          { questionKey: 'AskUserQuestion:P1', options: [0, 2], text: '  再宽点  ' },
        ]),
      ).toEqual(['2', '1', 'n', '再宽点', '\r']);
    });

    it('只填备注（不选选项）：`n` + 文本 + 回车——宿主自己答成 (notes only)', () => {
      expect(
        atomsOf([previewed], [{ questionKey: 'AskUserQuestion:P1', options: [2], text: '偏窄' }]),
      ).toEqual(['n', '偏窄', '\r']);
    });

    it('聊天行：到最后一项的 ↓ + 回车结束整 call（后面的问题不再打）', () => {
      const questions = [previewed, { ...single, header: 'S2' }];
      expect(
        atomsOf(questions, [
          { questionKey: 'AskUserQuestion:P1', options: [3] },
          { questionKey: 'AskUserQuestion:S2', options: [0] },
          { questionKey: submitKey, options: [0] },
        ]),
      ).toEqual(['2', '\x1b[B', '\r']);
    });

    it('单选数只点数选项行：选了备注行不算第二选；备注行缺文本照样拒', () => {
      const out = composeAnswerAtoms(
        parse([previewed]),
        [{ questionKey: 'AskUserQuestion:P1', options: [0, 1] }],
      );
      expect(out.ok ? 'ok' : out.error).toMatch(/Single-select/);
      const noText = composeAnswerAtoms(
        parse([previewed]),
        [{ questionKey: 'AskUserQuestion:P1', options: [0, 2] }],
      );
      expect(noText.ok ? 'ok' : noText.error).toMatch(/Text required/);
    });
  });
});
