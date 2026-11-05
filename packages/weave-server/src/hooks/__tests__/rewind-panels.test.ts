import { describe, it, expect } from 'vitest';
import { CLAUDE_REWIND_PICKER, type RewindPickerSpec } from '@weavecode/harness';
import { RewindPanels, type RewindDeps, type RewindTiming } from '../delivery/rewind.js';

const TIMING: RewindTiming = {
  openTimeoutMs: 40,
  pollMs: 1,
  keyGapMs: 1,
  confirmTimeoutMs: 60,
  settleTimeoutMs: 60,
  panelTtlMs: 60_000,
};

const K = CLAUDE_REWIND_PICKER.keys;

/** 假列表屏：消息行 + 末行 `(current)`；`focus` 是列表绝对索引（焦点行带 `❯`）。 */
interface ListState {
  items: string[];
  above: number;
  below: number;
  focus: number;
}

/** 假确认屏：描述行 + 编号选项（第 `sel` 项带 `❯`）。 */
interface ConfirmState {
  prompt: string;
  conv: string;
  code: string;
  options: string[];
  sel: number;
}

const renderList = (p: ListState): string =>
  [
    ' │ Rewind',
    ' │ Restore the code and/or conversation to the point before…',
    ...(p.above ? [` │ ↑ ${p.above} more`] : []),
    ...p.items.map((t, i) => ` │ ${p.above + i === p.focus ? '❯ ' : '  '}${t}`),
    ...(p.below ? [` │ ↓ ${p.below} more`] : []),
    ` │ ${p.above + p.items.length === p.focus ? '❯ ' : '  '}(current)`,
    ' ╰──────────────────────────────╯',
  ].join('\n');

const renderConfirm = (c: ConfirmState): string =>
  [
    '  Rewind',
    '',
    '  Confirm you want to restore to the point before you sent this message:',
    '',
    `  │ ${c.prompt}`,
    '  │ (4m ago)',
    '',
    `  ${c.conv}`,
    `  ${c.code}`,
    '',
    ...c.options.map((o, i) => (i === c.sel ? `  ❯ ${i + 1}. ${o}` : `    ${i + 1}. ${o}`)),
  ].join('\n');

const FORKED = 'The conversation will be forked.';
const CODE_UNCHANGED = 'The code will be unchanged.';
const CODE_RESTORED = 'The code will be restored in a.ts.';
const CONV_UNCHANGED = 'The conversation will be unchanged.';

/** 活体原样：没有代码档时宿主给的就是这四项。 */
const CONV_ONLY = ['Restore conversation', 'Summarize from here', 'Summarize up to here', 'Never mind'];
const WITH_CODE = ['Restore code and conversation', ...CONV_ONLY];

const list = (items: string[], extra: Partial<ListState> = {}): ListState => ({
  items,
  above: 0,
  below: 0,
  focus: (extra.above ?? 0) + items.length,
  ...extra,
});

/** 开面板前的屏（输入框是最下面那条 `❯` 行）。 */
const composer = (text: string): string =>
  ['───────────────', `❯ ${text}`.trimEnd(), '───────────────', '  ▊ weave'].join('\n');

interface FakeScreen {
  screen: string;
  keys: string[];
  sent: string[];
  list: ListState | null;
  /** 进确认屏后列表被盖住，Esc 退回来时恢复（活体实测：确认屏上的 Esc 只退回列表）。 */
  listBackup: ListState | null;
  confirm: ConfirmState | null;
}

interface TerminalOpts {
  /** 面板一开就长这样（省略 = `/rewind` 没打开任何东西）。 */
  open?: ListState;
  /** 开出来的不是列表而是别的一屏（如空面板）——给了就整屏替换。 */
  openScreen?: string;
  /** 开面板前输入框里的内容（省略 = 空）。 */
  pendingInput?: string;
  /** 开面板前的整屏（省略 = 空输入框的常态屏）。 */
  initialScreen?: string;
  /** 列表屏回车后画出来的确认屏（省略 = 什么都不变，用来验「确认屏没出现」）。 */
  confirm?: Omit<ConfirmState, 'sel'> & { sel?: number };
  /** 模拟「Up 键没打进去」：焦点不动。 */
  ignoreUp?: boolean;
  /** 模拟「Down 键没打进去」。 */
  ignoreDown?: boolean;
  /** 提交后面板关闭时，宿主回填进输入框的原文（省略 = 输入框保持空）。 */
  refillOnAccept?: string;
}

/** 会「应键变屏」的假终端：开面板 → 列表（焦点随上下键走）；列表回车 → 确认屏（选项随上下键走）。 */
function makeTerminal(opts: TerminalOpts) {
  const fake: FakeScreen = {
    screen: opts.initialScreen ?? (opts.pendingInput ? composer(opts.pendingInput) : '❯ '),
    keys: [],
    sent: [],
    list: null,
    listBackup: null,
    confirm: null,
  };
  const repaint = (): void => {
    if (fake.confirm) fake.screen = renderConfirm(fake.confirm);
    else if (fake.list) fake.screen = renderList(fake.list);
  };
  const closeAll = (): void => {
    fake.list = null;
    fake.listBackup = null;
    fake.confirm = null;
    fake.screen = '❯ ';
  };
  const terminal = {
    getPaneText: async () => fake.screen,
    sendText: async (_pane: string, text: string) => {
      fake.sent.push(text);
      fake.list = opts.open ? { ...opts.open, items: [...opts.open.items] } : null;
      fake.confirm = null;
      fake.screen = opts.openScreen ?? (fake.list ? renderList(fake.list) : '❯ ');
    },
    sendKeys: async (_pane: string, key: string) => {
      fake.keys.push(key);
      if (key === K.clearInput) {
        fake.screen = composer('');
        return;
      }
      if (key === K.cancel) {
        // 确认屏上的一记 Esc 只退回列表屏（活体实测），列表屏上才真关
        if (fake.confirm && fake.listBackup) {
          fake.confirm = null;
          fake.list = fake.listBackup;
          repaint();
          return;
        }
        closeAll();
        return;
      }
      if (fake.confirm) {
        const c = fake.confirm;
        if (key === K.up && !opts.ignoreUp) c.sel = Math.max(0, c.sel - 1);
        if (key === K.down && !opts.ignoreDown) c.sel = Math.min(c.options.length - 1, c.sel + 1);
        if (key === K.accept) {
          closeAll();
          if (opts.refillOnAccept !== undefined) fake.screen = composer(opts.refillOnAccept);
          return;
        }
        repaint();
        return;
      }
      if (fake.list) {
        const p = fake.list;
        const last = p.above + p.items.length;
        if (key === K.up) {
          if (!opts.ignoreUp) p.focus = Math.max(p.above, p.focus - 1);
          repaint();
          return;
        }
        if (key === K.down) {
          if (!opts.ignoreDown) p.focus = Math.min(last, p.focus + 1);
          repaint();
          return;
        }
        if (key === K.accept) {
          const text = p.focus < last ? p.items[p.focus - p.above]! : null;
          if (text === null || !opts.confirm) {
            closeAll();
            return;
          }
          fake.listBackup = p;
          fake.list = null;
          fake.confirm = { ...opts.confirm, prompt: opts.confirm.prompt || text, sel: opts.confirm.sel ?? 0 };
          repaint();
          return;
        }
      }
    },
  };
  return { terminal, fake };
}

const deps = (picker: RewindPickerSpec | null, terminal: object): RewindDeps => ({
  target: async () => ({ ok: true, terminal: terminal as never, paneId: 'p1' }),
  pickerOf: () => picker,
});

const convConfirm = (prompt: string, sel = 0) => ({
  prompt,
  conv: FORKED,
  code: CODE_UNCHANGED,
  options: CONV_ONLY,
  sel,
});

describe('RewindPanels.open', () => {
  it('开面板 → 解析当前一屏（索引含上方被裁掉的条数、焦点在 current 行）', async () => {
    const { terminal, fake } = makeTerminal({ open: list(['改一下登录页'], { above: 2 }) });
    const panels = new RewindPanels(deps(CLAUDE_REWIND_PICKER, terminal), TIMING);
    const result = await panels.open('s1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fake.sent).toEqual(['/rewind']);
    expect(result.view.moreAbove).toBe(2);
    expect(result.view.items).toEqual([
      { index: 2, text: '改一下登录页', focused: false },
      { index: 3, text: null, focused: true },
    ]);
  });

  it('同一会话并发开两次只敲一次命令（StrictMode 会把挂载 effect 跑两遍）', async () => {
    const { terminal, fake } = makeTerminal({ open: list(['改一下登录页']) });
    const panels = new RewindPanels(deps(CLAUDE_REWIND_PICKER, terminal), TIMING);
    const [a, b] = await Promise.all([panels.open('s1'), panels.open('s1')]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    expect(fake.sent).toEqual(['/rewind']);
  });

  it('面板还开着时再开一次 → 回同一份视图，不重发命令', async () => {
    const { terminal, fake } = makeTerminal({ open: list(['改一下登录页']) });
    const panels = new RewindPanels(deps(CLAUDE_REWIND_PICKER, terminal), TIMING);
    await panels.open('s1');
    await expect(panels.open('s1')).resolves.toMatchObject({ ok: true });
    expect(fake.sent).toEqual(['/rewind']);
  });

  it('屏上已经开着面板（我们自己没记录：用户开的 / 重启丢了状态）→ 直接收下，不重发命令', async () => {
    const { terminal, fake } = makeTerminal({ initialScreen: renderList(list(['改一下登录页'])) });
    const panels = new RewindPanels(deps(CLAUDE_REWIND_PICKER, terminal), TIMING);
    const result = await panels.open('s1');
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.view.items.map((i) => i.text)).toEqual(['改一下登录页', null]);
    expect(fake.sent).toEqual([]);
    expect(fake.keys).toEqual([]);
  });

  it('确认屏已经开着 → 409，一个键都不打', async () => {
    const { terminal, fake } = makeTerminal({
      initialScreen: renderConfirm({ ...convConfirm('改一下登录页'), sel: 0 }),
    });
    const panels = new RewindPanels(deps(CLAUDE_REWIND_PICKER, terminal), TIMING);
    await expect(panels.open('s1')).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: expect.stringContaining('确认屏'),
    });
    expect(fake.sent).toEqual([]);
    expect(fake.keys).toEqual([]);
  });

  it('没有 picker 面 → 409，一个键都不打', async () => {
    const { terminal, fake } = makeTerminal({});
    const panels = new RewindPanels(deps(null, terminal), TIMING);
    await expect(panels.open('s1')).resolves.toMatchObject({ ok: false, status: 409 });
    expect(fake.sent).toEqual([]);
    expect(fake.keys).toEqual([]);
  });

  it('面板一直没出现 → 409，只清输入框（不按 Esc：那会中断正在跑的回合）', async () => {
    const { terminal, fake } = makeTerminal({});
    const panels = new RewindPanels(deps(CLAUDE_REWIND_PICKER, terminal), TIMING);
    await expect(panels.open('s1')).resolves.toMatchObject({ ok: false, status: 409 });
    expect(fake.keys).toEqual([K.clearInput]);
  });

  it('面板文法没认出来但面板确实开着 → 按 Esc 关掉', async () => {
    const { terminal, fake } = makeTerminal({
      initialScreen: composer(''),
      open: list(['改一下登录页'], { above: 0 }),
    });
    const panels = new RewindPanels(deps({ ...CLAUDE_REWIND_PICKER, parseList: () => null }, terminal), TIMING);
    await expect(panels.open('s1')).resolves.toMatchObject({ ok: false, status: 409 });
    expect(fake.keys).toEqual([K.cancel]);
  });

  it('空面板（Nothing to rewind to yet）→ 409 并 Esc 关掉（空面板也是面板）', async () => {
    const { terminal, fake } = makeTerminal({
      initialScreen: composer(''),
      open: list([]),
      openScreen: ['  Rewind', '', '  Nothing to rewind to yet.', '', '  Esc to cancel'].join('\n'),
    });
    const panels = new RewindPanels(deps(CLAUDE_REWIND_PICKER, terminal), TIMING);
    await expect(panels.open('s1')).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: expect.stringContaining('没有可回退的点'),
    });
    expect(fake.keys).toEqual([K.cancel]);
  });

  it('屏上挂着 `esc to interrupt`（回合在跑）→ 409，一个键都不打', async () => {
    const { terminal, fake } = makeTerminal({
      initialScreen: composer('') + '\n  esc to interrupt\n',
      open: list(['改一下登录页']),
    });
    const panels = new RewindPanels(deps(CLAUDE_REWIND_PICKER, terminal), TIMING);
    await expect(panels.open('s1')).resolves.toMatchObject({ ok: false, status: 409 });
    expect(fake.sent).toEqual([]);
    expect(fake.keys).toEqual([]);
  });
});

describe('RewindPanels.open：输入框里有字', () => {
  it('不认识的草稿 → 409，不敲任何东西（命令会被当普通 prompt 提交）', async () => {
    const { terminal, fake } = makeTerminal({
      open: list(['改一下登录页']),
      pendingInput: '写了一半的草稿',
    });
    const panels = new RewindPanels(deps(CLAUDE_REWIND_PICKER, terminal), TIMING);
    await expect(panels.open('s1')).resolves.toMatchObject({ ok: false, status: 409 });
    expect(fake.sent).toEqual([]);
    expect(fake.keys).toEqual([]);
  });

  it('正是上次回退后宿主回填的原文 → 先 Ctrl+U 清掉再开面板', async () => {
    const { terminal, fake } = makeTerminal({
      open: list(['改一下登录页']),
      confirm: convConfirm(''),
    });
    const panels = new RewindPanels(deps(CLAUDE_REWIND_PICKER, terminal), TIMING);
    await panels.open('s1');
    await panels.prepare('s1', 0);
    await panels.commit('s1', 'Restore conversation');
    fake.keys.length = 0;
    fake.screen = composer('改一下登录页');
    await expect(panels.open('s1')).resolves.toMatchObject({ ok: true });
    expect(fake.keys).toEqual([K.clearInput]);
    expect(fake.sent).toEqual(['/rewind', '/rewind']);
  });
});

describe('RewindPanels.prepare', () => {
  const opened = async (opts: TerminalOpts) => {
    const { terminal, fake } = makeTerminal(opts);
    const panels = new RewindPanels(deps(CLAUDE_REWIND_PICKER, terminal), TIMING);
    await panels.open('s1');
    return { panels, fake };
  };

  it('按索引打 Up（焦点先核对）→ 进确认屏 → 读回宿主给的那几项', async () => {
    const { panels, fake } = await opened({
      open: list(['改一下登录页', '加个测试']),
      confirm: convConfirm('加个测试'),
    });
    const result = await panels.prepare('s1', 1);
    expect(result).toMatchObject({ ok: true, prompt: '加个测试' });
    if (!result.ok) return;
    expect(result.options.map((o) => o.label)).toEqual(CONV_ONLY);
    expect(result.options.find((o) => o.selected)?.label).toBe('Restore conversation');
    // total=3、目标索引 1 ⇒ Ups = 3-1-1 = 1
    expect(fake.keys).toEqual([K.up, K.accept]);
  });

  it('焦点已经停在目标条目上（面板被 Esc 退回、焦点留在原处）→ 不打方向键，直接回车', async () => {
    const { panels, fake } = await opened({
      // 列表打开时焦点就在第一条上（不是 current 行）
      open: list(['改一下登录页', '加个测试'], { focus: 0, above: 0 }),
      confirm: convConfirm('改一下登录页'),
    });
    const result = await panels.prepare('s1', 0);
    expect(result).toMatchObject({ ok: true, prompt: '改一下登录页' });
    expect(fake.keys).toEqual([K.accept]);
  });

  it('焦点在目标上方时要往下走', async () => {
    const { panels, fake } = await opened({
      open: list(['改一下登录页', '加个测试'], { focus: 0 }),
      confirm: convConfirm('加个测试'),
    });
    await expect(panels.prepare('s1', 1)).resolves.toMatchObject({ ok: true });
    expect(fake.keys).toEqual([K.down, K.accept]);
  });

  it('有代码档时也照读（不自己编）', async () => {
    const { panels } = await opened({
      open: list(['改一下登录页']),
      confirm: { prompt: '', conv: FORKED, code: CODE_RESTORED, options: WITH_CODE },
    });
    const result = await panels.prepare('s1', 0);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.options.map((o) => o.label)).toEqual(WITH_CODE);
  });

  it('焦点没落到选中的那条（Up 没打进去）→ 409 并 Esc，绝不回车', async () => {
    const { panels, fake } = await opened({
      open: list(['改一下登录页', '加个测试']),
      ignoreUp: true,
      confirm: convConfirm('加个测试'),
    });
    await expect(panels.prepare('s1', 1)).resolves.toMatchObject({ ok: false, status: 409 });
    expect(fake.keys).toEqual([K.up, K.cancel]);
  });

  it('面板内容变了（期间有消息打进来）→ 409 并 Esc，不按回车', async () => {
    const { panels, fake } = await opened({
      open: list(['改一下登录页']),
      confirm: convConfirm('改一下登录页'),
    });
    fake.screen = renderList(list(['改一下登录页', '新来的一条']));
    await expect(panels.prepare('s1', 0)).resolves.toMatchObject({ ok: false, status: 409 });
    expect(fake.keys).toEqual([K.cancel]);
  });

  it('确认屏没出现（回车没打进去）→ 409，退出后不留面板', async () => {
    const { panels, fake } = await opened({ open: list(['改一下登录页']) });
    await expect(panels.prepare('s1', 0)).resolves.toMatchObject({ ok: false, status: 409 });
    expect(fake.list).toBeNull();
    expect(fake.confirm).toBeNull();
  });

  it('确认屏里的原文对不上选中的那条 → 409 并 Esc', async () => {
    const { panels, fake } = await opened({
      open: list(['改一下登录页']),
      confirm: convConfirm('完全不同的内容'),
    });
    await expect(panels.prepare('s1', 0)).resolves.toMatchObject({ ok: false, status: 409 });
    expect(fake.keys).toContain(K.cancel);
  });

  it('(current) 行不可选；没开过面板的会话直接 409', async () => {
    const { panels } = await opened({ open: list(['改一下登录页']) });
    await expect(panels.prepare('s1', 1)).resolves.toMatchObject({ ok: false, status: 400 });
    const { terminal } = makeTerminal({});
    const fresh = new RewindPanels(deps(CLAUDE_REWIND_PICKER, terminal), TIMING);
    await expect(fresh.prepare('s1', 0)).resolves.toMatchObject({ ok: false, status: 409 });
  });
});

describe('RewindPanels.commit', () => {
  const prepared = async (opts: TerminalOpts, index = 0) => {
    const { terminal, fake } = makeTerminal(opts);
    const panels = new RewindPanels(deps(CLAUDE_REWIND_PICKER, terminal), TIMING);
    await panels.open('s1');
    await panels.prepare('s1', index);
    return { panels, fake };
  };

  it('按屏上文案往下走两档 → 核对焦点 → 提交', async () => {
    const { panels, fake } = await prepared({
      open: list(['改一下登录页']),
      confirm: convConfirm(''),
    });
    await expect(panels.commit('s1', 'Summarize up to here')).resolves.toMatchObject({
      ok: true,
      prompt: '改一下登录页',
    });
    expect(fake.keys.slice(-3)).toEqual([K.down, K.down, K.accept]);
  });

  it('目标项在当前焦点上方 → 打 Up 回去', async () => {
    const { panels, fake } = await prepared({
      open: list(['改一下登录页']),
      confirm: { ...convConfirm(''), options: WITH_CODE, sel: 2 },
    });
    await expect(panels.commit('s1', 'Restore code and conversation')).resolves.toMatchObject({
      ok: true,
      prompt: '改一下登录页',
    });
    expect(fake.keys.slice(-3)).toEqual([K.up, K.up, K.accept]);
  });

  it('宿主没给这个选项 → 400，不动面板', async () => {
    const { panels, fake } = await prepared({ open: list(['改一下登录页']), confirm: convConfirm('') });
    await expect(panels.commit('s1', 'Restore code and conversation')).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
    expect(fake.keys).toEqual([K.up, K.accept]);
  });

  it('「Never mind」不是可选动作（前端不摆；直接调也不认）', async () => {
    const { panels } = await prepared({ open: list(['改一下登录页']), confirm: convConfirm('') });
    await expect(panels.commit('s1', 'Never mind')).resolves.toMatchObject({ ok: false, status: 400 });
  });

  it('Down 没打进去（焦点没到目标项）→ 409 并 Esc，绝不回车', async () => {
    const { panels, fake } = await prepared({
      open: list(['改一下登录页']),
      confirm: convConfirm(''),
      ignoreDown: true,
    });
    await expect(panels.commit('s1', 'Summarize from here')).resolves.toMatchObject({
      ok: false,
      status: 409,
    });
    expect(fake.keys.slice(-1)).toEqual([K.cancel]);
  });

  it('确认屏没了（有人按了 Esc）→ 409，屏上本来就没面板就不补键', async () => {
    const { panels, fake } = await prepared({ open: list(['改一下登录页']), confirm: convConfirm('') });
    fake.screen = '❯ ';
    fake.confirm = null;
    fake.list = null;
    const before = fake.keys.length;
    await expect(panels.commit('s1', 'Restore conversation')).resolves.toMatchObject({
      ok: false,
      status: 409,
    });
    expect(fake.keys.length).toBe(before);
  });

  it('提交后宿主回填原文 → 用 Ctrl+U 清掉（不清 Ctrl+C：那是中断）', async () => {
    const { panels, fake } = await prepared({
      open: list(['改一下登录页']),
      confirm: convConfirm(''),
      refillOnAccept: '改一下登录页',
    });
    await expect(panels.commit('s1', 'Restore conversation')).resolves.toMatchObject({
      ok: true,
      cleared: true,
    });
    expect(fake.keys).toContain(K.clearInput);
    expect(fake.keys).not.toContain('\x03');
  });

  it('用户已经接着打了新字 → 一个字都不清（cleared:false）', async () => {
    const { panels, fake } = await prepared({
      open: list(['改一下登录页']),
      confirm: convConfirm(''),
      refillOnAccept: '改一下登录页，再加个测试',
    });
    await expect(panels.commit('s1', 'Restore conversation')).resolves.toMatchObject({
      ok: true,
      cleared: false,
    });
    expect(fake.keys).not.toContain(K.clearInput);
  });

  it('没 prepare 过就提交 → 409', async () => {
    const { terminal } = makeTerminal({ open: list(['改一下登录页']) });
    const panels = new RewindPanels(deps(CLAUDE_REWIND_PICKER, terminal), TIMING);
    await expect(panels.commit('s1', 'Restore conversation')).resolves.toMatchObject({
      ok: false,
      status: 409,
    });
  });
});

describe('RewindPanels.cancel', () => {
  it('打开后取消 → 打 Esc 并清状态', async () => {
    const { terminal, fake } = makeTerminal({ open: list(['改一下登录页']) });
    const panels = new RewindPanels(deps(CLAUDE_REWIND_PICKER, terminal), TIMING);
    await panels.open('s1');
    await expect(panels.cancel('s1')).resolves.toEqual({ ok: true });
    expect(fake.keys).toEqual([K.cancel]);
    await expect(panels.commit('s1', 'Restore conversation')).resolves.toMatchObject({ ok: false, status: 409 });
  });

  it('确认屏上取消要两记 Esc（第一记只退回列表屏，活体实测）', async () => {
    const { terminal, fake } = makeTerminal({ open: list(['改一下登录页']), confirm: convConfirm('') });
    const panels = new RewindPanels(deps(CLAUDE_REWIND_PICKER, terminal), TIMING);
    await panels.open('s1');
    await panels.prepare('s1', 0);
    fake.keys.length = 0;
    await expect(panels.cancel('s1')).resolves.toEqual({ ok: true });
    expect(fake.keys).toEqual([K.cancel, K.cancel]);
    expect(fake.list).toBeNull();
    expect(fake.confirm).toBeNull();
  });

  it('没记录状态但屏上还开着面板（daemon 重启）也能收干净', async () => {
    const { terminal, fake } = makeTerminal({
      initialScreen: renderConfirm({ ...convConfirm('改一下登录页'), sel: 0 }),
    });
    fake.confirm = { ...convConfirm('改一下登录页'), sel: 0 };
    const panels = new RewindPanels(deps(CLAUDE_REWIND_PICKER, terminal), TIMING);
    await expect(panels.cancel('s1')).resolves.toEqual({ ok: true });
    expect(fake.confirm).toBeNull();
  });
});
