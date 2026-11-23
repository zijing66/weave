import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isHarness, type Harness } from '@weavecode/core';
import type { ResumeCommandSpec } from '@weavecode/harness';
import type { WeaveServerDeps } from './server.js';
import { readDaemonSettings, type TerminalSettings } from './settings.js';
import { defaultProjectOpener, terminalBackendFor } from './opener.js';
import { hideWindowOf, scheduleHideWindow, type ProjectStorage } from './routes/projects.js';
import { combinedInstancesOf, combinedLivenessOf } from './liveness.js';
import { messagingSurfaceFor } from '../surfaces.js';

/**
 * 引导注入的三拍时序（实测 codex TUI 冷启动 2-6s 波动，注入早了整段被吃）：
 * T1 贴文本+提交、T2 补一记 CR（T1 的 CR 被吃时兜底提交框里现成的文本）、
 * T3 整段重来（T1 全被吃时兜底）。已提交的场景里 T2 是空输入框上的回车、
 * T3 是对已命名线程的同名再改（幂等），都无害。
 */
const BOOTSTRAP_INJECT_DELAY_MS = 8_000;
const BOOTSTRAP_FOLLOWUP_CR_MS = 11_000;
const BOOTSTRAP_RETRY_MS = 14_000;

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
  | 'runtimeSupervisor'
>;

export type SessionOpenResult =
  | {
      ok: true;
      sessionId: string;
      command: string;
      cwd: string;
      target?: string;
      /** headless 宿主（Web 终端 preset）起的实例 id；外部窗口形态没有。 */
      instanceId?: string;
    }
  | { ok: false; status: 400 | 404 | 409 | 501 | 503; error: string };

/**
 * headless 臂的唯一执行核（web 预设 / 显式 executionMode 共用）：Runtime Host
 * 持 PTY、不开外部终端窗。new-session 路由（sessionId 未定）与 resume 路由
 * （已知）都走它——spawn 形状只有这一份，宿主形态判据归 terminalBackendFor。
 * `headless` env 标记只有 harness 会话带（web 终端的裸 shell 实例不带）。
 */
export async function spawnHeadlessInstance(
  deps: SessionOpenDeps,
  meta: { projectId: number; harness: string },
  payload: {
    command: string;
    args: string[];
    cwd: string;
    instanceId?: string;
    headlessEnv?: boolean;
    /** runtimeSupervisor 缺席的错误码：resume 链历史口径 503，new-session 501。 */
    missingSupervisorStatus?: 501 | 503;
  },
): Promise<{ ok: true; instanceId: string } | { ok: false; status: 501 | 503; error: string }> {
  if (!deps.runtimeSupervisor) {
    return {
      ok: false,
      status: payload.missingSupervisorStatus ?? 501,
      error: 'Runtime host is not available (daemon too old or disabled)',
    };
  }
  const instanceId = payload.instanceId ?? `wvi-${randomUUID().slice(0, 12)}`;
  try {
    await deps.runtimeSupervisor.spawnInstance(
      {
        instanceId,
        command: payload.command,
        args: payload.args,
        cwd: payload.cwd,
        cols: 100,
        rows: 30,
        env: {
          ...process.env,
          WEAVE_INSTANCE_ID: instanceId,
          ...(payload.headlessEnv === false ? {} : { WEAVE_RUNTIME_HEADLESS: '1' }),
        },
      },
      meta,
    );
    return { ok: true, instanceId };
  } catch (e) {
    return { ok: false, status: 503, error: `Runtime host spawn failed: ${e instanceof Error ? e.message : e}` };
  }
}

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
 * 落子后的可见性兜底（全局设置 `terminalFocus.focusOnOpen`，默认开）：目标项目
 * 的窗若处于隐藏态（此前被弹层藏过），调起会话把它拉回可见——「从 weave 调起
 * 必然看得见」。项目 hideWindow 开着时**例外**（那个项目的意愿就是藏，open 路由
 * 的自动隐藏在延迟一拍之后跑，这里提前 show 会跟它打架）。fire-and-forget、
 * 失败静默：这是体验兜底，不值得为它报错。
 */
function restoreVisibilityIfHidden(
  _projectId: number | undefined,
  cwd: string,
  terminal: TerminalSettings,
): void {
  void (async () => {
    try {
      const focus = (await readDaemonSettings()).terminalFocus?.focusOnOpen;
      if (focus === false) return;
      const backend = terminalBackendFor(terminal);
      if (!backend.enumerable) return;
      const targets = await backend.listTargets(cwd);
      const target = targets[0];
      if (!target) return;
      const vis = await backend.targetVisibility(cwd, target.id);
      if (vis !== 'hidden') return;
      await backend.setTargetVisibility(cwd, target.id, 'show');
    } catch {
      // 藏不回来的场景照旧（窗已关 / preset 不支持 / 枚举失败）：静默
    }
  })();
}

/**
 * 引导注入（`resume.bootstrapText`，懒建档宿主的会话行加速）：spawn 成功后延时把
 * 引导文本贴进起点 pane 并提交——codex 的 `/rename` 是零模型调用的本地命令，注入
 * 即建 rollout，会话行即刻进列表（起点候选也在同一拍被认领，分组同时点亮）。
 * fire-and-forget：不阻塞响应、失败静默（注入只是加速，宿主自己的建档节奏照常兜底）。
 */
export function scheduleBootstrapInjection(
  deps: Pick<WeaveServerDeps, 'terminal'>,
  origin: { env: Record<string, string> },
  text: string,
): void {
  const terminal = deps.terminal;
  if (!terminal) return;
  void (async () => {
    // 先睡再定位：spawn 回执到手时 pane 往往还没进 mux 枚举（实测立即 locatePane
    // 恒 null），T1 的延时正好覆盖这段注册延迟。
    await new Promise((r) => setTimeout(r, BOOTSTRAP_INJECT_DELAY_MS));
    const paneId = (await terminal.locatePane?.(origin.env).catch(() => null)) ?? null;
    if (!paneId) return;
    const inject = async (): Promise<void> => {
      try {
        await terminal.sendText(paneId, text);
      } catch {
        return; // pane 已没了（用户秒关）：后续拍全放弃
      }
    };
    await inject();
    setTimeout(() => void terminal.sendKeys(paneId, '\r').catch(() => {}), BOOTSTRAP_FOLLOWUP_CR_MS - BOOTSTRAP_INJECT_DELAY_MS);
    setTimeout(() => void inject(), BOOTSTRAP_RETRY_MS - BOOTSTRAP_INJECT_DELAY_MS);
  })();
}

/**
 * 在默认终端打开会话（spawn 独立终端跑 harness 交互式 resume，如 `claude --resume <id>`）。
 * 路由与编排引擎的「目标会话没开就拉起来」共用这一份：判据、能力面取法与错误码只有一处。
 * `opts.cwd` 覆盖落点（缺省 = 项目根）：B5 worktree 会话的重开必须原地——转录按
 * 引发它的 cwd 落 slug，换目录 resume 认不到那份转录。
 */
type ResumeTarget = {
  harness: Harness;
  spec: ResumeCommandSpec;
  projectId: number;
  cwd: string;
  args: string[];
};

type ResumeGate =
  | { ok: true; target: ResumeTarget }
  | { ok: false; status: 400 | 404 | 409 | 501 | 503; error: string };

/**
 * 防双开判据（唯一实现）：该会话已有活实例（Web 终端 PTY 或外部终端里跑着）
 * 就拒绝再 spawn 一个——两个进程写同一份转录，回合会交错。要换宿主先关掉现有
 * 的（关 pane / 退出外部终端）。空 = 放行。
 */
export function duplicateInstanceError(
  pids: readonly number[],
): { ok: false; status: 409; error: string } | null {
  if (pids.length === 0) return null;
  return {
    ok: false,
    status: 409,
    error: `Session is already running (pid ${pids.join(', ')}) — close that instance before opening another`,
  };
}

/** 交互式 resume 的门禁（外部终端开窗与 Web 终端 headless 恢复共用这一份判据）。 */
async function resolveResume(
  deps: SessionOpenDeps,
  sessionId: string,
  cwd?: string,
): Promise<ResumeGate> {
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
  const duplicate = duplicateInstanceError(combinedInstancesOf().get(sessionId) ?? []);
  if (duplicate) return duplicate;
  const project = deps.projects?.getById(session.projectId);
  if (!project) return { ok: false, status: 404, error: 'Project not found' };
  // 转录没了就别 spawn：--resume 认的是那份文件，开出去只会在 pane 里报
  // 「No conversation found」。判不动（null）照旧放行，不猜。
  const transcriptPresent = deps.sessionProbe?.transcriptPresent(sessionId) ?? null;
  if (transcriptState(transcriptPresent, deps.hookSessions.hasRunOf(sessionId)) === false) {
    return { ok: false, status: 409, error: 'Session transcript is missing — nothing to resume' };
  }
  try {
    const info = await stat(project.path);
    if (!info.isDirectory()) throw new Error(`Not a directory: ${project.path}`);
  } catch (e) {
    return { ok: false, status: 400, error: e instanceof Error ? e.message : 'Open failed' };
  }
  return {
    ok: true,
    target: {
      harness: src,
      spec,
      projectId: session.projectId,
      cwd: cwd ?? project.path,
      args: [...(spec.launchArgs ?? []), ...spec.openArgs(sessionId)],
    },
  };
}

/**
 * 开会话的唯一入口：宿主形态由终端后端自己答（`window` = 外部终端窗口、
 * `headless` = Runtime Host 里的 PTY），调用方与前端只有一个按钮、一条路由。
 */
export async function openSessionTerminal(
  deps: SessionOpenDeps,
  sessionId: string,
  target?: string,
  opts?: { cwd?: string },
): Promise<SessionOpenResult> {
  const resolved = await resolveResume(deps, sessionId, opts?.cwd);
  if (!resolved.ok) return resolved;
  const { harness: src, spec, projectId, cwd: runCwd, args } = resolved.target;
  const argv = [spec.bin, ...args];
  const opener = deps.opener ?? defaultProjectOpener;
  try {
    const settings = await readDaemonSettings();
    if (terminalBackendFor(settings.terminal).hostsSessions === 'headless') {
      const spawned = await spawnHeadlessInstance(deps, { projectId, harness: src }, {
        command: spec.bin,
        args,
        cwd: runCwd,
        missingSupervisorStatus: 503,
      });
      if (!spawned.ok) return spawned;
      return { ok: true, sessionId, command: argv.join(' '), cwd: runCwd, instanceId: spawned.instanceId };
    }
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
      const origin = await runAt(runCwd, argv, target, settings.terminal);
      noteLaunchOrigin(deps, src, sessionId, origin);
    } else {
      const origin = await opener.runInTerminal(runCwd, argv, settings.terminal);
      noteLaunchOrigin(deps, src, sessionId, origin);
    }
    // 可见性兜底：hideWindow 判据（未设置 = 默认藏，唯一出处 hideWindowOf）命中
    // 就别跟自动隐藏打架（延迟一拍后它自己藏）。
    const hideWindow = hideWindowOf(
      (deps.projects.getMeta(projectId) as { storage?: ProjectStorage } | null)?.storage,
    );
    if (hideWindow) {
      // hideWindow 的隐藏动作这里也要做（之前只在 /open 与 new-session 路由有，
      // ensureOpen 拉起的窗口从不藏——设置无效的成因），不做 show 兜底。
      scheduleHideWindow(deps as unknown as WeaveServerDeps, projectId, runCwd);
    } else {
      restoreVisibilityIfHidden(projectId, runCwd, settings.terminal);
    }
    // 角标对账：新 pane 的 cwd 上报有一拍延迟（立即探看不到增量），600ms 后补一枪。
    setTimeout(() => void deps.terminalRefresher?.refreshNow(), 600);
    return {
      ok: true,
      sessionId,
      command: argv.join(' '),
      cwd: runCwd,
      ...(target ? { target } : {}),
    };
  } catch (e) {
    return { ok: false, status: 400, error: e instanceof Error ? e.message : 'Open failed' };
  }
}

/** ensureOpen 的返回（与编排引擎 `deps.ensureOpen` 的形状逐字一致，两边共用一份）。 */
export type EnsureOpenResult =
  | { ok: true; ack?: 'session-start' | 'registry' }
  | { ok: false; error: string };

/**
 * 「判死会话先拉起再投递」的共享工厂：`openSessionTerminal` spawn + 等「真进了
 * 会话」（SessionStart 事件 id 超过拉起前基线；注册表出现 pid 只算弱信号）。
 * 编排引擎的「目标会话没开就拉起来」用这一份——判据、预算、错误口径只有一处。
 * **单飞**：同一会话被并发投递时只拉起一次（后到的搭同一班车的结果）；`opts.cwd`
 * 不同则各飞各的（B5 冲突修补在 worktree 原地重开）。
 */
export function createEnsureOpen(
  deps: SessionOpenDeps & { livenessOf?: () => Map<string, boolean> },
): (sessionId: string, opts?: { cwd?: string }) => Promise<EnsureOpenResult> {
  const opening = new Map<string, Promise<EnsureOpenResult>>();
  const ensure = async (sessionId: string, opts?: { cwd?: string }): Promise<EnsureOpenResult> => {
    if (!deps.hookEvents) return { ok: false, error: 'Hook ingestion unavailable' };
    // 回执基线：拉起前该会话的最新事件 id。`--resume` 起来的宿主会补一笔
    // SessionStart——那才是「真进了会话」；注册表出现 pid 只说明进程起来了。
    const baseline = deps.hookEvents.listBySession(sessionId, 1).at(-1)?.id ?? 0;
    const opened = await openSessionTerminal(deps, sessionId, undefined, opts);
    if (!opened.ok) return { ok: false, error: opened.error };
    let alive = false;
    for (let i = 0; i < 60; i++) {
      // 15s 预算：冷启动 + 宿主落 SessionStart 的实测富余
      const recent = deps.hookEvents.listBySession(sessionId, 20);
      if (recent.some((e) => e.id > baseline && e.eventType === 'SessionStart')) {
        return { ok: true, ack: 'session-start' };
      }
      if ((deps.livenessOf?.() ?? combinedLivenessOf()).get(sessionId) === true) alive = true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return alive ? { ok: true, ack: 'registry' } : { ok: false, error: 'session did not report ready within 15s' };
  };
  return (sessionId, opts) => {
    const key = opts?.cwd ? `${sessionId}\u0000${opts.cwd}` : sessionId;
    const existing = opening.get(key);
    if (existing) return existing;
    const task = ensure(sessionId, opts).finally(() => opening.delete(key));
    opening.set(key, task);
    return task;
  };
}
