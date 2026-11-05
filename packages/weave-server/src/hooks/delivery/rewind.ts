import type {
  RewindPickerOption,
  RewindPickerSpec,
  RewindPickerView,
  RewindPoint,
} from '@weavecode/harness';
import type { AnswerResult, PromptTerminal } from '../message-deliverer.js';
import { sleep } from './keys.js';

/**
 * `/rewind` 面板驱动：宿主把回退做成一个**只能读屏 + 打键**的模态界面
 * （列表屏 → 确认屏），故 weave 的流程是「开面板 → 读屏解析 → 按索引打 Up →
 * 回车 → 逐档选范围 → 回车」，每一步都以屏上文本为证据，**任何一步对不上就
 * 打 Esc 退出并如实报错**——回退会 fork 对话，落错点是不可逆的，绝不盲按。
 *
 * 状态只活在这个进程里（面板开着时用户还能在 TUI 里操作，故 commit 前必须
 * 重读屏比对；面板内容一变即拒绝并要求重开）。
 */

/** 时序（测试可注入，缩短到毫秒级）。 */
export interface RewindTiming {
  /** 面板打开后最多等多久（宿主画面板 + 我们轮询读屏）。 */
  openTimeoutMs: number;
  /** 读屏轮询间隔。 */
  pollMs: number;
  /** 连打键的原子间隔（与作答同一量级：宿主会把握手当粘贴）。 */
  keyGapMs: number;
  /** 确认屏出现的最长等待（回车后宿主画下一屏）。 */
  confirmTimeoutMs: number;
  /** 回退落定（面板消失）的最长等待。 */
  settleTimeoutMs: number;
  /** 面板状态存活期：过期即当没开（用户可能已自己关掉）。 */
  panelTtlMs: number;
}

const DEFAULT_TIMING: RewindTiming = {
  openTimeoutMs: 5_000,
  pollMs: 150,
  keyGapMs: 60,
  confirmTimeoutMs: 3_000,
  settleTimeoutMs: 20_000,
  panelTtlMs: 120_000,
};

interface PanelState {
  paneId: string;
  /** **屏上**读到的结构（开面板那一刻；prepare 重读屏与它比对）。 */
  view: RewindPickerView;
  /** 转录驱动的条目全文（对账通过时才有）；null = 回落屏上数据。 */
  points: RewindPoint[] | null;
  at: number;
}

/** 已进确认屏：等用户从宿主给的选项里挑一项。 */
interface PreparedState {
  paneId: string;
  prompt: string;
  options: RewindPickerOption[];
  at: number;
}

export interface RewindDeps {
  /** 会话 → 可读屏可击键的 pane（与作答/中断同一条落点解析）。 */
  target(
    sessionId: string,
    action: string,
  ): Promise<
    { ok: true; terminal: PromptTerminal; paneId: string } | Extract<AnswerResult, { ok: false }>
  >;
  /** 该会话的回退面板文法（harness 能力面）；null = 这个 harness 没有驱动面。 */
  pickerOf(sessionId: string): RewindPickerSpec | null;
  /**
   * 转录里「当前分支上的用户 prompt」序列（内容与索引的唯一真源）。
   * null = 这个 harness 没有该面 / 转录读不到 → 回落读屏。
   */
  pointsOf(sessionId: string): Promise<RewindPoint[] | null>;
}

export type RewindOpenResult =
  | { ok: true; view: RewindPickerView }
  | Extract<AnswerResult, { ok: false }>;

export type RewindPrepareResult =
  | { ok: true; prompt: string; options: RewindPickerOption[] }
  | Extract<AnswerResult, { ok: false }>;

export type RewindCommitResult =
  | { ok: true; prompt: string; cleared: boolean }
  | Extract<AnswerResult, { ok: false }>;

const fail = (status: 400 | 404 | 409, error: string): Extract<AnswerResult, { ok: false }> => ({
  ok: false,
  status,
  error,
});

/** 归一化（剥时间尾巴与空白）后比对两屏列表——只有完全一致才敢按索引打键。 */
function sameView(a: RewindPickerView, b: RewindPickerView): boolean {
  if (a.moreAbove !== b.moreAbove || a.moreBelow !== b.moreBelow) return false;
  if (a.items.length !== b.items.length) return false;
  return a.items.every(
    (it, i) =>
      it.index === b.items[i]!.index &&
      it.text === b.items[i]!.text &&
      it.focused === b.items[i]!.focused,
  );
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

export class RewindPanels {
  private readonly panels = new Map<string, PanelState>();
  /** 上次回退成功后宿主回填进输入框的那条原文（只用来判断「框里这份是我们留的」）。 */
  private readonly refilled = new Map<string, { text: string; at: number }>();
  /** 正在开面板的请求（并发合并）。 */
  private readonly opening = new Map<string, Promise<RewindOpenResult>>();
  /** 已进确认屏、等选选项。 */
  private readonly prepared = new Map<string, PreparedState>();

  constructor(
    private readonly deps: RewindDeps,
    private readonly timing: RewindTiming = DEFAULT_TIMING,
  ) {}

  /**
   * 开面板并解析当前一屏；面板没出现/解析不出 → 409（不留半开状态）。
   * **同一会话并发合并**：`sendText` 是「粘贴 + 回车」，多开一次就真在 TUI 里多敲一条
   * `/rewind`（前端的 StrictMode 会把挂载 effect 跑两遍）。
   */
  async open(sessionId: string): Promise<RewindOpenResult> {
    const inflight = this.opening.get(sessionId);
    if (inflight) return inflight;
    const p = this.openOnce(sessionId);
    this.opening.set(sessionId, p);
    try {
      return await p;
    } finally {
      this.opening.delete(sessionId);
    }
  }

  private async openOnce(sessionId: string): Promise<RewindOpenResult> {
    const spec = this.deps.pickerOf(sessionId);
    if (!spec) return fail(409, '这个 harness 的回退只能在终端里操作');
    const target = await this.deps.target(sessionId, '打开回退面板');
    if (!target.ok) return target;
    if (typeof target.terminal.getPaneText !== 'function') {
      return fail(409, '当前终端后端读不到屏幕，无法确认回退面板状态');
    }
    const read = async (): Promise<string | null> => {
      try {
        return (await target.terminal.getPaneText!(target.paneId)) ?? null;
      } catch {
        return null;
      }
    };
    const before = await read();
    if (before === null) return fail(409, '读不到终端屏幕，无法确认输入框状态');
    // 屏上已经是列表 → 直接收下，**绝不重发命令**：第二次的「粘贴 + 回车」落在已开着的
    // 面板上（回车会选中焦点行），比多一条历史更糟。这样也认「用户自己在 TUI 里开的」
    // 与「daemon 重启后状态丢了但面板还开着」——此时屏上的 `❯` 是面板焦点行，
    // 若先问输入框就会把它当成没发出去的草稿。
    const onScreen = spec.parseList(before);
    if (onScreen) {
      const resolved = await this.resolveView(sessionId, onScreen);
      this.prepared.delete(sessionId);
      this.panels.set(sessionId, {
        paneId: target.paneId,
        view: onScreen,
        points: resolved.points,
        at: Date.now(),
      });
      return { ok: true, view: resolved.view };
    }
    // 面板开着但空：Esc 关掉，如实说没有可退的点
    if (spec.emptyOf?.(before)) {
      await target.terminal.sendKeys(target.paneId, spec.keys.cancel).catch(() => {});
      return fail(409, '没有可回退的点（这个会话的历史已经在别处了）');
    }
    // 确认屏开着（有人已经在选选项了）：不打键，让用户在终端里收尾
    if (spec.parseConfirm(before) !== null) {
      return fail(409, '回退的确认屏已经开着，先在终端里处理完它');
    }
    // 命令只能从空输入框敲：框里有字时 `/rewind` 会接在后面、整条被当普通 prompt 提交
    // 回合在跑时命令会被当普通消息排队（面板不会开，之后还会自己发出去）
    if (spec.busyOf?.(before)) return fail(409, '会话正在跑回合，等它停下来再回退');
    const pending = spec.pendingInputOf?.(before) ?? null;
    if (pending) {
      const refilled = this.refilled.get(sessionId);
      if (
        refilled &&
        norm(pending) === norm(refilled.text) &&
        Date.now() - refilled.at <= this.timing.panelTtlMs
      ) {
        // 上一次回退后宿主回填的那条原文：再退一次它本来也要作废，清掉即可
        await target.terminal.sendKeys(target.paneId, spec.keys.clearInput).catch(() => {});
        await sleep(this.timing.keyGapMs);
      } else {
        return fail(
          409,
          `终端输入框里还有没发送的内容（${pending.slice(0, 24)}），先在终端里清空或发送它再回退`,
        );
      }
    }
    this.forget(sessionId);
    try {
      await target.terminal.sendText(target.paneId, spec.openCommand);
    } catch (err) {
      return fail(409, err instanceof Error ? err.message : String(err));
    }
    const deadline = Date.now() + this.timing.openTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.timing.pollMs);
      const screen = await read();
      const view = screen ? spec.parseList(screen) : null;
      if (view) {
        const resolved = await this.resolveView(sessionId, view);
        this.panels.set(sessionId, {
          paneId: target.paneId,
          view,
          points: resolved.points,
          at: Date.now(),
        });
        return { ok: true, view: resolved.view };
      }
    }
    // 空面板：开是开出来了，但一条能退的都没有（退过一次 = 历史已 fork 走）。如实报，关掉。
    const now = await read();
    if (now && spec.emptyOf?.(now)) {
      await target.terminal.sendKeys(target.paneId, spec.keys.cancel).catch(() => {});
      return fail(409, '没有可回退的点（这个会话的历史已经在别处了）');
    }
    // 没开成：面板真开着（只是文法没认出来）才按 Esc 关掉；命令根本没生效就只清输入框
    // ——Esc 打在跑着的回合上是「中断」，那是比留在输入框里更重的伤害
    const cleanupKey = now && spec.listHeader.test(now) ? spec.keys.cancel : spec.keys.clearInput;
    await target.terminal.sendKeys(target.paneId, cleanupKey).catch(() => {});
    return fail(409, '回退面板没有打开（会话可能正忙，或命令被当成了普通消息）');
  }

  /**
   * 把「屏上读到的结构」换成「要交给前端的列表」：文本与索引以**转录**为准，
   * 屏只提供窗口计数、焦点与 `(current)`/前会话行的占位。
   *
   * 对账不符 ⇒ 回落屏上文本（面板身份已由三样锚确认，退错点的风险不在这里）。
   * 宿主面板的条目口径不透明（排队吸收的消息、`--resume` 带进来的前会话，
   * 都只体现在屏上），对不上就说明有一类我们看不见的条目 —— 此时**降级而不拒答**：
   * 屏上文本可能被截断，但位置与索引仍是宿主自己给的。
   */
  private async resolveView(
    sessionId: string,
    view: RewindPickerView,
  ): Promise<{ view: RewindPickerView; points: RewindPoint[] | null }> {
    const points = await this.deps.pointsOf(sessionId);
    if (!points || view.previousSession) return { view, points: null };
    const onScreen = view.items.filter((it) => it.text !== null).length;
    if (view.moreAbove + onScreen + view.moreBelow !== points.length) {
      return { view, points: null };
    }
    const items = view.items.map((it) => {
      if (it.text === null) return it;
      const p = points[it.index];
      return p ? { ...it, text: p.text } : it;
    });
    return { view: { ...view, items }, points };
  }

  /** 选条目 → 进确认屏 → 读回**宿主真正给的那几项**（不自己编档位）。 */
  async prepare(sessionId: string, index: number): Promise<RewindPrepareResult> {
    const spec = this.deps.pickerOf(sessionId);
    if (!spec) return fail(409, '这个 harness 的回退只能在终端里操作');
    const panel = this.panels.get(sessionId);
    if (!panel || Date.now() - panel.at > this.timing.panelTtlMs) {
      return fail(409, '回退面板已关闭或过期，请重新敲 /rewind');
    }
    const target = await this.deps.target(sessionId, '回退');
    if (!target.ok) return target;
    if (target.paneId !== panel.paneId) {
      this.panels.delete(sessionId);
      return fail(409, '会话换到别的终端了，请重新敲 /rewind');
    }
    const terminal = target.terminal;
    const read = async (): Promise<string | null> => {
      try {
        return (await terminal.getPaneText!(panel.paneId)) ?? null;
      } catch {
        return null;
      }
    };
    const cancel = async (): Promise<void> => {
      this.panels.delete(sessionId);
      await this.dismiss(terminal, panel.paneId, spec);
    };

    // ① 重读屏：面板内容必须和打开时一致（期间可能有消息投进来把键打进了面板）
    const screen = await read();
    const view = screen ? spec.parseList(screen) : null;
    if (!view || !sameView(view, panel.view)) {
      await cancel();
      return fail(409, '回退面板内容变了，请重新敲 /rewind');
    }
    const item = view.items.find((it) => it.index === index);
    if (!item || item.text === null) return fail(400, '这条不是可回退的消息');
    // 落点原文取转录全文（盘上有、且不会被屏宽截断）；没有转录就退回屏上那份
    const target0 = panel.points?.find((p) => p.index === index)?.text ?? item.text;

    // ② 焦点当前停在哪一条（读屏得到，不假设恒在 `(current)`：面板被 Esc 退回、
    // 或用户在 TUI 里动过，焦点都可能留在别处），朝目标方向打该打的键
    const openFocus = view.items.find((it) => it.focused)?.index;
    if (openFocus === undefined) {
      await cancel();
      return fail(409, '读不出回退面板的焦点位置，已退出（未做任何回退）');
    }
    const steps = openFocus - item.index;
    try {
      for (let i = 0; i < Math.abs(steps); i++) {
        await terminal.sendKeys(panel.paneId, steps > 0 ? spec.keys.up : spec.keys.down);
        await sleep(this.timing.keyGapMs);
      }
    } catch (err) {
      await cancel();
      return fail(409, err instanceof Error ? err.message : String(err));
    }
    // ②b 回车前核对焦点确实落在选中的那条上（已在该条则不重新核对：没有键可验）
    if (steps !== 0) {
      const moved = await this.waitFor(
        read,
        spec,
        (s) => {
          const f = spec.parseList(s)?.items.find((it) => it.focused);
          return f && f.index !== openFocus ? f : null;
        },
        this.timing.confirmTimeoutMs,
      );
      const landed = moved ? spec.parseList(moved.screen)?.items.find((it) => it.focused) : null;
      if (!landed) {
        await cancel();
        return fail(409, '焦点没有离开当前点，键可能没打进去（已退出，未做任何回退）');
      }
      if (landed.index !== index) {
        await cancel();
        return fail(409, '焦点没有落在选中的那条消息上，已退出（未做任何回退）');
      }
    }
    try {
      await terminal.sendKeys(panel.paneId, spec.keys.accept);
    } catch (err) {
      await cancel();
      return fail(409, err instanceof Error ? err.message : String(err));
    }

    // ③ 等确认屏；没出现 = 落点仍在 (current)（键没打进去/面板已关）——不硬来
    const confirm = await this.waitFor(read, spec, (s) => spec.parseConfirm(s), this.timing.confirmTimeoutMs);
    if (!confirm) {
      this.panels.delete(sessionId);
      await this.dismiss(terminal, panel.paneId, spec);
      return fail(409, '回退面板没有进入确认屏，键可能没打进去（已退出，未做任何回退）');
    }
    // 核对落点：确认屏会显示被选中的原文（长文按宽度截断），前 24 字对不上就是选错了条
    if (!this.samePrompt(confirm.prompt, target0)) {
      await cancel();
      return fail(409, '确认屏里显示的不是选中的那条消息，已退出（未做任何回退）');
    }
    const options = spec.parseConfirm(confirm.screen) ?? [];
    this.prepared.set(sessionId, {
      paneId: panel.paneId,
      prompt: target0,
      options,
      at: Date.now(),
    });
    return { ok: true, prompt: target0, options };
  }

  /** 在宿主给的选项里挑一项提交（`option` = 屏上原样的文案）。 */
  async commit(sessionId: string, option: string): Promise<RewindCommitResult> {
    const spec = this.deps.pickerOf(sessionId);
    if (!spec) return fail(409, '这个 harness 的回退只能在终端里操作');
    const prepared = this.prepared.get(sessionId);
    if (!prepared || Date.now() - prepared.at > this.timing.panelTtlMs) {
      this.prepared.delete(sessionId);
      return fail(409, '还没确认好要退到哪一条，请重新敲 /rewind');
    }
    const target = await this.deps.target(sessionId, '回退');
    if (!target.ok) return target;
    if (target.paneId !== prepared.paneId) {
      this.forget(sessionId);
      return fail(409, '会话换到别的终端了，请重新敲 /rewind');
    }
    const terminal = target.terminal;
    const read = async (): Promise<string | null> => {
      try {
        return (await terminal.getPaneText!(prepared.paneId)) ?? null;
      } catch {
        return null;
      }
    };
    const cancel = async (): Promise<void> => {
      this.forget(sessionId);
      await this.dismiss(terminal, prepared.paneId, spec);
    };

    // 确认屏必须还在、且回显的还是那一条（期间可能在 TUI 里被人按过）
    const screen = await read();
    const options = screen ? spec.parseConfirm(screen) : null;
    if (!options) {
      await cancel();
      return fail(409, '确认屏不见了，已退出（未做任何回退）');
    }
    if (!this.samePrompt(spec.confirmPrompt?.(screen ?? '') ?? null, prepared.prompt)) {
      await cancel();
      return fail(409, '确认屏里显示的不是选中的那条消息，已退出（未做任何回退）');
    }
    const picks = options.filter((o) => !o.cancel);
    const want = picks.findIndex((o) => o.label === option);
    if (want < 0) return fail(400, `宿主没有「${option}」这个回退选项`);
    const selected = picks.findIndex((o) => o.selected);
    if (selected < 0) {
      await cancel();
      return fail(409, '读不出宿主把焦点放在哪一项上，已退出（未做任何回退）');
    }
    const steps = want - selected;
    try {
      for (let i = 0; i < Math.abs(steps); i++) {
        await terminal.sendKeys(prepared.paneId, steps > 0 ? spec.keys.down : spec.keys.up);
        await sleep(this.timing.keyGapMs);
      }
    } catch (err) {
      await cancel();
      return fail(409, err instanceof Error ? err.message : String(err));
    }
    // 回车前核对焦点确实落在要的那一项上
    const landed = await this.waitFor(
      read,
      spec,
      (s) => {
        const now = spec.parseConfirm(s);
        return now?.find((o) => o.selected)?.label === option ? now : null;
      },
      this.timing.confirmTimeoutMs,
    );
    if (!landed) {
      await cancel();
      return fail(409, '焦点没有落在选中的那项上，已退出（未做任何回退）');
    }

    // 提交并等面板消失
    try {
      await terminal.sendKeys(prepared.paneId, spec.keys.accept);
    } catch (err) {
      this.forget(sessionId);
      return fail(409, err instanceof Error ? err.message : String(err));
    }
    this.forget(sessionId);
    const done = await this.waitFor(
      read,
      spec,
      (s) => spec.parseList(s) === null && spec.parseConfirm(s) === null,
      this.timing.settleTimeoutMs,
    );
    if (!done) return fail(409, '回退已提交，但没确认到面板关闭——请看一眼终端');
    // 宿主会把这条原文回填进输入框；记下它，下次再开面板时认得出来、可以直接清掉
    this.refilled.set(sessionId, { text: prepared.prompt, at: Date.now() });
    const cleared = await this.clearRefill(terminal, prepared.paneId, spec, prepared.prompt, read);
    return { ok: true, prompt: prepared.prompt, cleared };
  }

  /**
   * 清掉宿主回填进 TUI 输入框的那条原文（让回退在 web 端也有可见结果）。
   * **用 Ctrl+U 而不是 Ctrl+C**：Ctrl+C 在回合跑着时是中断、连按还可能退出会话，
   * 而 Ctrl+U 只清当前输入行。判据从严——屏上内容必须仍是那条原文（归一化后
   * 完全相同）且没有「回合在跑」的证据，否则一个字都不打（用户已经改了或正在打新内容）。
   */
  private async clearRefill(
    terminal: PromptTerminal,
    paneId: string,
    spec: RewindPickerSpec,
    prompt: string,
    read: () => Promise<string | null>,
  ): Promise<boolean> {
    if (!spec.pendingInputOf || !spec.busyOf || typeof terminal.getPaneText !== 'function') return false;
    const want = norm(prompt);
    for (let i = 0; i < 4; i++) {
      const screen = await read();
      if (!screen || spec.busyOf(screen)) return false;
      if (spec.parseList(screen) || spec.parseConfirm(screen)) return false;
      const pending = spec.pendingInputOf(screen);
      if (pending === null) return false;
      if (!pending) return true;
      // 多行原文在屏上只剩首行（`pendingInputOf` 只取 `❯` 行），比对不上就不清
      if (norm(pending) !== want) return false;
      await terminal.sendKeys(paneId, spec.keys.clearInput).catch(() => {});
      await sleep(this.timing.keyGapMs);
    }
    const screen = await read();
    return !!screen && !spec.busyOf(screen) && spec.pendingInputOf(screen) === '';
  }

  private forget(sessionId: string): void {
    this.panels.delete(sessionId);
    this.prepared.delete(sessionId);
  }

  /** 确认屏回显的原文比对（长文按宽度截断，故比前缀）。 */
  private samePrompt(shown: string | null, want: string): boolean {
    const key = shown ? norm(shown).slice(0, 24) : '';
    return !key || norm(want).startsWith(key);
  }

  /** 关掉面板（用户取消 / 换会话）。 */
  async cancel(sessionId: string): Promise<{ ok: true } | Extract<AnswerResult, { ok: false }>> {
    const known = this.panels.get(sessionId) ?? this.prepared.get(sessionId);
    this.forget(sessionId);
    const spec = this.deps.pickerOf(sessionId);
    if (!spec) return { ok: true };
    try {
      const target = await this.deps.target(sessionId, '关闭回退面板');
      if (!target.ok || typeof target.terminal.getPaneText !== 'function') return { ok: true };
      const paneId = known?.paneId ?? target.paneId;
      await this.dismiss(target.terminal, paneId, spec);
    } catch {
      // 面板本就关着/终端没了：取消本来就是「尽量收干净」，不把噪声当失败
    }
    return { ok: true };
  }

  /**
   * 把面板收干净。**确认屏上的一记 Esc 只退回列表屏**（活体实测），所以按屏面
   * 决定打几记：一直打到屏上没有面板为止，最多两记（列表 → 关）。
   */
  private async dismiss(terminal: PromptTerminal, paneId: string, spec: RewindPickerSpec): Promise<void> {
    if (typeof terminal.getPaneText !== 'function') {
      await terminal.sendKeys(paneId, spec.keys.cancel).catch(() => {});
      return;
    }
    for (let i = 0; i < 2; i++) {
      const screen = await terminal.getPaneText(paneId).catch(() => null);
      if (screen === null || !this.panelOn(spec, screen)) return;
      await terminal.sendKeys(paneId, spec.keys.cancel).catch(() => {});
      await sleep(this.timing.keyGapMs);
    }
  }

  /** 屏上还挂着回退面板（列表屏 / 确认屏 / 空面板）。 */
  private panelOn(spec: RewindPickerSpec, screen: string): boolean {
    return spec.parseList(screen) !== null || spec.parseConfirm(screen) !== null || !!spec.emptyOf?.(screen);
  }

  /** 轮询读屏直到判据成立（`probe` 返回非空即止）。 */
  private async waitFor<T>(
    read: () => Promise<string | null>,
    spec: RewindPickerSpec,
    probe: (screen: string) => T | null,
    timeoutMs: number,
  ): Promise<{ screen: string; prompt: string | null } | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.timing.pollMs);
      const screen = await read();
      if (!screen) continue;
      if (probe(screen) !== null) {
        return { screen, prompt: spec.confirmPrompt ? spec.confirmPrompt(screen) : null };
      }
    }
    return null;
  }
}
