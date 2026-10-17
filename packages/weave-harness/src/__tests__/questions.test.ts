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
    const perm = CLAUDE_BLOCKING_PROMPT.permissionQuestion({
      toolName: 'Bash',
      toolInput: {},
      message: null,
      permissionMode: null,
    });
    expect(perm.options.map((o) => o.keys)).toEqual([['1'], ['2'], ['3']]);
  });

  it('权限确认按会话形态选面：auto 分类器只有 2 行（第 2 行是拒绝）', () => {
    const auto = CLAUDE_BLOCKING_PROMPT.permissionQuestion({
      toolName: 'Bash',
      toolInput: {},
      message: 'Claude needs your permission',
      permissionMode: 'auto',
    });
    expect(auto.options.map((o) => o.label)).toEqual([
      'Yes, and tell Claude what to do next',
      'No',
    ]);
    // 经典 3 行第 2 行是「别再问」——发给 2 行对话框会变成「拒绝」，键义完全不同。
    const classic = CLAUDE_BLOCKING_PROMPT.permissionQuestion({
      toolName: 'Bash',
      toolInput: {},
      message: null,
      permissionMode: 'default',
    });
    expect(classic.options).toHaveLength(3);
    expect(classic.options[2]!.label).toContain('do differently');
    // 原文提到 classifier 也认作分类器形态（模式 latch 可能还没到）。
    const byMessage = CLAUDE_BLOCKING_PROMPT.permissionQuestion({
      toolName: 'Bash',
      toolInput: {},
      message: 'An automated safety classifier requires confirmation',
      permissionMode: null,
    });
    expect(byMessage.options).toHaveLength(2);
  });

  it('权限确认的正文：宿主原文 + 工具摘要各占一行', () => {
    const face = CLAUDE_BLOCKING_PROMPT.permissionQuestion({
      toolName: 'Bash',
      toolInput: { command: 'rm -rf build' },
      message: 'Claude needs your permission',
      permissionMode: 'default',
    });
    const lines = face.question.split('\n');
    expect(lines[0]).toBe('Claude needs your permission');
    expect(lines[1]).toContain('Bash');
    expect(lines[1]).toContain('rm -rf build');
  });

  it('解析不出问题面 → OPAQUE 兜底（无选项、无 Submit 步）', () => {
    const opaque = parse([{ question: 'Q' }]);
    expect(opaque).toEqual([
      expect.objectContaining({ key: 'AskUserQuestion:opaque', options: [], multiSelect: false }),
    ]);
    expect(CLAUDE_BLOCKING_PROMPT.parseQuestions('AskUserQuestion', {})[0]!.options).toEqual([]);
  });

  describe('预览模式（单选 + 任一选项带 preview）', () => {
    const previewed = {
      question: 'Pick a layout',
      header: 'P1',
      options: [
        { label: 'Sidebar', preview: '|nav| main' },
        { label: 'Stacked', preview: 'nav\nmain' },
      ],
    };

    it('左右分栏面：数字只挪高亮（先挪到别处好让备注挂得上）、提交另给回车；无 Other 行', () => {
      const [q] = parse([previewed]);
      expect(q!.previewMode).toBe(true);
      expect(q!.options.map((o) => o.label)).toEqual([
        'Sidebar',
        'Stacked',
        'Notes:',
        'Chat about this',
      ]);
      expect(q!.options[0]).toMatchObject({
        keys: ['2', '1'],
        commit: ['\r'],
        preview: '|nav| main',
      });
      expect(q!.options[1]).toMatchObject({ keys: ['1', '2'], commit: ['\r'], preview: 'nav\nmain' });
      expect(q!.options[0]!.input).toBeUndefined();
      expect(q!.options[0]!.chat).toBeUndefined();
    });

    it('备注行 = `n` 进文本框（文本非空才发）；聊天行 = 到最后一项再 ↓ 才进得去', () => {
      const [q] = parse([previewed]);
      const notes = q!.options[2]!;
      expect(notes).toMatchObject({
        keys: ['n'],
        label: 'Notes:',
        description: 'press n to add notes',
        input: true,
        textTail: ['\r'],
      });
      expect(notes.textFocus).toBeUndefined();
      expect(q!.options[3]).toMatchObject({
        keys: ['2', '\x1b[B', '\r'],
        label: 'Chat about this',
        chat: true,
      });
    });

    it('右栏原文：无可见内容 = 该选项没有预览（右栏给宿主占位原文）', () => {
      const [q] = parse([
        { ...previewed, options: [{ label: 'A', preview: 'ok' }, { label: 'B', preview: '   ' }] },
      ]);
      expect(q!.options[0]!.preview).toBe('ok');
      expect(q!.options[1]!.preview).toBe('No preview available');
    });

    it('超长 / 含隐形字符的预览 = 不被展示（右栏给宿主原文）', () => {
      const [q] = parse([
        {
          ...previewed,
          options: [
            { label: 'A', preview: 'x'.repeat(2001) },
            { label: 'B', preview: 'ok​' },
          ],
        },
      ]);
      const withheld =
        '(preview cannot be shown in full — compare the option labels and descriptions instead)';
      expect(q!.options[0]!.preview).toBe(withheld);
      expect(q!.options[1]!.preview).toBe(withheld);
    });

    it('多选项带预览也落回旧形态；全程无预览则模式不触发', () => {
      const [multiQ] = parse([{ ...previewed, multiSelect: true }]);
      expect(multiQ!.previewMode).toBe(false);
      expect(multiQ!.options.map((o) => o.label)).toContain('Type something');

      const [plain] = parse([{ ...previewed, options: [{ label: 'A' }, { label: 'B' }] }]);
      expect(plain!.previewMode).toBe(false);
      expect(plain!.options.map((o) => o.label)).toContain('Type something');
    });

    it('单选项：无处挪高亮（备注挂不上选项），故不给备注行、键序只一记数字 + 回车', () => {
      const [q] = parse([{ ...previewed, options: [{ label: 'Only', preview: 'solo' }] }]);
      expect(q!.options.map((o) => o.label)).toEqual(['Only', 'Chat about this']);
      expect(q!.options[0]).toMatchObject({ keys: ['1'], commit: ['\r'] });
      expect(q!.options[1]).toMatchObject({ keys: ['1', '\x1b[B', '\r'], chat: true });
      expect(q!.submit).toBeUndefined();
    });
  });

  describe('模型切换确认（eventQuestion）', () => {
    const face = (eventType: string, raw: unknown) =>
      CLAUDE_BLOCKING_PROMPT.eventQuestion(eventType, raw);
    const warm = {
      from_model: 'claude-sonnet-4-5',
      to_model: 'deepseek-flash',
      prompt_cache_warm: true,
      source: 'command',
    };

    it('PreModelSwitch + 缓存已暖 + 换模型 → 两键问题面（1 切换 / 2 回退）', () => {
      const q = face('PreModelSwitch', warm)!;
      expect(q).not.toBeNull();
      expect(q.key).toBe('model:switch');
      expect(q.header).toBe('Switch model?');
      expect(q.question).toContain('deepseek-flash');
      expect(q.question).toContain('full history gets re-read');
      expect(q.multiSelect).toBe(false);
      expect(q.options.map((o) => o.label)).toEqual([
        'Yes, switch to deepseek-flash',
        'No, go back',
      ]);
      expect(q.options.map((o) => o.keys)).toEqual([['1'], ['2']]);
      // 单问单选 → 无收尾屏（数字即提交）
      expect(q.submit).toBeUndefined();
    });

    it('判据不成立不给问题面（幽灵问题会把键序打进输入框）', () => {
      expect(face('PreModelSwitch', { ...warm, prompt_cache_warm: false })).toBeNull();
      expect(face('PreModelSwitch', { ...warm, to_model: warm.from_model })).toBeNull();
      expect(face('PreModelSwitch', { prompt_cache_warm: true })).toBeNull();
      expect(face('PreModelSwitch', null)).toBeNull();
      expect(face('PreModelSwitch', 'nope')).toBeNull();
    });

    it('非 PreModelSwitch 不给（PostModelSwitch 是落定笔，不是问）', () => {
      expect(face('PostModelSwitch', warm)).toBeNull();
      expect(face('PreToolUse', warm)).toBeNull();
    });
  });
});
