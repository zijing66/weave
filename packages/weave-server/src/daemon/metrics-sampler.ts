import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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

export interface MetricsAgentSample {
  instanceId: string;
  osPid?: number;
  harnessSessionId?: string;
  harness: string;
  /** 缺席 = 本拍没采到（Windows 首拍没有差分基线 / 进程已退 / 没人在看）。 */
  cpuPercent?: number;
  memRssBytes?: number;
  /** 最近一拍的 PTY 输出吞吐（字节/秒，Host resource.updated 差分）。 */
  outputBytesPerSec?: number;
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
}

/** 单 pid 采集结果（差分前的原始读数）。 */
interface PidReading {
  cpuSeconds: number;
  memRssBytes: number;
}

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
  private prevPidReadings = new Map<number, { reading: PidReading; at: number }>();
  /** 上拍实例吞吐（累计字节 → 速率）。 */
  private prevOutputBytes = new Map<string, { bytes: number; at: number }>();
  private agentSamples = new Map<string, MetricsAgentSample>();
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
    this.timers.push(setInterval(() => void this.sampleAgents(), AGENT_SAMPLE_MS));
    this.timers.push(
      setInterval(() => {
        if (this.history.length > 0 || this.lastHistoryAt === 0) this.pushHistoryPoint();
      }, HISTORY_MS),
    );
    for (const t of this.timers) t.unref();
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
        ...(r.osPid ? { osPid: r.osPid } : {}),
        ...(r.harnessSessionId ? { harnessSessionId: r.harnessSessionId } : {}),
        harness: r.harness,
        ...(throughput.has(r.id) ? { outputBytesPerSec: round1(throughput.get(r.id)!) } : {}),
      });
    }

    const pids = [...byPid.keys()];
    if (pids.length > 0 && this.shouldSampleAgents()) {
      const readings = await this.readPids(pids).catch(() => new Map<number, PidReading>());
      const prev = this.prevPidReadings;
      for (const [pid, row] of byPid) {
        const cur = readings.get(pid);
        if (!cur) continue; // 进程已退 / 本枪失败：缺席而非 0
        const last = prev.get(pid);
        if (last && now > last.at) {
          const sample = samples.find((s) => s.instanceId === row.id);
          if (sample) {
            sample.cpuPercent = round1(((cur.cpuSeconds - last.reading.cpuSeconds) / ((now - last.at) / 1000)) * 100);
            sample.memRssBytes = cur.memRssBytes;
          }
        }
        prev.set(pid, { reading: cur, at: now });
      }
    }

    this.agentSamples = new Map(samples.map((s) => [s.instanceId, s]));
    this.emit();
  }

  /** 批量读 pid 的 CPU 累计秒与 RSS（Windows = 一枪 PowerShell；POSIX = /proc 零开销）。 */
  private async readPids(pids: number[]): Promise<Map<number, PidReading>> {
    const out = new Map<number, PidReading>();
    if (this.platform === 'win32') {
      const text = await new Promise<string>((resolve, reject) => {
        execFile(
          this.powershell,
          ['-NoProfile', '-Command', `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.CPU) $($_.WorkingSet64)" }`],
          { timeout: 15_000, windowsHide: true },
          (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
        );
      });
      for (const line of text.split(/\r?\n/)) {
        const [pid, cpu, rss] = line.trim().split(/\s+/);
        const n = Number(pid);
        if (Number.isInteger(n) && n > 0 && cpu !== undefined) {
          out.set(n, { cpuSeconds: Number(cpu) || 0, memRssBytes: Number(rss) || 0 });
        }
      }
      return out;
    }
    for (const pid of pids) {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        // 字段从 state 起：utime=第 11、stime=第 12（clk_tck 恒 100，Linux ABI）
        const cpuSeconds = (Number(fields[10] ?? 0) + Number(fields[11] ?? 0)) / 100;
        const status = await readFile(`/proc/${pid}/status`, 'utf8');
        const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
        out.set(pid, { cpuSeconds, memRssBytes: rssKb * 1024 });
      } catch {
        /* 进程没了：缺席 */
      }
    }
    return out;
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
