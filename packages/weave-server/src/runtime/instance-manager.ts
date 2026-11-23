import type { PtyProcess } from './adapters/windows-pty.js';
import type { HostInstanceSummary, InstanceSpawnPayload } from './protocol.js';

/**
 * per-instance PTY 生命周期 + ring buffer + 单调 sequence（agent-runtime-host-design.md
 * §3.1/§3.2）。Host 内存态的唯一事实源；daemon 侧 agent_instances 表由事件驱动落库。
 */

/** 单条 ring 记录：字节 chunk（原样 string，node-pty 已按 UTF-8 解出）或 resize。 */
export interface RingEntry {
  sequence: number;
  timestamp: number;
  kind: 'output' | 'resize' | 'gap';
  data?: string;
  cols?: number;
  rows?: number;
}

export interface ManagedInstance {
  readonly id: string;
  pty: PtyProcess | null;
  osPid?: number;
  cols: number;
  rows: number;
  status: 'starting' | 'running' | 'exited';
  startedAt?: number;
  exitedAt?: number;
  exitCode?: number;
  sequence: number;
  ring: RingEntry[];
  ringBytes: number;
  /** 自 spawn 起累计输出字节（ring 会被裁，这个只增——资源监控的吞吐面）。 */
  outputBytes: number;
}

export type InstanceEvent =
  | { type: 'instance.started'; instanceId: string; osPid: number }
  | { type: 'instance.exited'; instanceId: string; exitCode: number }
  | { type: 'terminal.output'; instanceId: string; sequence: number; timestamp: number; data: string }
  | {
      type: 'terminal.resize';
      instanceId: string;
      sequence: number;
      timestamp: number;
      cols: number;
      rows: number;
    };

/** per-instance ring 上限（字节；PoC 里 `dir` 一屏就 700KB，512KB 量级合适）。 */
export const RING_LIMIT_BYTES = 512 * 1024;
/** exited 实例的 ring 保留窗：断线重放只要短窗，过了就摘（内存态生命周期一致）。 */
const REAP_EXITED_MS = 60_000;

export class InstanceManager {
  private readonly instances = new Map<string, ManagedInstance>();

  constructor(
    private readonly spawnPty: (file: string, args: string[], opts: { cols: number; rows: number; cwd: string; env: Record<string, string> }) => Promise<PtyProcess>,
    private readonly emit: (event: InstanceEvent) => void,
  ) {}

  async spawn(payload: InstanceSpawnPayload): Promise<{ osPid: number }> {
    if (this.instances.has(payload.instanceId)) {
      throw new Error(`instance ${payload.instanceId} already exists`);
    }
    const inst: ManagedInstance = {
      id: payload.instanceId,
      pty: null,
      cols: payload.cols,
      rows: payload.rows,
      status: 'starting',
      sequence: 0,
      ring: [],
      ringBytes: 0,
      outputBytes: 0,
    };
    this.instances.set(inst.id, inst);
    const pty = await this.spawnPty(payload.command, payload.args, {
      cols: payload.cols,
      rows: payload.rows,
      cwd: payload.cwd,
      env: payload.env,
    });
    inst.pty = pty;
    inst.osPid = pty.pid;
    inst.status = 'running';
    inst.startedAt = Date.now();
    pty.onData((data) => this.pushOutput(inst, data));
    pty.onExit(({ exitCode }) => {
      inst.status = 'exited';
      inst.exitedAt = Date.now();
      inst.exitCode = exitCode;
      inst.pty = null;
      this.emit({ type: 'instance.exited', instanceId: inst.id, exitCode });
      // 短保留后从 Map 摘除（ring 是内存态）：终端面在 exited 帧已转终态停重连，
      // 重放窗一过即无人再拉——账不收就常驻（2026-11-23 用户裁决：生命周期一致）。
      const reap = setTimeout(() => this.instances.delete(inst.id), REAP_EXITED_MS);
      reap.unref();
    });
    this.emit({ type: 'instance.started', instanceId: inst.id, osPid: pty.pid });
    return { osPid: pty.pid };
  }

  private pushOutput(inst: ManagedInstance, data: string): void {
    inst.outputBytes += Buffer.byteLength(data);
    inst.sequence += 1;
    const entry: RingEntry = { sequence: inst.sequence, timestamp: Date.now(), kind: 'output', data };
    this.pushRing(inst, entry, Buffer.byteLength(data));
    this.emit({
      type: 'terminal.output',
      instanceId: inst.id,
      sequence: entry.sequence,
      timestamp: entry.timestamp,
      data,
    });
  }

  private pushRing(inst: ManagedInstance, entry: RingEntry, bytes: number): void {
    inst.ring.push(entry);
    inst.ringBytes += bytes;
    while (inst.ringBytes > RING_LIMIT_BYTES && inst.ring.length > 1) {
      const dropped = inst.ring.shift()!;
      inst.ringBytes -= dropped.data ? Buffer.byteLength(dropped.data) : 0;
    }
  }

  stdin(instanceId: string, data: string): void {
    this.instance(instanceId, 'write').pty?.write(data);
  }

  resize(instanceId: string, cols: number, rows: number): void {
    const inst = this.instance(instanceId, 'resize');
    inst.cols = cols;
    inst.rows = rows;
    inst.sequence += 1;
    const entry: RingEntry = { sequence: inst.sequence, timestamp: Date.now(), kind: 'resize', cols, rows };
    this.pushRing(inst, entry, 0);
    inst.pty?.resize(cols, rows);
    this.emit({ type: 'terminal.resize', instanceId, sequence: entry.sequence, timestamp: entry.timestamp, cols, rows });
  }

  /** 温和终止：先 kill，等 onExit（调用方再兜底硬清）。 */
  kill(instanceId: string): void {
    this.instance(instanceId, 'kill').pty?.kill();
  }

  /** 资源自报的吞吐快照（活实例的累计输出字节）。 */
  resourceSummaries(): Array<{ instanceId: string; osPid?: number; outputBytes: number }> {
    return [...this.instances.values()]
      .filter((i) => i.status !== 'exited')
      .map((i) => ({ instanceId: i.id, osPid: i.osPid, outputBytes: i.outputBytes }));
  }

  /** 实例清单 = 活实例（exited 行留在 Map 供 replay/exitCode 查询，2026-11-23
   *  实测：不清场不摘行，ack 的 N 与 dashboard 的 liveHeadlessCounts 恒差一枚）。 */
  summaries(): HostInstanceSummary[] {
    return [...this.instances.values()]
      .filter((i) => i.status !== 'exited')
      .map((i) => ({
        id: i.id,
        status: 'running' as const,
        osPid: i.osPid,
        lastSequence: i.sequence,
      }));
  }

  /** 重连补拉：`afterSequence` 之后的 ring 增量（缺口给 gap 条目，不装完整）。 */
  replayAfter(instanceId: string, afterSequence: number): RingEntry[] {
    const inst = this.instances.get(instanceId);
    if (!inst) return [];
    const kept = inst.ring.filter((e) => e.sequence > afterSequence);
    const holes: RingEntry[] = [];
    let expect = afterSequence + 1;
    for (const e of kept) {
      if (e.sequence > expect) {
        holes.push({ sequence: expect, timestamp: e.timestamp, kind: 'gap' });
      }
      expect = e.sequence + 1;
    }
    return [...holes, ...kept];
  }

  activeCount(): number {
    let n = 0;
    for (const i of this.instances.values()) if (i.status !== 'exited') n += 1;
    return n;
  }

  /** 全量清理（graceful shutdown 唯一出口——pty 句柄会拖住 node 不退，PoC 实测）。 */
  async killAll(timeoutMs = 2_000): Promise<void> {
    await Promise.all(
      [...this.instances.values()].map(
        (inst) =>
          new Promise<void>((resolve) => {
            if (!inst.pty) return resolve();
            const timer = setTimeout(() => {
              try {
                inst.pty?.kill();
              } catch {
                /* 已死 */
              }
              resolve();
            }, timeoutMs);
            inst.pty.onExit(() => {
              clearTimeout(timer);
              resolve();
            });
            try {
              inst.pty.kill();
            } catch {
              clearTimeout(timer);
              resolve();
            }
          }),
      ),
    );
    this.instances.clear();
  }

  private instance(id: string, action: string): ManagedInstance {
    const inst = this.instances.get(id);
    if (!inst) throw new Error(`unknown instance ${id} (cannot ${action})`);
    return inst;
  }
}
