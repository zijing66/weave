import { stat } from 'node:fs/promises';
import { isHarness, type Harness } from '@weavecode/core';
import type { WeaveServerDeps } from './server.js';
import { readDaemonSettings } from './settings.js';
import { defaultProjectOpener, terminalBackendFor } from './opener.js';
import { messagingSurfaceFor } from '../surfaces.js';

/**
 * 转录状态的判定（列表与打开门禁共用）：探测只答「那文件里有没有内容」，而没内容
 * 有两种成因：①刚建的会话宿主先建空文件（或缺席），首条消息写进去才有内容；②曾经
 * 写过又被清理/删掉。只有 ② 接不回来。判据 = 这个会话确实跑过（有 prompt 或收尾
 * 事件）——没跑过的会话没有可失去的转录，判不动（null），免得刚建出来就挂「转录已
 * 丢失」。false 因此只有一种含义：真丢了。
 */
export function transcriptState(present: boolean | null, hasRun: boolean | undefined): boolean | null {
  if (present !== false) return present;
  return hasRun === true ? false : null;
}

export type SessionOpenDeps = Pick<
  WeaveServerDeps,
  | 'hookSessions'
  | 'hookEvents'
  | 'projects'
  | 'harnesses'
  | 'sessionProbe'
  | 'opener'
  | 'terminalRefresher'
  | 'messageDeliverer'
>;

export type SessionOpenResult =
  | { ok: true; sessionId: string; command: string; cwd: string; target?: string }
  | { ok: false; status: 400 | 404 | 409 | 501 | 503; error: string };

/** resume 的 sessionId 已知：起点直接落 pane 定位，不走 pending 队列。
 *  只为 paneEnvSource='launch' 的 harness 生效（'hook' 的 env 精确且自愈，
 *  起点只会引入过期源）。 */
function noteLaunchOrigin(
  deps: SessionOpenDeps,
  harness: Harness,
  sessionId: string,
  origin: { env: Record<string, string> } | null,
): void {
  if (!origin || messagingSurfaceFor(harness).paneEnvSource !== 'launch') return;
  deps.messageDeliverer?.notePaneEnv(sessionId, origin.env);
}

/**
 * 在默认终端打开会话（spawn 独立终端跑 harness 交互式 resume，如 `claude --resume <id>`）。
 * 路由与编排引擎的「目标会话没开就拉起来」共用这一份：判据、能力面取法与错误码只有一处。
 */
export async function openSessionTerminal(
  deps: SessionOpenDeps,
  sessionId: string,
  target?: string,
): Promise<SessionOpenResult> {
  if (!deps.hookSessions) return { ok: false, status: 503, error: 'Hooks subsystem unavailable' };
  const session = deps.hookSessions.getBySessionId(sessionId);
  if (!session) return { ok: false, status: 404, error: 'Session not found' };
  if (!deps.hookEvents) return { ok: false, status: 503, error: 'Hook ingestion unavailable' };
  // harness 归属 = 最新事件 source（与 sessions 列表的计算字段同口径）
  const latest = deps.hookEvents.listBySession(sessionId, 1);
  const src = latest[latest.length - 1]?.source;
  if (!isHarness(src)) {
    return { ok: false, status: 400, error: 'Session has no hook events to determine its harness' };
  }
  // 交互式 resume 形态来自 harness 能力槽（server 不写 harness 命令硬编码）
  const spec = deps.harnesses?.get(src)?.resume;
  if (!spec?.supported || !spec.openArgs) {
    return { ok: false, status: 501, error: `Harness "${src}" does not support interactive resume` };
  }
  if (!session.projectId) return { ok: false, status: 400, error: 'Session is not bound to a project' };
  const project = deps.projects?.getById(session.projectId);
  if (!project) return { ok: false, status: 404, error: 'Project not found' };
  // 转录没了就别 spawn：--resume 认的是那份文件，开出去只会在 pane 里报
  // 「No conversation found」。判不动（null）照旧放行，不猜。
  const transcriptPresent = deps.sessionProbe?.transcriptPresent(sessionId) ?? null;
  if (transcriptState(transcriptPresent, deps.hookSessions.hasRunOf(sessionId)) === false) {
    return { ok: false, status: 409, error: 'Session transcript is missing — nothing to resume' };
  }
  const opener = deps.opener ?? defaultProjectOpener;
  try {
    const info = await stat(project.path);
    if (!info.isDirectory()) throw new Error(`Not a directory: ${project.path}`);
    const settings = await readDaemonSettings();
    const argv = [spec.bin, ...(spec.launchArgs ?? []), ...spec.openArgs(sessionId)];
    if (target) {
      // 定点附加的能力归后端：能反查目标的 preset 才有定点通道（wezterm mux /
      // Terminal.app osascript / wt 进程表），其余明确拒绝而非静默忽略——调用方不列白名单。
      if (!terminalBackendFor(settings.terminal).enumerable) {
        throw new Error(
          `Terminal preset "${settings.terminal.preset}" cannot attach to a chosen pane — pick wezterm, wt or Terminal.app in settings`,
        );
      }
      const runAt = opener.runInTerminalAt;
      if (!runAt) throw new Error('Targeted attach is unavailable');
      const origin = await runAt(project.path, argv, target, settings.terminal);
      noteLaunchOrigin(deps, src, sessionId, origin);
    } else {
      const origin = await opener.runInTerminal(project.path, argv, settings.terminal);
      noteLaunchOrigin(deps, src, sessionId, origin);
    }
    // 角标对账：新 pane 的 cwd 上报有一拍延迟（立即探看不到增量），600ms 后补一枪。
    setTimeout(() => void deps.terminalRefresher?.refreshNow(), 600);
    return {
      ok: true,
      sessionId,
      command: argv.join(' '),
      cwd: project.path,
      ...(target ? { target } : {}),
    };
  } catch (e) {
    return { ok: false, status: 400, error: e instanceof Error ? e.message : 'Open failed' };
  }
}
