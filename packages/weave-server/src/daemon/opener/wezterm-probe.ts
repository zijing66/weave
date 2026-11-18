/**
 * wezterm 探针：对活实例（mux socket）的**子进程观测通道**——`wezterm cli` 捕获
 * 调用、活跃 client 解析、GUI pid 判活、socket 候选发现、探活闸（冷却/坏账）、
 * lastGood 快照回落、世界读取（`weztermLiveMuxes`/缓存/按 id 点名）。
 *
 * 世界映射的纯函数（screens/targets/counts/分屏规划）在 `wezterm-mux.ts`；
 * 本文件只管「怎么把世界问出来」，不管「问出来怎么算」。
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  parseWeztermPanes,
  weztermMuxKey,
  type WeztermPaneInfo,
} from './wezterm-mux.js';


/** 活跃 client：workspace + idle 毫秒（idle 还用来在多个 mux 之间选最活跃的）。 */
interface WeztermActiveClient {
  workspace: string;
  idleMs: number;
}

/** list-clients JSON → idle 最小的 client；坏输入/无有效 client → null。 */
export function weztermActiveClient(jsonText: string | null): WeztermActiveClient | null {
  if (!jsonText) return null;
  let clients: unknown;
  try {
    clients = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!Array.isArray(clients)) return null;
  let best: WeztermActiveClient | null = null;
  for (const c of clients) {
    const client = c as { workspace?: unknown; idle_time?: { secs?: unknown; nanos?: unknown } };
    if (typeof client?.workspace !== 'string' || !client.workspace) continue;
    const idle = client.idle_time;
    const idleMs =
      (typeof idle?.secs === 'number' ? idle.secs * 1e3 : 0) +
      (typeof idle?.nanos === 'number' ? idle.nanos / 1e6 : 0);
    if (best === null || idleMs < best.idleMs) {
      best = { workspace: client.workspace, idleMs };
    }
  }
  return best;
}

/** list-clients JSON → 最近活跃（idle 最小）client 的 workspace；坏输入 null。 */
export function weztermActiveWorkspaceOf(jsonText: string | null): string | null {
  return weztermActiveClient(jsonText)?.workspace ?? null;
}

const CAPTURE_TIMEOUT_MS = 5000;
/** 低频一次性动作（新窗 spawn / 唤出 activate-pane / 关 pane kill-pane）单独放宽：
 *  mux IPC 迟滞实测可拖到分钟级、超时往往只是回执晚到动作已成——多等无害（7ae0de27 先例）。 */
const SLOW_ACTION_TIMEOUT_MS = 30_000;
export { SLOW_ACTION_TIMEOUT_MS };

/** 捕获型子调用结果：ok=rc0 且未超时；out/err 供上层拼错误文案。 */
export interface CaptureResult {
  ok: boolean;
  out: string;
  err: string;
  timedOut: boolean;
}

/**
 * 捕获型子调用（与 fire-and-forget 的 trySpawn 相对）：null = 进程起不来
 * （ENOENT 等）；其余带 rc/stdout/stderr。daemon 侧查世界的通道都走它
 * （wezterm cli / osascript / ps / lsof / wt 进程表）。
 */
export function captureCommand(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs: number = CAPTURE_TIMEOUT_MS,
): Promise<CaptureResult | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, env: env ?? process.env });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (r: CaptureResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    // 计时到点即 resolve——kill 对卡死进程可能无效，不 resolve 会挂死；
    // 废料管+unref，免得杀不掉的孤儿子进程拖着 daemon 事件loop
    const timer = setTimeout(() => {
      child.stdout.destroy();
      child.stderr?.destroy();
      child.unref();
      child.kill();
      finish({ ok: false, out, err: err.trim(), timedOut: true });
    }, timeoutMs);
    timer.unref();
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      finish({ ok: code === 0, out, err: err.trim(), timedOut: false });
    });
  });
}

/**
 * wezterm cli 子调用：null = 进程起不来（ENOENT 等）；其余带 rc/stdout/stderr。
 * socket 非空时经 WEZTERM_UNIX_SOCKET 指定 mux——daemon 不在 pane 里，没有
 * wezterm 注入的这个 env，不显式点名就会去连默认 sock/残留 socket 而误判。
 *
 * 恒带 `--no-auto-start`：cli 缺省「连不上 socket 就原地拉起 wezterm-mux-server
 * --daemonize」——该进程永不退出、还继承调用方的 stdio 管道把探活挂到超时，对着
 * 陈旧/失联 socket 探一次就泄一个（实测攒过 16 个，复盘见 docs/DECISIONS.md）。
 * 带上后连不上是干净的 rc≠0，probeGate 据此判永久死。
 */
export function weztermCli(
  args: string[],
  socket: string,
  timeoutMs?: number,
): Promise<CaptureResult | null> {
  return captureCommand(
    'wezterm',
    weztermCliArgs(args),
    { ...process.env, WEZTERM_UNIX_SOCKET: socket },
    timeoutMs,
  );
}

/** cli 子命令参数 → 补上 `--no-auto-start`（须落在 `cli` 与子命令之间）。 */
export function weztermCliArgs(args: readonly string[]): string[] {
  return args[0] === 'cli' ? ['cli', '--no-auto-start', ...args.slice(1)] : [...args];
}

/** cli 步骤失败的诊断文案：socket + 命令 + stderr/超时，经路由 400 → 前端 toast。 */
export function weztermStepError(args: string[], socket: string, r: CaptureResult | null, timeoutMs = CAPTURE_TIMEOUT_MS): string {
  const cmd = `wezterm[${basename(socket)}] ${args.join(' ')}`;
  if (r === null) return `${cmd}: executable not found`;
  if (r.timedOut) return `${cmd}: timed out after ${timeoutMs}ms`;
  return r.err ? `${cmd}: ${r.err}` : `${cmd}: exited with failure`;
}

/** gui-sock-<pid> 文件名自带 GUI 进程 pid，signal 0 探活。 */
function weztermPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * `gui-sock-<pid>` 那个 pid 是否**真是它的 GUI**。pid 会被复用，`weztermPidAlive`
 * 只答「有进程占着这个号」——死 socket 因此能一直冒充活实例（实测 GUI 50172 死后，
 * daemon 仍每隔一分钟对着它的 socket spawn 一次 `wezterm cli`）。
 * 只在该 socket 探活已经失败后调用：这时多花一枪 tasklist 不算什么。
 */
export async function weztermGuiAlive(pid: number): Promise<boolean> {
  if (!weztermPidAlive(pid)) return false;
  if (process.platform !== 'win32') return true;
  const listed = await captureCommand(
    'tasklist',
    ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
    undefined,
    2000,
  );
  return listed?.ok === true && /wezterm-gui\.exe/i.test(listed.out);
}

/**
 * socket 路径 → 它绑定的 GUI 进程 pid（`gui-sock-<pid>`）；非该形态返回 null——
 * 判死无据时宁可只冷却，也不永久拉黑。
 */
export function weztermGuiPidOf(socket: string): number | null {
  const m = /gui-sock-(\d+)$/.exec(socket.replace(/\\/g, '/'));
  return m ? Number(m[1]) : null;
}

/**
 * 该 socket 路径是否**确定已死**（`gui-sock-<pid>` 的 GUI 进程没了）：路径与 GUI
 * pid 绑定，pid 死则路径永久失效（新 GUI 必然是新 pid → 新路径）。同步零 spawn
 * ——定位链拿它做死 socket 快速失败，不白等一枪 5s 超时。非 gui-sock 形态判死
 * 无据，恒 false（照旧交给探活）。
 */
export function weztermSocketPathDead(socket: string): boolean {
  const pid = weztermGuiPidOf(socket);
  return pid !== null && !weztermPidAlive(pid);
}

/** 目录下 pid 仍活的 gui-sock 完整路径（pid 大→小 ≈ 新→旧）；io 失败当空目录。
 * 排序不碰 stat：win 下 AF_UNIX socket 文件 statSync 一律 EACCES。 */
function weztermGuiSocksIn(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const live: { path: string; pid: number }[] = [];
  for (const name of names) {
    const m = /^gui-sock-(\d+)$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!weztermPidAlive(pid)) continue;
    live.push({ path: join(dir, name), pid });
  }
  return live.sort((a, b) => b.pid - a.pid).map((s) => s.path);
}

/**
 * socket 字符串 → 比较键。win 下 wezterm 注进 pane env 的路径是**混合分隔符**
 * （`D:\Users\x\.local/share/wezterm/gui-sock-<pid>`），而 join() 拼出候选时是
 * 全反斜杠——同一 socket 两种形态，裸 Set 去重失效会把同一 mux 记成两个候选，
 * 窗口计数按 (socket, windowId) 去重也随之翻倍。
 */
function socketCompareKey(path: string, platform: NodeJS.Platform): string {
  const s = path.replace(/\\/g, '/');
  return platform === 'win32' ? s.toLowerCase() : s;
}

/**
 * 候选 mux socket：进程 env 显式指定的最优先（daemon 一般没有，pane 内才有），
 * 其次存活 GUI 的 gui-sock-*（新的在前 ≈ 最近开的 wezterm 实例）。
 * 跳过裸 `sock`：默认 socket 不按 GUI pid 命名、判活无据——历史教训是 cli 对它
 * 原地拉起幽灵 server 后 rc=0 返回空世界、假成功一轮接一轮（见 DECISIONS）；
 * wezterm 注进 pane env 的恒是 gui-sock-<pid>，跳过它不丢发现面。
 */
export function weztermSocketCandidates(platform: NodeJS.Platform): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (path: string): void => {
    const key = socketCompareKey(path, platform);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(path);
  };
  // env 那支与目录扫描同一条判据：`gui-sock-<pid>` 的 GUI 进程已死 = 这段路径永久
  // 失效。不过这一关，daemon 从旧 pane 继承来的死 socket 会一直留在候选里——探活闸
  // 挡不住 force（投递/作答按 mux 键点名时恒探它），实测每隔一分钟白 spawn 一次
  // `wezterm cli`。非 gui-sock 形态（自定义 socket）判死无据，照旧交给探活。
  const envSocket = process.env.WEZTERM_UNIX_SOCKET;
  if (envSocket) {
    const pid = weztermGuiPidOf(envSocket);
    if (pid === null || weztermPidAlive(pid)) push(envSocket);
  }
  const home = platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
  if (home) weztermGuiSocksIn(join(home, '.local', 'share', 'wezterm')).forEach(push);
  if (platform !== 'win32' && process.env.XDG_RUNTIME_DIR) {
    weztermGuiSocksIn(join(process.env.XDG_RUNTIME_DIR, 'wezterm')).forEach(push);
  }
  return out;
}

/** 一个探活通过的 mux：socket + pane 世界 + 活跃 client（workspace 与 idle）。 */
export interface WeztermMux {
  socket: string;
  panes: WeztermPaneInfo[];
  workspace: string | null;
  idleMs: number;
}

/** 探活超时后回避多久（可能只是 GUI 忙，不是死了）。 */
const PROBE_TIMEOUT_COOLDOWN_MS = 60_000;

/**
 * 探活失败的 socket 记忆——避免对已知坏 socket 反复 spawn `wezterm cli`。
 *
 * 为什么需要：陈旧的 `gui-sock-<pid>` 不会自己消失（wezterm 退出不清理，实测
 * 攒到过 48 个），对它们反复 spawn 纯属浪费（`--no-auto-start` 后死 socket
 * 是快速 rc≠0，不再是当年「原地拉起幽灵 mux-server、探活 >250s 不返回」的
 * 自伤——复盘见 docs/DECISIONS.md）。
 *
 * 判据的分寸：socket 路径与 GUI 的 pid 绑定，**进程死则该路径永久失效**（新 GUI
 * 必然是新 pid → 新路径），所以「干净的非零退出 + 这个 GUI 进程真没了」可以永久
 * 记住；而**超时/起不来/进程还活着却答不上来只算可疑**（本机 GUI 常年在 4~6 核，
 * 5s 内答不上来是可能的），只短期回避，免得把活着的 GUI 误判死。
 */
export class SocketProbeGate {
  private readonly dead = new Set<string>();
  private readonly cooling = new Map<string, number>();

  /** 这一轮要不要探它。 */
  shouldProbe(socket: string, now: number = Date.now()): boolean {
    if (this.dead.has(socket)) return false;
    const until = this.cooling.get(socket);
    return until === undefined || now >= until;
  }

  /** 探活成功：它活着，清掉回避态。 */
  succeeded(socket: string): void {
    this.cooling.delete(socket);
  }

  /** 干净的非零退出（socket 层失败）→ 该路径永久失效。 */
  failed(socket: string): void {
    this.dead.add(socket);
    this.cooling.delete(socket);
  }

  /** 超时 / 可执行起不来 → 只回避一段时间。 */
  cooledDown(socket: string, now: number = Date.now()): void {
    if (this.dead.has(socket)) return;
    this.cooling.set(socket, now + PROBE_TIMEOUT_COOLDOWN_MS);
  }
}

/** 进程内的探活失败记忆（见 SocketProbeGate）。 */
export const probeGate = new SocketProbeGate();

/**
 * 各 socket 最近一次成功枚举的 pane 快照（light 探测的「陈旧兜底」数据源）。
 * 半死实例每次重探都 5s 超时 → 探活闸冷却 60s，冷却窗里它缺席枚举表——counts/
 * hidden 是整包替换的，窗口数与隐藏态跟着周期性丢失（用户可见的角标闪没）。
 * light（只服务计数/分组这类展示面）探不到时回退这份快照：显示滞后无感，
 * run 落点决策恒走实时全量、不吃它。
 */
const lastGoodPanes = new Map<string, WeztermPaneInfo[]>();
const lastGoodAt = new Map<string, number>();
const LAST_GOOD_MAX_AGE_MS = 10 * 60_000;

/** lastGood 快照兜底（light 与全量路径共用；快照过期 = 当没有）。 */
function lastGoodFallback(socket: string): WeztermMux | null {
  const snapAt = lastGoodAt.get(socket) ?? 0;
  const snap = lastGoodPanes.get(socket);
  if (snap && Date.now() - snapAt < LAST_GOOD_MAX_AGE_MS) {
    return { socket, panes: snap, workspace: null, idleMs: Number.POSITIVE_INFINITY } satisfies WeztermMux;
  }
  return null;
}


/**
 * 逐候选探活（单次 5s 超时兜底挂死的 GUI）；返回活 mux 与候选清单（报错用）。
 * light = 只取计数要的字段（socket+panes）：跳过 `list-clients`（每 socket 省
 * 一半 spawn），workspace/idleMs 留空——仅供 `weztermLiveMuxesCached`（计数）用，
 * run/落点决策恒走全量。候选**并行**探：串行时 N 个 mux 的墙钟是 N×，
 * 事件循环饱和窗口里被排队放大成秒级。
 */
export async function weztermLiveMuxes(
  light = false,
  force: string | null = null,
): Promise<{ muxes: WeztermMux[]; candidates: string[] }> {
  const candidates = force ? [force] : weztermSocketCandidates(process.platform);
  const muxes = (
    await Promise.all(
      candidates.map(async (socket) => {
        // 已知坏的 socket 不再重探：省 spawn，半死的 GUI 也不必反复挂满 5s 超时。
        // force（投递路径已确定的那个 socket）不受闸约束：冷却期只为「扫全部候选」
        // 省 spawn，而投递一次只炸一发、且目标已知——让冷却挡住它 = 冷却窗口里
        // 所有会话的停止/作答全都 409（点了没反应）。
        if (!force && !probeGate.shouldProbe(socket)) {
          // 冷却窗 ≠ socket 死了（只是上一轮超时/可疑）：照失败拍同口径回退
          // lastGood 快照——否则冷却 60s 里 muxes 空，counts 整包归零、refresher
          // 把全 0 当真实世界推帧（角标周期性闪没的成因）；全量路径同样受益：
          // 目标缺席 = 会话分块/可见性全班摘牌（探测打摆的成因）。
          return lastGoodFallback(socket);
        }
        const listed = await weztermCli(['cli', 'list', '--format', 'json'], socket);
        if (!listed?.ok) {
          // 永久判死只认「这个 GUI 进程真没了」——路径与 GUI pid 绑定，pid 死则
          // 该路径永久失效（新 GUI 必然是新 pid → 新路径）。**不能用 existsSync**：
          // win 下 AF_UNIX socket 文件 statSync 一律 EACCES、existsSync 恒 false，
          // 一次偶发非零退出就会把活实例按到 daemon 重启为止（分块掉行、停止键
          // 全班失效的成因）。进程还在却退出非零 = GUI 忙 / 瞬时拒绝 → 只冷却。
          const guiPid = weztermGuiPidOf(socket);
          if (listed && !listed.timedOut && guiPid !== null && !(await weztermGuiAlive(guiPid))) {
            probeGate.failed(socket);
            lastGoodPanes.delete(socket);
          } else probeGate.cooledDown(socket);
          // 探不到但进程还活着 → 回退最近一次成功的 pane 快照，别让半死实例的
          // 窗口数与隐藏态在冷却窗里周期性闪没。快照过期才当没有。
          if (listed) return lastGoodFallback(socket);
          return null;
        }
        probeGate.succeeded(socket);
        let panes = parseWeztermPanes(listed.out);
        if (panes.length > 0) {
          lastGoodPanes.set(socket, panes);
          lastGoodAt.set(socket, Date.now());
        } else {
          // rc0 但 pane 表空（GUI 忙时 list 偶发空世界，实测形态）：这不是「用户
          // 关光了」的可信信号——照失败拍同口径回退 lastGood，别让分块/角标在
          // 「空世界一拍」里集体摘掉再回来（眼睛闪没的成因）。快照过期才信空。
          const snapAt = lastGoodAt.get(socket) ?? 0;
          const snap = lastGoodPanes.get(socket);
          if (snap && Date.now() - snapAt < LAST_GOOD_MAX_AGE_MS) panes = snap;
        }
        if (light) return { socket, panes, workspace: null, idleMs: Number.POSITIVE_INFINITY } satisfies WeztermMux;
        const clients = await weztermCli(['cli', 'list-clients', '--format', 'json'], socket);
        const active = weztermActiveClient(clients?.ok ? clients.out : null);
        return {
          socket,
          panes,
          workspace: active?.workspace ?? null,
          idleMs: active?.idleMs ?? Number.POSITIVE_INFINITY,
        } satisfies WeztermMux;
      }),
    )
  ).filter((m): m is WeztermMux => m !== null);
  return { muxes, candidates };
}

/**
 * 探活结果短缓存（10s）：角标的周期探测 + 开窗后对账 + GET 后台对账会在
 * 瞬间打多枪，缓存挡掉重复 spawn——一枪要对**每个存活 socket** spawn 一次
 * `wezterm cli list`（实测 wall ~180ms / CPU 62–125ms；残留幽灵 GUI 会把
 * socket 数放大）。**只给计数/分组用**（light 探测，workspace/idle 留空）：
 * runInWezterm 的落点决策必须看实时世界（缓存会让分屏落到刚关掉的 pane）。
 */
let muxCache: { at: number; muxes: WeztermMux[]; candidates: string[] } | null = null;

export async function weztermLiveMuxesCached(): Promise<{ muxes: WeztermMux[]; candidates: string[] }> {
  if (muxCache && Date.now() - muxCache.at < 10000) return muxCache;
  const { muxes, candidates } = await weztermLiveMuxes(true);
  muxCache = { at: Date.now(), muxes, candidates };
  return muxCache;
}

/** 探活缓存作废（用户主动的终端动作后，紧随的对账必须看实时世界——否则角标
 *  与会话分组要挂着旧 pane 表残留到缓存过期）。 */
export function invalidateWeztermMuxCache(): void {
  muxCache = null;
}

/**
 * pane id 里的 mux 短标识 → 那个 mux。**只探它那一个 socket**（绕过探活闸）：
 * 击键/投递已知目标，全量扫是白花 spawn，且冷却期会把「实例还在」误判成
 * 「实例没了」→ 停止键静默失败。
 */
export async function weztermMuxForId(muxKey: string): Promise<WeztermMux | null> {
  const socket = weztermSocketCandidates(process.platform).find(
    (s) => weztermMuxKey(s) === muxKey,
  );
  if (!socket) return null;
  // 死实例（GUI pid 没了）快速失败：路径永久失效，force 探它只是白等一枪超时。
  if (weztermSocketPathDead(socket)) return null;
  const { muxes } = await weztermLiveMuxes(true, socket);
  return muxes.find((m) => weztermMuxKey(m.socket) === muxKey) ?? null;
}
