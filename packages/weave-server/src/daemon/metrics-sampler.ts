import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import si from 'systeminformation';
import { dataRoots } from '../db/paths.js';
import type { HookEventBus } from '../hooks/bus.js';
import type { AgentInstanceRepository } from '../repositories/agent-instances.js';
import type { ResourceReportPayload } from '../runtime/protocol.js';
import type { RuntimeSupervisor } from '../runtime/supervisor.js';

/**
 * 资源监控采样器（agent-runtime-terminal-design.md §13.3）：
 * - daemon 自身：process API 差分（零开销，10s 一拍）；
 * - Runtime Host：`resource.updated` IPC 事件自报（Host 进程内同款零开销采样）；
 * - Agent（TUI 宿主）进程：60s 一枪批量查 pid（Windows = PowerShell Get-Process，
 *   POSIX = /proc 零开销）——只在有人看（SSE 有订阅者）时才打，没人看不起子进程；
 * - 帧走既有 hookBus 域（`metrics.snapshot`），与 dashboard.* 同一 SSE 通道。
 *
 * 不做的（如实缺席，不摆空壳）：WS 延迟 / 渲染耗时 / Journal 写入延迟
 * （Journal 本身未实现）。
 */

/** 零开销采样周期（daemon 自身 + Host 自报同拍）。 */
const SAMPLE_MS = 10_000;
/** Agent 进程采集周期（用户裁决 60s 粒度；Windows 每枪 ~0.5–1s）。 */
const AGENT_SAMPLE_MS = 60_000;
/** Host 自报过期窗：超窗没有新报告 → 视为失联，快照里如实置 null。 */
const HOST_STALE_MS = 30_000;
/** 历史环形：1 分钟一格 × 60 格 = 1 小时（首连下发，刷新不丢图）。 */
const HISTORY_MS = 60_000;
const HISTORY_MAX = 60;
/** 系统时序环形：10s 一格（与 SAMPLE_MS 同拍），窗口 1–24h 由快照读方裁剪。 */
const SYSTEM_SAMPLE_MS = 10_000;
const SYSTEM_MAX = 24 * 360; // 8640 点 ≈ 350KB
/** 系统历史落盘种子（daemon 重启续 24h 帐；cache 可弃）。 */
const SYSTEM_PERSIST_MS = 60_000;

/** 全局系统即时读数（整机口径，与 daemon/Host 进程口径分开）。 */
export interface SystemSample {
  /** 整机 CPU 占用 %（跨核合计，>100 = 多核）。 */
  cpuPercent: number;
  /** 物理内存 总/已用 字节。 */
  memTotalBytes: number;
  memUsedBytes: number;
  /** 各逻辑盘分区 总/已用 字节。 */
  disks: Array<{ mount: string; totalBytes: number; usedBytes: number }>;
  /** 机器整体磁盘繁忙度 %（性能占用，非空间）；采不到缺席。 */
  diskActivePercent?: number;
}

export interface SystemHistoryPoint {
  at: string;
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  /** 全部分区已用合计（时序只看总量，明细取即时值 disks）。 */
  diskUsedBytes: number;
  diskTotalBytes: number;
}

export interface MetricsAgentSample {
  instanceId: string;
  /** 归属项目：全局仪表盘与项目/会话卡共用同一帧，前端按它切自己的视图。 */
  projectId: number;
  osPid?: number;
  harnessSessionId?: string;
  harness: string;
  /** 缺席 = 本拍没采到（Windows 首拍没有差分基线 / 进程已退 / 没人在看）。 */
  cpuPercent?: number;
  memRssBytes?: number;
  /** 最近一拍的 PTY 输出吞吐（字节/秒，Host resource.updated 差分）。 */
  outputBytesPerSec?: number;
  /** 该进程的磁盘 IO 速率（读+写字节/秒，与 CPU 同拍差分）；缺席 = 本拍没采到。 */
  diskBytesPerSec?: number;
}

export interface MetricsHistoryPoint {
  at: string;
  daemonCpuPercent: number;
  daemonMemRssBytes: number;
  hostCpuPercent?: number;
  hostMemRssBytes?: number;
}

export interface MetricsSnapshot {
  daemon: { cpuPercent: number; memRssBytes: number };
  host: { cpuPercent: number; memRssBytes: number; at: number } | null;
  agents: MetricsAgentSample[];
  history: MetricsHistoryPoint[];
  /** 全局系统读数（整机 CPU/内存/磁盘）；采不到 = null（macOS 暂缺席）。 */
  system: SystemSample | null;
  /** 系统时序环形（10s 一格，最长 24h；按窗口裁剪由读方做）。 */
  systemHistory: SystemHistoryPoint[];
}

export interface MetricsSamplerDeps {
  bus: Pick<HookEventBus, 'emit'>;
  supervisor: Pick<RuntimeSupervisor, 'onEvent'>;
  instances: Pick<AgentInstanceRepository, 'listHeadless'>;
  /** 有人看才采 Agent 进程（Windows 一枪要起 PowerShell 子进程）。 */
  shouldSampleAgents?: () => boolean;
  /** 平台注入（测试）；缺省 = 真平台。 */
  platform?: NodeJS.Platform;
  /** PowerShell 可执行名（测试注入）。 */
  powershell?: string;
  /** 进程树读数（测试注入）。 */
  processTree?: () => Promise<Map<number, ProcessTreeReading>>;
  /** 系统读数（测试注入；缺省 = 按平台真读）。 */
  systemReader?: () => Promise<SystemReading>;
  /** 系统历史落盘目录（测试注入；缺省 = `<cache>/`）。 */
  systemCacheDir?: string;
}

/** 单 pid 采集结果（差分前的原始读数）。 */
interface PidReading {
  cpuSeconds: number;
  memRssBytes: number;
  /** 进程磁盘 IO 累计（读+写字节）；采不到 = undefined。 */
  diskBytes?: number;
}

interface ProcessTreeReading extends PidReading {
  pid: number;
  parentPid: number;
  /** 同一 PID 生命周期身份；防 PID 复用或归属进程变化时拿旧累计 CPU 做差。 */
  processKey: string;
  wrapper?: boolean;
}

export type { ProcessTreeReading };

export class MetricsSampler {
  private readonly timers: NodeJS.Timeout[] = [];
  private history: MetricsHistoryPoint[] = [];
  private lastHistoryAt = 0;
  private daemonCpuPercent = 0;
  private daemonMemRssBytes = 0;
  private lastDaemonCpu = process.cpuUsage();
  private lastDaemonAt = Date.now();
  private hostReport: ResourceReportPayload | null = null;
  private hostSeenAt = 0;
  /** 上拍 Agent 进程读数（CPU% 差分基线）。 */
  private prevPidReadings = new Map<number, { reading: PidReading; processKey: string; at: number }>();
  /** 上拍实例吞吐（累计字节 → 速率）。 */
  private prevOutputBytes = new Map<string, { bytes: number; at: number }>();
  private agentSamples = new Map<string, MetricsAgentSample>();
  private systemSample: SystemSample | null = null;
  private systemHistory: SystemHistoryPoint[] = [];
  private systemDirty = false;
  private lastSystemPersistAt = 0;
  /** 整机 CPU 差分基线（/proc/stat 累计 jiffies / Windows 一次读两拍）。 */
  private prevSystemCpu: { idle: number; total: number } | null = null;
  private readonly platform: NodeJS.Platform;
  private readonly powershell: string;
  private readonly shouldSampleAgents: () => boolean;

  constructor(private readonly deps: MetricsSamplerDeps) {
    this.platform = deps.platform ?? process.platform;
    this.powershell = deps.powershell ?? 'powershell.exe';
    this.shouldSampleAgents = deps.shouldSampleAgents ?? (() => true);
    deps.supervisor.onEvent((frame) => {
      if (frame.type !== 'resource.updated') return;
      const report = (frame as { payload?: ResourceReportPayload }).payload;
      if (!report) return;
      this.hostReport = report;
      this.hostSeenAt = Date.now();
    });
  }

  start(): void {
    this.timers.push(setInterval(() => this.sampleDaemon(), SAMPLE_MS));
    this.timers.push(setInterval(() => this.sampleAgents(), AGENT_SAMPLE_MS));
    this.timers.push(
      setInterval(() => {
        if (this.history.length > 0 || this.lastHistoryAt === 0) this.pushHistoryPoint();
      }, HISTORY_MS),
    );
    this.timers.push(setInterval(() => void this.sampleSystem(), SYSTEM_SAMPLE_MS));
    this.timers.push(
      setInterval(() => {
        if (this.systemDirty && Date.now() - this.lastSystemPersistAt >= SYSTEM_PERSIST_MS) {
          this.persistSystemHistory();
        }
      }, 5_000),
    );
    for (const t of this.timers) t.unref();
    this.loadSystemHistory();
    this.sampleDaemon();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }

  /** 首连（SseHub onAttach）与手动刷新共用：全量快照一帧。 */
  attach(): void {
    this.deps.bus.emit({ kind: 'metrics.snapshot', at: new Date().toISOString(), snapshot: this.snapshot() });
  }

  snapshot(): MetricsSnapshot {
    const stale = !this.hostReport || Date.now() - this.hostSeenAt > HOST_STALE_MS;
    return {
      daemon: { cpuPercent: this.daemonCpuPercent, memRssBytes: this.daemonMemRssBytes },
      host: stale || !this.hostReport
        ? null
        : { cpuPercent: this.hostReport.hostCpuPercent, memRssBytes: this.hostReport.hostMemRssBytes, at: this.hostSeenAt },
      agents: [...this.agentSamples.values()],
      history: this.history,
      system: this.systemSample,
      systemHistory: this.systemHistory,
    };
  }

  private sampleDaemon(): void {
    const now = Date.now();
    const usage = process.cpuUsage(this.lastDaemonCpu);
    this.lastDaemonCpu = process.cpuUsage();
    const elapsed = (now - this.lastDaemonAt) / 1000;
    this.lastDaemonAt = now;
    if (elapsed > 0) this.daemonCpuPercent = ((usage.user + usage.system) / 1e6 / elapsed) * 100;
    this.daemonMemRssBytes = process.memoryUsage().rss;
    this.pushHistoryPoint();
    this.emit();
  }

  private pushHistoryPoint(): void {
    const now = Date.now();
    if (now - this.lastHistoryAt < HISTORY_MS) return;
    this.lastHistoryAt = now;
    const host = this.snapshot().host;
    this.history.push({
      at: new Date(now).toISOString().slice(0, 19),
      daemonCpuPercent: round1(this.daemonCpuPercent),
      daemonMemRssBytes: this.daemonMemRssBytes,
      ...(host ? { hostCpuPercent: round1(host.cpuPercent), hostMemRssBytes: host.memRssBytes } : {}),
    });
    if (this.history.length > HISTORY_MAX) this.history.shift();
  }

  private emit(): void {
    this.deps.bus.emit({ kind: 'metrics.snapshot', at: new Date().toISOString(), snapshot: this.snapshot() });
  }

  /** 全局系统采样：整机 CPU（差分）+ 内存 + 各逻辑盘。失败静默缺席（不拖慢请求路径）。 */
  private async sampleSystem(): Promise<void> {
    try {
      const s = this.deps.systemReader
        ? await this.deps.systemReader()
        : await readSystemSi();
      let cpuPercent = s.cpuPercent;
      // Windows 一枪拿不出差分（Typeperf 要等 1s）：用两次采样间的 PercentProcessorTime
      // 由 PowerShell 自身差分；Linux /proc/stat 由 prevSystemCpu 差分。
      if (this.prevSystemCpu && s.cpuTotal > 0 && s.cpuIdle >= 0) {
        const totalDelta = s.cpuTotal - this.prevSystemCpu.total;
        const idleDelta = s.cpuIdle - this.prevSystemCpu.idle;
        if (totalDelta > 0 && idleDelta >= 0) cpuPercent = round1((1 - idleDelta / totalDelta) * 100);
      }
      this.prevSystemCpu = { idle: s.cpuIdle, total: s.cpuTotal };
      this.systemSample = {
        cpuPercent,
        memTotalBytes: s.memTotalBytes,
        memUsedBytes: s.memUsedBytes,
        disks: s.disks,
        diskActivePercent: s.diskActivePercent,
      };
      const diskUsed = s.disks.reduce((sum, d) => sum + d.usedBytes, 0);
      const diskTotal = s.disks.reduce((sum, d) => sum + d.totalBytes, 0);
      this.systemHistory.push({
        at: new Date().toISOString().slice(0, 19),
        cpuPercent,
        memUsedBytes: s.memUsedBytes,
        memTotalBytes: s.memTotalBytes,
        diskUsedBytes: diskUsed,
        diskTotalBytes: diskTotal,
      });
      if (this.systemHistory.length > SYSTEM_MAX) this.systemHistory.shift();
      this.systemDirty = true;
      this.emit();
    } catch {
      /* 本枪失败：缺席而非 0 */
    }
  }

  /** 系统历史落盘种子（cache 可弃；重启后 loadSystemHistory 接手，过窗裁掉）。 */
  private persistSystemHistory(): void {
    this.lastSystemPersistAt = Date.now();
    this.systemDirty = false;
    try {
      const cacheDir = this.deps.systemCacheDir ?? dataRoots().cache;
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(
        path.join(cacheDir, 'metrics-history.json'),
        JSON.stringify({ savedAt: Date.now(), points: this.systemHistory }),
      );
    } catch {
      /* 写不进去就算了：内存账还在 */
    }
  }

  private loadSystemHistory(): void {
    try {
      const cacheDir = this.deps.systemCacheDir ?? dataRoots().cache;
      const raw = fs.readFileSync(path.join(cacheDir, 'metrics-history.json'), 'utf8');
      const parsed = JSON.parse(raw) as { savedAt?: number; points?: SystemHistoryPoint[] };
      if (typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > 24 * 3_600_000 || !Array.isArray(parsed.points)) return;
      const oldest = Date.now() - 24 * 3_600_000;
      this.systemHistory = parsed.points.filter((p) => Date.parse(`${p.at}Z`) > oldest);
    } catch {
      /* 无种子 / 坏档：从零开始 */
    }
  }

  private async sampleAgents(): Promise<void> {
    const rows = this.deps.instances
      .listHeadless()
      .filter((r) => r.status === 'running' || r.status === 'starting');
    const byPid = new Map<number, typeof rows[number]>();
    for (const r of rows) if (r.osPid) byPid.set(r.osPid, r);
    const now = Date.now();

    // 吞吐速率（Host 自报差分，10s 粒度内的最近一拍）
    const throughput = new Map<string, number>();
    if (this.hostReport) {
      for (const inst of this.hostReport.instances) {
        const prev = this.prevOutputBytes.get(inst.instanceId);
        if (prev && now > prev.at) {
          throughput.set(inst.instanceId, (inst.outputBytes - prev.bytes) / ((now - prev.at) / 1000));
        }
        this.prevOutputBytes.set(inst.instanceId, { bytes: inst.outputBytes, at: now });
      }
    }

    const samples: MetricsAgentSample[] = [];
    for (const r of rows) {
      samples.push({
        instanceId: r.id,
        projectId: r.projectId,
        ...(r.osPid ? { osPid: r.osPid } : {}),
        ...(r.harnessSessionId ? { harnessSessionId: r.harnessSessionId } : {}),
        harness: r.harness,
        ...(throughput.has(r.id) ? { outputBytesPerSec: round1(throughput.get(r.id)!) } : {}),
      });
    }

    const pids = [...byPid.keys()];
    if (pids.length > 0 && this.shouldSampleAgents()) {
      const tree = await this.readProcessTree().catch(() => new Map<number, ProcessTreeReading>());
      const prev = this.prevPidReadings;
      for (const [pid, row] of byPid) {
        // PTY 根（如 cmd.exe /c）只是包装壳——只沿「壳 + 唯一直接子进程」链下钻到真宿主；
        // 差分基线带 processKey（启动身份），换进程/PID 复用时作废重建，绝不拿旧累计 CPU 做差。
        const cur = resolveAgentReading(pid, tree);
        if (!cur) continue; // 进程已退 / 本枪失败：缺席而非 0
        const sample = samples.find((s) => s.instanceId === row.id);
        if (sample) sample.memRssBytes = cur.memRssBytes;
        const last = prev.get(pid);
        if (last && last.processKey === cur.processKey && now > last.at && sample) {
          const cpuDelta = cur.cpuSeconds - last.reading.cpuSeconds;
          if (cpuDelta >= 0) sample.cpuPercent = round1((cpuDelta / ((now - last.at) / 1000)) * 100);
          // 每进程磁盘 IO 速率（读+写字节/秒）：同拍差分，累计倒退（IO 计数清零的容器等）缺席
          if (cur.diskBytes !== undefined && last.reading.diskBytes !== undefined) {
            const ioDelta = cur.diskBytes - last.reading.diskBytes;
            if (ioDelta >= 0) sample.diskBytesPerSec = Math.round(ioDelta / ((now - last.at) / 1000));
          }
        }
        prev.set(pid, { reading: cur, processKey: cur.processKey, at: now });
      }
    }

    this.agentSamples = new Map(samples.map((s) => [s.instanceId, s]));
    this.emit();
  }

  /** 全进程树读数（Windows = 一枪 PowerShell CIM；Linux = /proc 零开销）。 */
  private async readProcessTree(): Promise<Map<number, ProcessTreeReading>> {
    if (this.deps.processTree) return this.deps.processTree();
    const out = new Map<number, ProcessTreeReading>();
    if (this.platform === 'win32') {
      const text = await new Promise<string>((resolve, reject) => {
        execFile(
          this.powershell,
          [
            '-NoProfile', '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.UserModeTime + $_.KernelModeTime) $($_.WorkingSetSize) $($_.CreationDate.ToFileTime()) $($_.ReadTransferCount + $_.WriteTransferCount) $([int]($_.Name -ieq \'cmd.exe\' -and $_.CommandLine -match \'(?i)\\s/c\\s\'))" }',
          ],
          { timeout: 15_000, windowsHide: true },
          (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
        );
      });
      for (const line of text.split(/\r?\n/)) {
        const [pid, ppid, cpu100ns, rss, created, ioBytes, wrapper] = line.trim().split(/\s+/);
        const n = Number(pid);
        if (Number.isInteger(n) && n > 0) {
          out.set(n, {
            pid: n,
            parentPid: Number(ppid) || 0,
            processKey: created ?? String(n),
            wrapper: wrapper === '1',
            // Win32_Process 的 *ModeTime 单位是 100ns
            cpuSeconds: (Number(cpu100ns) || 0) / 1e7,
            memRssBytes: Number(rss) || 0,
            ...(ioBytes !== undefined ? { diskBytes: Number(ioBytes) || 0 } : {}),
          });
        }
      }
      return out;
    }
    for (const pid of await readdir('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        // 字段从 state 起：ppid=第 2、utime=第 11、stime=第 12（clk_tck 恒 100，Linux ABI）
        const io = await readFile(`/proc/${pid}/io`, 'utf8').catch(() => '');
        out.set(Number(pid), {
          pid: Number(pid),
          parentPid: Number(fields[1] ?? 0) || 0,
          processKey: `${pid}:${fields[18] ?? ''}`,
          cpuSeconds: (Number(fields[10] ?? 0) + Number(fields[11] ?? 0)) / 100,
          memRssBytes: Number(/VmRSS:\s+(\d+)/.exec(await readFile(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) * 1024,
          ...(io ? { diskBytes: Number(/read_bytes:\s+(\d+)/.exec(io)?.[1] ?? 0) + Number(/write_bytes:\s+(\d+)/.exec(io)?.[1] ?? 0) } : {}),
        });
      } catch {
        /* 进程没了：缺席 */
      }
    }
    return out;
  }
}

function resolveAgentReading(rootPid: number, tree: Map<number, ProcessTreeReading>): ProcessTreeReading | undefined {  let current = tree.get(rootPid);
  const seen = new Set<number>();
  while (current?.wrapper) {
    if (seen.has(current.pid)) return undefined;
    seen.add(current.pid);
    const parent = current.pid;
    const children = [...tree.values()].filter((p) => p.parentPid === parent);
    if (children.length !== 1) return undefined;
    current = children[0];
  }
  return current;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 平台读数中间形：CPU 差分原料 + 内存 + 盘（systeminformation 全平台统一产出）。 */
interface SystemReading {
  cpuPercent: number;
  cpuIdle: number;
  cpuTotal: number;
  memTotalBytes: number;
  memUsedBytes: number;
  disks: Array<{ mount: string; totalBytes: number; usedBytes: number }>;
  /** 机器整体磁盘繁忙度 %（两次采样间 IO 活跃时间占比）；采不到 = undefined。 */
  diskActivePercent?: number;
}

/**
 * 系统读数：CPU 用 Node 内建 os.cpus() 的累计 ticks（跨平台、真单调——实测
 * si.currentLoad 的 raw 值每调用自测短窗后归零，跨拍差分会出负值）；内存/磁盘
 * 仍用 systeminformation（mem() / fsSize()）。
 */
async function readSystemSi(): Promise<SystemReading> {
  const [mem, disksSi, diskActive] = await Promise.all([
    si.mem(),
    si.fsSize(),
    readDiskActive(),
  ]);
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return {
    cpuPercent: 0,
    cpuIdle: idle,
    cpuTotal: total,
    memTotalBytes: mem.total,
    memUsedBytes: mem.used,
    disks: disksSi
      .filter((d) => d.size > 0)
      .map((d) => ({ mount: d.mount, totalBytes: d.size, usedBytes: d.used })),
    diskActivePercent: diskActive,
  };
}

/** 磁盘繁忙度读数（性能占用 %）：Windows = PerfCounter `PhysicalDisk(_Total)\% Disk Time`
 *  （单次采样即区间平均，与手按资源监视器同口径）；POSIX = /proc/diskstats 的
 *  io_ticks 差分（ms / 实际间隔 ms）。采不到 = undefined（disksIO 在 Windows 恒 null）。 */
async function readDiskActive(): Promise<number | undefined> {
  try {
    if (process.platform === 'win32') {
      const out = await new Promise<string>((resolve, reject) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-Command',
            "(Get-Counter '\\PhysicalDisk(_Total)\\% Disk Time').CounterSamples[0].CookedValue"],
          { timeout: 5_000 },
          (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
        );
      });
      const v = Number(out.trim());
      return Number.isFinite(v) ? Math.min(100, Math.max(0, round1(v))) : undefined;
    }
    const raw = await readFile('/proc/diskstats', 'utf8');
    let ioTicks = 0;
    for (const line of raw.split('\n')) {
      const f = line.trim().split(/\s+/);
      // 字段 9（0 起）= io_ticks_ms（该盘 IO 非常驻时间的累计）；跳过分区（有分区的盘字段全同结构，取全量即含重复——只取主盘 = 设备名不带数字）
      if (f.length >= 13 && !/\d$/.test(f[2] ?? '')) ioTicks += Number(f[9] ?? 0);
    }
    const now = Date.now();
    if (prevDiskIoTicks !== null && now > prevDiskIoAt && ioTicks >= prevDiskIoTicks) {
      const pct = ((ioTicks - prevDiskIoTicks) / (now - prevDiskIoAt)) * 100;
      prevDiskIoTicks = ioTicks;
      prevDiskIoAt = now;
      return round1(Math.min(100, Math.max(0, pct)));
    }
    prevDiskIoTicks = ioTicks;
    prevDiskIoAt = now;
    return undefined;
  } catch {
    return undefined;
  }
}
let prevDiskIoTicks: number | null = null;
let prevDiskIoAt = 0;
