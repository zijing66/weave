import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import type { ResumeCommandSpec } from '@weavecode/harness';

/**
 * 无头回合执行核心（session-orchestration 批 1 自 resume-runner 抽出）：
 * spawn `spec.args(sessionId, prompt)`、输出收集、超时强杀、**跨域共享的同会话
 * 并发闸**——指令池派发（ResumeRunner）与点对点消息（MessageDeliverer）用同一
 * 实例，两个 claude --resume 进程绝不落在同一会话上。
 *
 * run() 同步返回（「已启动」语义）；等待退出、超时、onSettle 回调全走后台，
 * 任何异常内部消化为 failed 终态，绝不 throw。
 */

/** 子进程句柄的最小结构：真实 ChildProcess 与测试的 EventEmitter fake 都满足。 */
export interface SpawnChild {
  pid?: number;
  /** listener 用 `(...args: never[]) => void`：never 可赋给任意具体参数类型，
   *  调用方得以直接写 `(code: number | null) => …` 而无需类型断言。 */
  on(event: string, listener: (...args: never[]) => void): unknown;
  stdin?: { on(event: string, listener: (...args: never[]) => void): unknown; write(chunk: string): unknown; end(): unknown } | null;
  stdout?: { on(event: string, listener: (...args: never[]) => void): unknown } | null;
  stderr?: { on(event: string, listener: (...args: never[]) => void): unknown } | null;
}

/** 测试注入的 spawn 签名；缺省用 node:child_process.spawn。 */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnChild;

export interface HeadlessSettleResult {
  status: 'succeeded' | 'failed' | 'timeout';
  output: string | null;
  error: string | null;
}

export interface HeadlessRunInput {
  sessionId: string;
  cwd: string;
  prompt: string;
  spec: ResumeCommandSpec;
  bin: string;
  /** 单次超时（毫秒），超时强杀 → timeout；**0 = 不设看门狗**（投递等待发生在
   *  目标会话内的场景，如 prompt 中继——设上限只会把正常投递误判成 timeout）。 */
  timeoutMs?: number;
  /**
   * 是否自成进程组（POSIX `detached`）。缺省 true——headless 回合跑得长、可整组
   * 强杀。**中继传 false**：它是本轮次的一次性子进程，应当跟 daemon 同进程组、
   * 随 daemon 退出被回收，不留独立进程占资源。win32 shell 模式恒 false（实测
   * shell+detached 管道输出全丢）。
   */
  detached?: boolean;
  onSettle: (result: HeadlessSettleResult) => void;
}

export interface HeadlessRunnerDeps {
  /** 测试注入的 spawn 实现；缺省用 node:child_process.spawn。 */
  spawnImpl?: SpawnLike;
  /** 测试注入的强杀实现（缺省：Windows 下 taskkill，POSIX 杀进程组）。 */
  killImpl?: (pid: number) => void;
}

const DEFAULT_TIMEOUT_MS = 300_000;
/** stdout / stderr 各自的截断上限（合并为 output）。 */
const MAX_STREAM_BYTES = 32 * 1024;
/** failed 时 error 里附带的 stderr 尾部长度。 */
const MAX_ERROR_TAIL = 2_000;

export class HeadlessRunner {
  private readonly spawnImpl: SpawnLike;
  private readonly killImpl: (pid: number) => void;
  /** sessionId → 进行中的回合（并发闸）；终态落定后清除。 */
  private readonly active = new Set<string>();
  /** sessionId → 在飞子进程 pid（daemon 退出时统一回收；终态/退出后清除）。 */
  private readonly livePids = new Map<string, number>();

  constructor(deps: HeadlessRunnerDeps = {}) {
    this.spawnImpl = deps.spawnImpl ?? nodeSpawn;
    this.killImpl = deps.killImpl ?? defaultKill;
  }

  /** 该会话是否已有无头回合在跑（跨 dispatch/message 域共享）。 */
  isBusy(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /**
   * 回收全部在飞子进程（daemon 退出时调用）：这些进程是 daemon 的子进程，
   * 不该比 daemon 活得久。win32 → taskkill /T /F（整棵进程树）；POSIX →
   * 先杀进程组（detached 子进程自成组）再回退单进程（非 detached 的子进程，
   * 如中继）——三平台同一入口，无平台分支。返回强杀尝试数。
   */
  killAll(): number {
    let killed = 0;
    for (const pid of this.livePids.values()) {
      try {
        this.killImpl(pid);
        killed++;
      } catch {
        // 进程可能已退出：忽略
      }
    }
    this.livePids.clear();
    return killed;
  }

  /**
   * 启动一次无头回合：同会话已占用返回 false（调用方映射 409）。
   * 通过后立即返回 true；终态经 onSettle 后台送达。
   */
  run(input: HeadlessRunInput): boolean {
    if (this.active.has(input.sessionId)) return false;
    this.active.add(input.sessionId);
    const state = { settled: false };
    try {
      this.watch(input, state);
    } catch (err) {
      // spawn 同步异常也走终态路径（闸已占，必须释放）
      this.settle(input, state, { status: 'failed', output: null, error: toMessage(err) });
    }
    return true;
  }

  /** spawn 并挂上输出收集 / 退出 / 超时监听；同步完成，不等待退出。 */
  private watch(input: HeadlessRunInput, state: { settled: boolean }): void {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // promptStdin 规格：prompt 走 stdin、命令行只剩 bin+固定参数+sessionId。
    // win32 的 claude 是 .cmd shim（CreateProcess 不认，不经 shell 必 ENOENT），
    // 此时命令行整体（裸名 bin + 无用户内容）作为单串经 shell 启动——无注入面，
    // 也不触发 node 对 args+shell 的 DEP0190 警告；detached 必须关掉（实测
    // win32 下 shell+detached 管道输出全丢、只余 exit code）。bin 是带路径的
    // 覆盖值（可能含空格）时不走 shell，按真实 exe 直接 spawn。
    const viaStdin = input.spec.promptStdin === true;
    const args = input.spec.args(input.sessionId, viaStdin ? '' : input.prompt);
    const useShell =
      viaStdin && process.platform === 'win32' && !/[\s"\\/]/.test(input.bin);
    // detached：POSIX 自成进程组（超时可整组强杀）；中继显式 false = 本轮次的
    // 子进程，跟 daemon 同组、随 daemon 退出被回收。win32 恒 false（shell 模式
    // 实测丢管道输出；非 shell 模式 taskkill /T 已能杀整棵树，无须进程组）。
    const detached = (input.detached ?? true) && !useShell;
    const options: SpawnOptions = {
      cwd: input.cwd,
      detached,
      windowsHide: true,
      shell: useShell,
      stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      // 递归标记：子进程派生的后代也能识别「weave 发起」。
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
    const child = useShell
      ? this.spawnImpl([input.bin, ...args].join(' '), [], options)
      : this.spawnImpl(input.bin, args, options);
    // 记在飞子进程：daemon 退出时统一回收（killAll），不留孤儿占资源。
    if (child.pid !== undefined) this.livePids.set(input.sessionId, child.pid);

    if (viaStdin) {
      // EPIPE（子进程未读完先退）吞掉；终态由 exit/error 事件落定。
      child.stdin?.on('error', () => {});
      try {
        child.stdin?.write(input.prompt);
        child.stdin?.end();
      } catch {
        // 同步写失败同上：不影响终态路径
      }
    }

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

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (child.pid !== undefined) {
              try {
                this.killImpl(child.pid);
              } catch {
                // 强杀失败也照落 timeout（进程可能已自行退出）
              }
            }
            this.settle(input, state, {
              status: 'timeout',
              output: collectOutput(),
              error: `Timeout after ${timeoutMs}ms`,
            });
          }, timeoutMs)
        : null;

    child.on('error', (err: Error) => {
      if (timer !== null) clearTimeout(timer);
      this.settle(input, state, {
        status: 'failed',
        output: collectOutput(),
        error: toMessage(err),
      });
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (timer !== null) clearTimeout(timer);
      const output = collectOutput();
      if (code === 0) {
        this.settle(input, state, { status: 'succeeded', output, error: null });
        return;
      }
      const label = code !== null ? `exit ${code}` : `exit signal ${signal ?? 'unknown'}`;
      const tail = stderrTail();
      this.settle(input, state, {
        status: 'failed',
        output,
        error: tail ? `${label}\n${tail}` : label,
      });
    });
  }

  /** 终态落定（**按次**幂等）：守卫是本次 run 的 state 标志而非共享闸——同会话
   * 前一回合的迟到事件不得吞掉后一回合的 settle。清闸 → 回调 onSettle；回调
   * 异常只吞（后台回调不冒泡）。 */
  private settle(input: HeadlessRunInput, state: { settled: boolean }, result: HeadlessSettleResult): void {
    if (state.settled) return;
    state.settled = true;
    this.active.delete(input.sessionId);
    this.livePids.delete(input.sessionId);
    try {
      input.onSettle(result);
    } catch {
      // 回调内回写失败只吞掉：settle 运行在后台事件回调里，不允许异常冒泡。
    }
  }
}

/** 默认强杀：Windows 用 taskkill 杀进程树；POSIX 杀 detached 进程组，失败回退单进程。 */
export function defaultKill(pid: number): void {
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
