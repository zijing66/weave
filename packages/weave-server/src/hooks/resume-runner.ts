import { CLAUDE_RESUME, type ResumeCommandSpec } from '@weavecode/harness';
import type { HookDispatchRepository, HookDispatchRow } from '../repositories/hook-dispatches.js';
import type { SessionRepository } from '../repositories/sessions.js';
import type { ProjectRepository } from '../repositories/projects.js';
import type { HookEventBus } from './bus.js';
import {
  HeadlessRunner,
  type HeadlessSettleResult,
  type SpawnLike,
} from './headless-runner.js';

export type { SpawnChild, SpawnLike } from './headless-runner.js';

/**
 * D3 指令池 resume 执行器：把 pending / injected 的 dispatch 用
 * `claude --resume <sessionId> -p <prompt>` 在项目根下异步执行，
 * 退出后回写 succeeded/failed/timeout 并广播 bus dispatch.finished。
 *
 * 批 4b：bin/args 规格迁入 `@weavecode/harness` 的 `CLAUDE_RESUME`
 * （ResumeCommandSpec 注入，缺省 = 现行为）；claudeBin / WEAVE_CLAUDE_BIN
 * 覆盖窗保留。
 *
 * session-orchestration 批 1：spawn/输出收集/超时/并发闸抽入 HeadlessRunner
 * （与消息域 MessageDeliverer 共享同一实例 = 同会话并发闸跨域生效）；本类只保留
 * dispatch 域的校验链与状态回写。
 *
 * run() 只做「校验 → 置 running → spawn」并立即返回（HTTP「已启动」语义）；
 * 等待退出、超时强杀、状态回写全部走后台，校验后任何异常内部消化为 failed，
 * 绝不 throw 出 run()。
 */

export interface ResumeRunnerDeps {
  dispatches: HookDispatchRepository;
  sessions: SessionRepository;
  projects: ProjectRepository;
  bus?: HookEventBus;
  /** 测试注入的 spawn 实现；缺省用 node:child_process.spawn。 */
  spawnImpl?: SpawnLike;
  /** 测试注入的强杀实现（缺省：Windows 下 taskkill，POSIX 杀进程组）。 */
  killImpl?: (pid: number) => void;
  /** claude 可执行文件名覆盖（测试用）；缺省环境变量，再缺省 spec.bin。 */
  claudeBin?: string;
  /** 批 4b：resume 命令规格注入；缺省 CLAUDE_RESUME（与现行为等价）。 */
  resumeSpec?: ResumeCommandSpec;
  /** 单次 resume 超时（毫秒），超时强杀 → timeout；缺省 300_000，测试传短值。 */
  timeoutMs?: number;
  /** 共享无头执行核（跨域同会话并发闸）；缺省自建（测试隔离用）。 */
  headless?: HeadlessRunner;
}

/** run() 的返回：ok 由路由映射 200，否则 status 即 HTTP 码。 */
export type RunResult =
  | { ok: true; dispatchId: number }
  | { ok: false; status: 400 | 404 | 409; error: string };

/** 终态（也是 bus dispatch.finished 允许的 status）。 */
type FinalStatus = 'succeeded' | 'failed' | 'timeout';

export class ResumeRunner {
  private readonly headless: HeadlessRunner;
  private readonly claudeBin: string;
  private readonly resumeSpec: ResumeCommandSpec;
  private readonly timeoutMs?: number;

  constructor(private readonly deps: ResumeRunnerDeps) {
    this.headless =
      deps.headless ?? new HeadlessRunner({ spawnImpl: deps.spawnImpl, killImpl: deps.killImpl });
    this.resumeSpec = deps.resumeSpec ?? CLAUDE_RESUME;
    // Windows 上 claude 常是 claude.cmd，spawn 不经 shell 不解析 .cmd ——
    // 生产细节主会话后续可补 PATH/后缀解析；测试经 claudeBin 注入不走真实路径。
    this.claudeBin = deps.claudeBin ?? process.env.WEAVE_CLAUDE_BIN ?? this.resumeSpec.bin;
    this.timeoutMs = deps.timeoutMs;
  }

  /**
   * 执行一条 dispatch 的 resume。校验链顺序（规格）：
   * dispatch 404 → 状态非 pending/injected 409 → session 404 → 无项目根 400
   * → 同 session 并发 409；通过后置 running + spawn，立即返回 ok。
   */
  async run(dispatchId: number, sessionId: string): Promise<RunResult> {
    const dispatch = this.deps.dispatches.getById(dispatchId);
    if (!dispatch) return { ok: false, status: 404, error: 'Dispatch not found' };
    if (dispatch.status !== 'pending' && dispatch.status !== 'injected') {
      return { ok: false, status: 409, error: `Dispatch is ${dispatch.status}` };
    }
    const session = this.deps.sessions.getBySessionId(sessionId);
    if (!session) return { ok: false, status: 404, error: 'Session not found' };
    if (session.projectId == null) {
      return { ok: false, status: 400, error: 'Session has no project' };
    }
    const project = this.deps.projects.getById(session.projectId);
    if (!project) return { ok: false, status: 400, error: 'Project not found for session' };
    if (this.headless.isBusy(sessionId)) {
      return { ok: false, status: 409, error: 'Session already has a running dispatch' };
    }

    // 校验通过：置 running + started。本段无 await，与并发闸不存在交错窗口。
    const state = { settled: false };
    try {
      this.deps.dispatches.updateStatus(dispatchId, { status: 'running' });
      this.deps.bus?.emit({
        kind: 'dispatch.started',
        ruleId: dispatch.ruleId,
        dispatchId,
        sessionId,
        at: new Date().toISOString(),
      });
      const started = this.headless.run({
        sessionId,
        cwd: project.path,
        prompt: dispatch.prompt,
        spec: this.resumeSpec,
        bin: this.claudeBin,
        timeoutMs: this.timeoutMs,
        onSettle: (result) => this.settle(dispatch, sessionId, state, result),
      });
      if (!started) {
        // isBusy 检查与 run 之间的交错输家（同会话另一域先占闸）
        this.settle(dispatch, sessionId, state, {
          status: 'failed',
          output: null,
          error: 'Session already has a running dispatch',
        });
      }
    } catch (err) {
      // 校验后任何异常一律降级 failed（HTTP 仍按「已启动」返回，状态可轮询）。
      this.settle(dispatch, sessionId, state, {
        status: 'failed',
        output: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { ok: true, dispatchId };
  }

  /** 终态落定（幂等）：回写状态 → 广播 finished；内部消化一切异常。 */
  private settle(
    dispatch: HookDispatchRow,
    sessionId: string,
    state: { settled: boolean },
    result: HeadlessSettleResult,
  ): void {
    if (state.settled) return;
    state.settled = true;
    try {
      this.deps.dispatches.updateStatus(dispatch.id, {
        status: result.status as FinalStatus,
        output: result.output,
        error: result.error,
        finished: true,
      });
      this.deps.bus?.emit({
        kind: 'dispatch.finished',
        ruleId: dispatch.ruleId,
        dispatchId: dispatch.id,
        status: result.status as FinalStatus,
        sessionId,
        at: new Date().toISOString(),
      });
    } catch {
      // 回写失败只吞掉：settle 运行在后台事件回调里，不允许异常冒泡。
    }
  }
}
