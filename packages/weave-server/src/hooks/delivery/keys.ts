import { HARNESS_SESSION_CONTROL, isHarness } from '@weavecode/core';
import type { MessagingSurface } from '@weavecode/harness';
import type { ProjectRepository } from '../../repositories/projects.js';
import type { SessionRepository } from '../../repositories/sessions.js';
import type { HookEventRepository } from '../../repositories/hook-events.js';
import { normalizeDirKey } from '../../daemon/opener.js';
import type { AnswerResult, PaneTargetSource, PromptTerminal } from '../message-deliverer.js';

/**
 * 键序注入域（会话控制面）的共享落点解析与常量：作答 / 中断 / 关 pane / 模式 /
 * 模型 / 思考强度 / 旁路会话全部经由「会话 → 项目 → 终端通道 → pane」这一条
 * 解析链，失败原因是**可判定的语义拒绝**（404/409），调用方原样回给 HTTP。
 */

/** 中断键 = 一记 ESC（claude 里连打两次是历史回退菜单，故只打一记）。 */
export const ESC = '\x1b';

/** 执行模式切换键 = 一记 Shift+Tab（固定死在服务端，不当参数收）。 */
export const SHIFT_TAB = '\x1b[Z';

/** 手动提交键 = 一记回车（提交宿主输入框里现成的内容；与层② 补打同一字节）。 */
export const ENTER = '\r';

/** 手动中断键 = 一记 Ctrl+C（宿主 TUI 的硬中断；wt 侧编成 VK_C + CTRL 按下）。 */
export const CTRL_C = '\x03';

/** 模型名形态：不含空白/控制字符、≤128 字符（贴宿主 `/model` 的 `\S*` 文法）。 */
export const MODEL_NAME = /^[^\s\x00-\x1f\x7f]{1,128}$/;

export const modelCommand = (name: string) => `/model ${name}`;
export const effortCommand = (level: string) => `/effort ${level}`;

/**
 * 作答原子形态与原子间隔（宿主把连打的字符当粘贴/筛选输入，必须一次一个）。
 * 字母原子 = 两家宿主模态框的**稳定快捷键**：`n`（claude 备注 / codex decline）、
 * `y`/`d`（codex 审批 overlay 的 approve/deny，keymap 硬编码默认）——键序本身
 * 仍由 harness 规格拼出，白名单只挡任意击键。
 */
export const ANSWER_ATOM = /^(?:[1-9]|y|n|d|\t|\r|\x1b\[B)$/;
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
  /** pane 定位（locator 优先、标题+cwd 回落；heuristic 跳过 locator）。 */
  terminalPaneFor(
    session: { sessionId: string; title: string | null },
    project: { path: string },
    source?: PaneTargetSource,
  ): Promise<{ id: string } | null>;
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
  source: PaneTargetSource = 'both',
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
  const pane = await deps.terminalPaneFor(session, project, source);
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

/** pane 定位（层② 共用）：locator 优先、标题+cwd 回落；heuristic 跳过 locator。 */
export async function locateTerminalPane(
  terminal: PromptTerminal | null,
  paneEnvs: ReadonlyMap<string, Record<string, string>>,
  session: { sessionId: string; title: string | null },
  project: { path: string },
  source: PaneTargetSource = 'both',
): Promise<{ id: string } | null> {
  if (!terminal) return null;
  const env = source === 'heuristic' ? undefined : paneEnvs.get(session.sessionId);
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
