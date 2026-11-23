import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dataRoots, getAuthPath, getDataDir } from '../db/paths.js';
import { spawnOutsideJob } from '../daemon/spawn-outside-job.js';
import { isTerminalStatus, reconcileInstances } from './instance-registry.js';
import {
  runtimePipePath,
  type AgentInstanceRecord,
  type AgentInstanceStatus,
  type HostInstanceSummary,
  type InstanceSpawnPayload,
} from './protocol.js';
import { RuntimeHostClient, type HostEventFrame } from './runtime-host-client.js';
import type { AgentInstanceRepository } from '../repositories/agent-instances.js';

/** 启动重连失败后的重试间隔（Host 可能只是 tsx 冷加载慢）。 */
const RETRY_INTERVAL_MS = 30_000;
/** 周期对账间隔：把 Host 侧状态变化（exited 等）与卡死的 starting 行收进 DB。 */
const RECONCILE_INTERVAL_MS = 60_000;

/**
 * Runtime Host 监督者（agent-runtime-host-design.md §4/§8）：探测 pipe → 不通则
 * WMI 断链 spawn Host → 握手 → 三向对账。daemon 崩溃/重启期间 Host 独立存活。
 */

function resolveHostEntry(): { path: string; isTs: boolean } {
  const js = fileURLToPath(new URL('./host-entry.js', import.meta.url));
  if (existsSync(js)) return { path: js, isTs: false };
  const ts = fileURLToPath(new URL('./host-entry.ts', import.meta.url));
  return { path: ts, isTs: true };
}

export interface ReconcileResult {
  hostId: string;
  refreshed: string[];
  failed: string[];
  orphans: HostInstanceSummary[];
}

export class RuntimeSupervisor {
  private client: RuntimeHostClient | null = null;
  private hostId: string | null = null;
  private readonly eventHandlers: Array<(frame: HostEventFrame) => void> = [];
  private statusHandler: ((reachable: boolean) => void) | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  /** 已报过命的孤儿实例（增量去重；消失即除名）。 */
  private readonly knownOrphans = new Set<string>();
  /** daemon 停机后不再拉起 Host（手动停止不复活）。 */
  private stopped = false;
  /** 并发 ensureHost 共享一次连接/拉起（后台重连与用户开终端同时到达不双跑）。 */
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly repo: AgentInstanceRepository,
    /** 配置根（`dataRoots` 的 dir 语义：`<configDir>/weave`）；测试可注入。 */
    private readonly dataDir: string = getDataDir(),
    private readonly log: (msg: string) => void = (m) => console.log(`[weave-runtime-sup] ${m}`),
    /** Host 拉起实现（测试注入假实现，避免测试里真起 node 进程）。 */
    private readonly spawnImpl: (() => Promise<void>) | null = null,
  ) {}

  /** 额外的事件消费者（终端网关、资源采样等多路）。落库那一路在 connect 时恒挂，不可被挤占。 */
  onEvent(cb: (frame: HostEventFrame) => void): () => void {
    this.eventHandlers.push(cb);
    this.client?.onEvent(cb);
    return () => {
      const i = this.eventHandlers.indexOf(cb);
      if (i >= 0) this.eventHandlers.splice(i, 1);
    };
  }

  onStatus(cb: (reachable: boolean) => void): void {
    this.statusHandler = cb;
  }

  private localToken(): string {
    const authPath = getAuthPath(this.dataDir);
    const auth = existsSync(authPath)
      ? (JSON.parse(readFileSync(authPath, 'utf8')) as { localToken?: string })
      : null;
    if (!auth?.localToken) throw new Error('auth.json missing localToken — daemon has not initialized auth yet');
    return auth.localToken;
  }

  get pipePath(): string {
    return runtimePipePath(dataRoots(this.dataDir).data);
  }

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  /** 幂等确保 Host 在线（已连即复用；断线即重连/重拉）。并发调用共享同一次。 */
  async ensureHost(): Promise<void> {
    if (this.stopped) throw new Error('runtime supervisor stopped');
    if (this.client?.connected) return;
    if (this.inflight) return this.inflight;
    this.inflight = this.connect().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async connect(): Promise<void> {
    const token = this.localToken();
    for (let attempt = 0; ; attempt++) {
      const client = new RuntimeHostClient(this.pipePath, token, () => {
        this.log('runtime host disconnected');
        this.statusHandler?.(false);
        // 运行中断线也要自愈：不带这拍，断线后无新请求的窗口里 Host 永远离线
        //（reconcile interval 对 disconnected 直接 return）。
        this.scheduleRetry();
      });
      try {
        const ack = await client.connect(attempt === 0 ? 1_500 : 15_000);
        this.client = client;
        this.hostId = ack.hostId;
        // 生命周期帧**恒**落库（daemon 唯一 writer），与终端网关等消费互不覆盖。
        client.onEvent((frame) => void this.handleEvent(frame));
        for (const h of this.eventHandlers) client.onEvent(h);
        this.statusHandler?.(true);
        this.log(`connected (hostId ${ack.hostId}, ${ack.instances.length} instances)`);
        return;
      } catch {
        client.disconnect();
        if (this.stopped) throw new Error('runtime supervisor stopped');
        if (attempt >= 1) throw new Error('cannot reach or spawn the runtime host');
        await (this.spawnImpl ? this.spawnImpl() : this.spawnHost());
      }
    }
  }

  /** daemon 停机：停自愈与对账，不再拉起/重连 Host（Host 自身独立存活，不动）。 */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  private async spawnHost(): Promise<void> {
    const entry = resolveHostEntry();
    // dataDir 走 argv 而非 env：WMI Create 的进程环境来自 WmiPrvSE，不继承
    // 调用方——env 传不进去（实测 2026-11-20）。
    const args = entry.isTs
      ? ['--import', 'tsx', entry.path, this.dataDir]
      : [entry.path, this.dataDir];
    this.log(`spawning runtime host outside job: node ${args.join(' ')}`);
    if (!(await spawnOutsideJob(process.execPath, args))) {
      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    }
    // Host 起来要几秒（tsx 冷加载 + node-pty 原生模块，实测 >1.5s 才监听
    // pipe）——给足 8s。
    await new Promise((r) => setTimeout(r, 8_000));
  }

  /**
   * 三向对账（设计稿 §4）：Host 为运行态真源；「DB 有 Host 无」= Host 崩溃
   * （PoC：子进程必死）落 failed；「Host 有 DB 无」= 孤儿，上报用户裁决。
   */
  async reconcile(known?: AgentInstanceRecord[]): Promise<ReconcileResult> {
    await this.ensureHost();
    const live = await this.client!.listInstances();
    const rows = known ?? this.repo.listHeadless();
    const plan = reconcileInstances(rows, live);
    for (const r of plan.refresh) this.repo.updatePid(r.id, r.osPid, r.harnessSessionId);
    for (const l of plan.lost) this.repo.markFailed(l.id, l.errorMessage);
    // Host 为状态真源：活行随 Host 汇报刷新（事件泵只覆盖在线窗口，
    // daemon 重启窗口里 exited 的实例靠这一拍收进 DB）。
    const liveById = new Map(live.map((s) => [s.id, s]));
    for (const row of rows) {
      const sum = liveById.get(row.id);
      if (!sum || isTerminalStatus(row.status)) continue;
      if (row.status !== sum.status) {
        this.repo.markStatus(row.id, sum.status as AgentInstanceStatus);
      }
    }
    // 终态对账兜底：Host 彻底不报的非终态行（daemon 重启窗口里 spawn 失败的）
    // 没有事件可等——补判 failed。
    for (const row of rows) {
      if (!isTerminalStatus(row.status) && !liveById.has(row.id)) {
        this.repo.markStatus(row.id, 'failed', 'runtime host no longer reports this instance');
      }
    }
    // 孤儿只报增量（已知集合不再刷屏——对账 60s 一拍，同一枚孤儿会连续报几十遍）；
    // 集合消失（Host 重启清空 / 被处置）后重报。
    const fresh = plan.unknown.filter((u) => !this.knownOrphans.has(u.id));
    if (fresh.length > 0) {
      this.log(`orphan instances (not in DB): ${fresh.map((u) => u.id).join(', ')}`);
      for (const u of plan.unknown) this.knownOrphans.add(u.id);
      for (const id of this.knownOrphans) {
        if (!plan.unknown.some((u) => u.id === id)) this.knownOrphans.delete(id);
      }
    } else if (plan.unknown.length === 0 && this.knownOrphans.size > 0) {
      this.knownOrphans.clear();
    }
    return {
      hostId: this.hostId ?? '',
      refreshed: plan.refresh.map((r) => r.id),
      failed: plan.lost.map((l) => l.id),
      orphans: plan.unknown,
    };
  }

  /** 启动重连失败后的周期自愈（ensureHost 幂等；连上即停）。 */
  scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        if (this.stopped || this.client?.connected) return;
        this.reconcile()
          .catch(() => this.scheduleRetry()); // 还不通就再等一轮
      },
      RETRY_INTERVAL_MS,
    );
    this.retryTimer.unref();
  }

  /** 周期对账：daemon 起来后常跑（事件泵只覆盖在线窗口，对账收离线窗口的尾巴）。 */
  scheduleReconcile(): void {
    if (this.stopped || this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      if (!this.client?.connected) return;
      this.reconcile().catch(() => {});
    }, RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref();
  }

  /** 实例状态变更通知（项目卡终端角标把 headless 实例也计入，起/停要立刻对账；
   *  可选——daemon 装配时注入，测试缺省不通知）。 */
  onStatusChange?: () => void;

  /** headless 起会话：先落 created 行 → spawn → started 事件把行推到 running。 */
  async spawnInstance(payload: InstanceSpawnPayload, meta: { projectId: number; harness: string }): Promise<void> {
    await this.ensureHost();
    this.repo.create({
      id: payload.instanceId,
      projectId: meta.projectId,
      harness: meta.harness,
      executionMode: 'headless',
      workingDirectory: payload.cwd,
      command: [payload.command, ...payload.args].join(' '),
    });
    const { osPid } = await this.client!.spawnInstance(payload);
    this.repo.markStarting(payload.instanceId, this.hostId ?? '', osPid);
    this.onStatusChange?.();
  }

  /** 事件泵 → 落库（daemon 唯一 writer；terminal.output 不落库）。 */
  async handleEvent(frame: HostEventFrame): Promise<void> {
    const instanceId = String(frame.instanceId ?? '');
    if (!instanceId) return;
    switch (frame.type) {
      case 'instance.started':
        // spawn 流程里 markStarting 已落，这里把它推到 running（对账之外的正常路径）
        this.repo.markRunning(instanceId);
        this.onStatusChange?.();
        break;
      case 'instance.exited':
        this.repo.markExited(instanceId, Number(frame.exitCode ?? 0));
        this.onStatusChange?.();
        break;
      case 'instance.error':
        this.repo.markFailed(instanceId, String(frame.error ?? 'instance error'));
        this.onStatusChange?.();
        break;
      default:
        break; // terminal.*：ring 在 Host，B3 Gateway 接管
    }
  }

  sendStdin(instanceId: string, data: string): Promise<unknown> {
    if (!this.client?.connected) return Promise.reject(new Error('runtime host not connected'));
    return this.client.sendStdin(instanceId, data);
  }

  /** Host 活实例清单（Gateway attach 前的存活校验）。 */
  listInstances(): Promise<HostInstanceSummary[]> {
    if (!this.client?.connected) return Promise.reject(new Error('runtime host not connected'));
    return this.client.listInstances();
  }

  killInstance(instanceId: string): Promise<unknown> {
    if (!this.client?.connected) return Promise.reject(new Error('runtime host not connected'));
    return this.client.killInstance(instanceId);
  }

  /** Host ring 重放（Gateway 断连缺口的补拉通道）。 */
  async replayAfter(instanceId: string, afterSequence: number): Promise<import('./instance-manager.js').RingEntry[]> {
    if (!this.client?.connected) throw new Error('runtime host not connected');
    const raw = (await this.client.request('instance.replay', { after: afterSequence }, instanceId)) as {
      entries?: import('./instance-manager.js').RingEntry[];
    };
    return raw.entries ?? [];
  }

  /** daemon 停机时收 Host（实例全杀 + 进程退出）：Host 是 daemon 的守护进程，
   *  生命周期一致（2026-11-23 用户裁决）。Host 不在 = 已经死了或自退了，静默。 */
  async shutdownHost(): Promise<void> {
    if (!this.client?.connected) return;
    try {
      await this.client.request('shutdown.graceful', undefined, undefined, 5_000);
    } catch {
      /* Host 已死：无所谓 */
    }
  }

  resize(instanceId: string, cols: number, rows: number): Promise<unknown> {
    if (!this.client?.connected) return Promise.reject(new Error('runtime host not connected'));
    return this.client.resize(instanceId, cols, rows);
  }
}
