import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import type { HookDispatchRepository, HookDispatchRow } from '../repositories/hook-dispatches.js';
import type { SessionRepository } from '../repositories/sessions.js';
import type { ProjectRepository } from '../repositories/projects.js';
import type { HookEventBus } from './bus.js';

/**
 * D3 指令池 resume 执行器：把 pending / injected 的 dispatch 用
 * `claude --resume <sessionId> -p <prompt>` 在项目根下异步执行，
 * 退出后回写 succeeded/failed/timeout 并广播 bus dispatch.finished。
 *
 * run() 只做「校验 → 置 running → spawn」并立即返回（HTTP「已启动」语义）；
 * 等待退出、超时强杀、状态回写全部走后台，校验后任何异常内部消化为 failed，
 * 绝不 throw 出 run()。
 */

/** 子进程句柄的最小结构：真实 ChildProcess 与测试的 EventEmitter fake 都满足。 */
export interface SpawnChild {
  pid?: number;
  /** listener 用 `(...args: never[]) => void`：never 可赋给任意具体参数类型，
   *  调用方得以直接写 `(code: number | null) => …` 而无需类型断言。 */
  on(event: string, listener: (...args: never[]) => void): unknown;
  stdout?: { on(event: string, listener: (...args: never[]) => void): unknown } | null;
  stderr?: { on(event: string, listener: (...args: never[]) => void): unknown } | null;
}

/** 测试注入的 spawn 签名；缺省用 node:child_process.spawn。 */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnChild;

export interface ResumeRunnerDeps {
  dispatches: HookDispatchRepository;
  sessions: SessionRepository;
  projects: ProjectRepository;
  bus?: HookEventBus;
  /** 测试注入的 spawn 实现；缺省用 node:child_process.spawn。 */
  spawnImpl?: SpawnLike;
  /** 测试注入的强杀实现（缺省：Windows 下 taskkill，POSIX 杀进程组）。 */
  killImpl?: (pid: number) => void;
  /** claude 可执行文件名覆盖（测试用）；缺省环境变量或 'claude'。 */
  claudeBin?: string;
  /** 单次 resume 超时（毫秒），超时强杀 → timeout；缺省 300_000，测试传短值。 */
  timeoutMs?: number;
}

/** run() 的返回：ok 由路由映射 200，否则 status 即 HTTP 码。 */
export type RunResult =
  | { ok: true; dispatchId: number }
  | { ok: false; status: 400 | 404 | 409; error: string };

/** 终态（也是 bus dispatch.finished 允许的 status）。 */
type FinalStatus = 'succeeded' | 'failed' | 'timeout';

const DEFAULT_TIMEOUT_MS = 300_000;
/** stdout / stderr 各自的截断上限（合并为 output）。 */
const MAX_STREAM_BYTES = 32 * 1024;
/** failed 时 error 里附带的 stderr 尾部长度。 */
const MAX_ERROR_TAIL = 2_000;

export class ResumeRunner {
  private readonly spawnImpl: SpawnLike;
  private readonly killImpl: (pid: number) => void;
  private readonly claudeBin: string;
  private readonly timeoutMs: number;
  /** sessionId → 进行中的 resume（并发闸）；终态落定后清除。 */
  private readonly active = new Map<string, { dispatchId: number; pid?: number }>();

  constructor(private readonly deps: ResumeRunnerDeps) {
    this.spawnImpl = deps.spawnImpl ?? nodeSpawn;
    this.killImpl = deps.killImpl ?? defaultKill;
    // Windows 上 claude 常是 claude.cmd，spawn 不经 shell 不解析 .cmd ——
    // 生产细节主会话后续可补 PATH/后缀解析；测试经 claudeBin 注入不走真实路径。
    this.claudeBin = deps.claudeBin ?? process.env.WEAVE_CLAUDE_BIN ?? 'claude';
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    if (this.active.has(sessionId)) {
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
      this.active.set(sessionId, { dispatchId });
      this.watch(dispatch, sessionId, project.path, state);
    } catch (err) {
      // 校验后任何异常一律降级 failed（HTTP 仍按「已启动」返回，状态可轮询）。
      this.settle(dispatch, sessionId, state, 'failed', null, toMessage(err));
    }
    return { ok: true, dispatchId };
  }

  /** spawn claude 并挂上输出收集 / 退出 / 超时监听；同步完成，不等待退出。 */
  private watch(
    dispatch: HookDispatchRow,
    sessionId: string,
    cwd: string,
    state: { settled: boolean },
  ): void {
    const args = ['--resume', sessionId, '-p', dispatch.prompt];
    const options: SpawnOptions = {
      cwd,
      detached: true, // POSIX 下自成进程组，超时可整组强杀
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 递归标记：子进程派生的后代也能识别「weave hook 发起」。
      // 同时剥离 CLAUDE_CODE_CHILD_SESSION：daemon 可能启于某个 Claude Code
      // 会话内（环境继承了 child-session 标记），resume 出的是正常会话——
      // 带着标记会让新会话关闭 transcript 持久化（历史丢失）。
      env: (() => {
        const env: Record<string, string | undefined> = {
          ...process.env,
          WEAVE_HOOK_DISPATCH: '1',
        };
        delete env['CLAUDE_CODE_CHILD_SESSION'];
        return env;
      })(),
    };
    const child = this.spawnImpl(this.claudeBin, args, options);
    const active = this.active.get(sessionId);
    if (active && child.pid !== undefined) active.pid = child.pid;

    // 输出收集：stdout / stderr 各截断 32KB 后合并为 output。
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const push = (chunks: Buffer[], used: number, chunk: Buffer): number => {
      if (used >= MAX_STREAM_BYTES) return used;
      const room = MAX_STREAM_BYTES - used;
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      return used + Math.min(chunk.length, room);
    };
    const collectOutput = (): string =>
      Buffer.concat([...stdoutChunks, ...stderrChunks]).toString('utf8');
    const stderrTail = (): string => {
      const text = Buffer.concat(stderrChunks).toString('utf8');
      return text.length > MAX_ERROR_TAIL ? text.slice(-MAX_ERROR_TAIL) : text;
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes = push(stdoutChunks, stdoutBytes, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes = push(stderrChunks, stderrBytes, chunk);
    });

    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          this.killImpl(child.pid);
        } catch {
          // 强杀失败也照落 timeout（进程可能已自行退出）
        }
      }
      this.settle(
        dispatch,
        sessionId,
        state,
        'timeout',
        collectOutput(),
        `Timeout after ${this.timeoutMs}ms`,
      );
    }, this.timeoutMs);

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      this.settle(dispatch, sessionId, state, 'failed', collectOutput(), toMessage(err));
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      const output = collectOutput();
      if (code === 0) {
        this.settle(dispatch, sessionId, state, 'succeeded', output, null);
        return;
      }
      const label = code !== null ? `exit ${code}` : `exit signal ${signal ?? 'unknown'}`;
      const tail = stderrTail();
      this.settle(
        dispatch,
        sessionId,
        state,
        'failed',
        output,
        tail ? `${label}\n${tail}` : label,
      );
    });
  }

  /** 终态落定（幂等）：清并发闸 → 回写状态 → 广播 finished；内部消化一切异常。 */
  private settle(
    dispatch: HookDispatchRow,
    sessionId: string,
    state: { settled: boolean },
    status: FinalStatus,
    output: string | null,
    error: string | null,
  ): void {
    if (state.settled) return;
    state.settled = true;
    this.active.delete(sessionId);
    try {
      this.deps.dispatches.updateStatus(dispatch.id, {
        status,
        output,
        error,
        finished: true,
      });
      this.deps.bus?.emit({
        kind: 'dispatch.finished',
        ruleId: dispatch.ruleId,
        dispatchId: dispatch.id,
        status,
        sessionId,
        at: new Date().toISOString(),
      });
    } catch {
      // 回写失败只吞掉：settle 运行在后台事件回调里，不允许异常冒泡。
    }
  }
}

/** 默认强杀：Windows 用 taskkill 杀进程树；POSIX 杀 detached 进程组，失败回退单进程。 */
function defaultKill(pid: number): void {
  if (process.platform === 'win32') {
    try {
      const killer = nodeSpawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {
        // taskkill 无法启动时忽略（随后的状态已按 timeout 落定）
      });
    } catch {
      // 同步 spawn 失败也忽略
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL'); // detached 子进程自成进程组
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 进程可能已退出：忽略
    }
  }
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
