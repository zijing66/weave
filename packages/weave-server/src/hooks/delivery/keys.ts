import { HARNESS_SESSION_CONTROL, isHarness } from '@weavecode/core';
import type { MessagingSurface } from '@weavecode/harness';
import type { ProjectRepository } from '../../repositories/projects.js';
import type { SessionRepository } from '../../repositories/sessions.js';
import type { HookEventRepository } from '../../repositories/hook-events.js';
import { normalizeDirKey } from '../../daemon/opener.js';
import type { AnswerResult, PromptTerminal } from '../message-deliverer.js';

/**
 * 键序注入域（会话控制面）的共享落点解析与常量：作答 / 中断 / 关 pane / 模式 /
 * 模型 / 思考强度 / 旁路会话全部经由「会话 → 项目 → 终端通道 → pane」这一条
 * 解析链，失败原因是**可判定的语义拒绝**（404/409），调用方原样回给 HTTP。
 */

/** 裸 ESC（没有开 Kitty 键盘协议的宿主用它；claude 里连打两次是历史回退菜单）。 */
export const ESC = '\x1b';

/** Kitty **键盘协议**的 Esc（CSI 27 u）。claude 的 TUI 开着该协议，
 *  裸 `0x1b` 会被当成一个转义序列的开头丢掉——手按 Esc 有效、注入裸 ESC 无效的
 *  真因就在这里（2026-10-30 活体实测：`ESC[27u` 1 秒内中断，裸 `0x1b` 观察 8 秒
 *  纹丝不动）。同理 Ctrl+C 的真实按键形态是 `ESC[99;5u`。 */
export const ESC_KITTY = '\x1b[27u';

/** Kitty 键盘协议的 Ctrl+C（CSI 99;5 u）：宿主开着该协议时裸 `0x03` 不被认。 */
export const CTRL_C_KITTY = '\x1b[99;5u';

/** 执行模式切换键 = 一记 Shift+Tab（固定死在服务端，不当参数收）。 */
export const SHIFT_TAB = '\x1b[Z';

/** 手动提交键 = 一记回车（提交宿主输入框里现成的内容；与层② 补打同一字节）。 */
export const ENTER = '\r';

/** 中断梯子的兜底档 = 一记 Ctrl+B。纯控制字节、不属于任何转义序列，宿主开着
 *  Kitty 键盘协议也照收（该窗口屏上提示的正是 `(ctrl+b to run in background)`）。 */
export const CTRL_B = '\x02';

/** 模型名形态：不含空白/控制字符、≤128 字符（贴宿主 `/model` 的 `\S*` 文法）。 */
export const MODEL_NAME = /^[^\s\x00-\x1f\x7f]{1,128}$/;

export const modelCommand = (name: string) => `/model ${name}`;
export const effortCommand = (level: string) => `/effort ${level}`;

/**
 * 作答原子形态与原子间隔（宿主把连打的字符当粘贴/筛选输入，必须一次一个）。
 * 字母原子 = 两家宿主模态框的**稳定快捷键**：`n`（claude 备注 / codex decline）、
 * `y`/`d`（codex 审批 overlay 的 approve/deny，keymap 硬编码默认）——键序本身
 * 仍由 harness 规格拼出，白名单只挡任意击键。`\x1b[Z` = shift+tab（plan 反馈行
 * 的提交键；与下移 `\x1b[B` 同构，逐字符写 conhost 后 TUI 读到的就是这条字节流）。
 */
export const ANSWER_ATOM = /^(?:[1-9]|y|n|d|\t|\r|\x1b\[B|\x1b\[Z)$/;
export const ANSWER_TEXT = /^[^\x00-\x1f\x7f]*$/;
export const ANSWER_ATOM_GAP_MS = 120;

export const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface KeysTargetDeps {
  sessions: Pick<SessionRepository, 'getBySessionId'>;
  projects: Pick<ProjectRepository, 'getById'>;
  hookEvents: Pick<HookEventRepository, 'listBySession'>;
  /** 层② 通道现取（null = 未装配）。 */
  terminalChannel(): PromptTerminal | null;
  /** pane 定位（locator 优先、标题+cwd 回落）。 */
  terminalPaneFor(
    session: { sessionId: string; title: string | null },
    project: { path: string },
  ): Promise<{ id: string } | null>;
  /** 该会话的 pane 定位是否被另一个会话占着（fork 继承同一 env）；有值 = 不可击键。 */
  paneEnvConflictOf?(sessionId: string): string | null;
}

/**
 * 键序注入路径（作答 / 中断 / 关 pane / 模式 / 模型 / 档位 / 旁路）共用的落点解析。
 * 两条 409 是给用户看的（web 直拼在「停止失败：」这类动作名后面），故写成中文
 * 修法，动作名随调用方换。
 */
export async function sessionKeysTarget(
  deps: KeysTargetDeps,
  sessionId: string,
  action = '击键',
): Promise<
  { ok: true; terminal: PromptTerminal; paneId: string } | Extract<AnswerResult, { ok: false }>
> {
  const session = deps.sessions.getBySessionId(sessionId);
  if (!session) return { ok: false, status: 404, error: 'Session not found' };
  if (session.projectId == null) {
    return { ok: false, status: 400, error: 'Session is not bound to a project' };
  }
  const project = deps.projects.getById(session.projectId);
  if (!project) return { ok: false, status: 404, error: 'Project not found' };
  const terminal = deps.terminalChannel();
  if (!terminal) {
    return { ok: false, status: 409, error: `终端通道未装配，无法远程${action}` };
  }
  const conflict = deps.paneEnvConflictOf?.(sessionId) ?? null;
  if (conflict) {
    return {
      ok: false,
      status: 409,
      error: `这个会话的终端定位被另一个会话（${conflict.slice(0, 8)}）占着（fork 继承了同一个 pane），为避免把${action}打进别人的终端已拒绝`,
    };
  }
  const pane = await deps.terminalPaneFor(session, project);
  if (!pane) {
    return {
      ok: false,
      status: 409,
      error: `找不到会话所在的终端窗口——这个会话所在终端没有可用的远程${action}通道`,
    };
  }
  return { ok: true, terminal, paneId: pane.id };
}

/** 思考强度的档位词表（core 表该会话 harness 的 `effortLevels`；判不出 harness = 空）。 */
export function effortLevelsOf(
  hookEvents: Pick<HookEventRepository, 'listBySession'>,
  sessionId: string,
): string[] {
  const latest = hookEvents.listBySession(sessionId, 1);
  const src = latest[latest.length - 1]?.source;
  return isHarness(src) ? (HARNESS_SESSION_CONTROL[src]?.effortLevels ?? []) : [];
}

/** 旁路会话面（claude = `/btw`）现取：判不出 harness / 面缺席 = null。 */
export function sideQuestionSurfaceOf(
  hookEvents: Pick<HookEventRepository, 'listBySession'>,
  sessionId: string,
  surfaceFor: ((harness: import('@weavecode/core').Harness) => MessagingSurface) | undefined,
): MessagingSurface | null {
  const latest = hookEvents.listBySession(sessionId, 1);
  const src = latest[latest.length - 1]?.source;
  if (!isHarness(src)) return null;
  return surfaceFor?.(src) ?? null;
}

/** pane 定位（层② 共用）：locator 优先、标题+cwd 回落。 */
export async function locateTerminalPane(
  terminal: PromptTerminal | null,
  paneEnvs: ReadonlyMap<string, Record<string, string>>,
  session: { sessionId: string; title: string | null },
  project: { path: string },
): Promise<{ id: string } | null> {
  if (!terminal) return null;
  const env = paneEnvs.get(session.sessionId);
  if (env) {
    const located = await terminal.locatePane?.(env).catch(() => null);
    if (located) return { id: located };
  }
  if (!session.title) return null;
  const want = session.title.replace(/^[✻✽✶✳✢⋅◦✦✧∘◐◑◒◓*]+\s*/, '');
  const pathKey = normalizeDirKey(project.path, process.platform);
  let panes: Array<{ id: string; title: string | null; cwd: string | null }>;
  try {
    panes = await terminal.listPanes();
  } catch {
    return null;
  }
  const hits = panes.filter(
    (p) =>
      p.title != null &&
      p.cwd != null &&
      pathKey != null &&
      p.title.replace(/^[✻✽✶✳✢⋅◦✦✧∘◐◑◒◓*]+\s*/, '') === want &&
      normalizeDirKey(p.cwd, process.platform) === pathKey,
  );
  return hits.length === 1 ? hits[0]! : null;
}
