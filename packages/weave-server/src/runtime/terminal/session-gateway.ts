import { randomUUID } from 'node:crypto';
import type { HostEventFrame } from '../runtime-host-client.js';
import type { RuntimeSupervisor } from '../supervisor.js';
import type { InputLease, TerminalAttachRequest } from '../protocol.js';

/**
 * Terminal Gateway（B3）：全部终端访问的统一面（docs/plan/agent-runtime-terminal-gateway.md
 * §3 B3）。daemon 侧：订阅 supervisor 事件流 → 按 instance 维护广播账（活跃客户端
 * set + sequence 水位）；客户端带 lastSequence 重连 → 缺口给 gap 标记（不装完整）；
 * 输入走 Input Lease（多读一写、心跳续期、超时接管）；尺寸归 Write Client。
 *
 * Host 的 ring（B1 InstanceManager）是 daemon 重启空窗期的缓冲；本层 ring 只补
 * 「客户端断连瞬间到重连」的短窗（默认 256 条），更长缺口如实 gap。
 */

/** Lease 心跳超时（Write Client 掉线后可被接管）。 */
const LEASE_TTL_MS = 15_000;

/** 本层短窗缓冲条数。 */
const LOCAL_RING = 256;

interface Client {
  id: string;
  /** 下行写（WS 帧封装或裸 NDJSON，由端点注入——Gateway 不懂传输）。 */
  send: (text: string) => boolean;
  instanceId: string;
  mode: 'readonly' | 'interactive';
  replaying: boolean;
}

interface InstanceState {
  clients: Map<string, Client>;
  /** 重放短窗：[{sequence, text}]。 */
  ring: Array<{ sequence: number; text: string }>;
  lastSequence: number;
  lease: InputLease | null;
  leaseTimer: NodeJS.Timeout | null;
}

export class TerminalGateway {
  private readonly instances = new Map<string, InstanceState>();
  private subscriptions = 0;

  constructor(private readonly supervisor: RuntimeSupervisor) {}

  /** 订阅 Host 事件流（幂等；supervisor.onEvent 覆盖式注册，一次就够）。 */
  start(): void {
    if (this.subscriptions > 0) return;
    this.subscriptions += 1;
    this.supervisor.onEvent((frame) => this.onHostEvent(frame));
  }

  private stateOf(instanceId: string): InstanceState {
    let s = this.instances.get(instanceId);
    if (!s) {
      s = { clients: new Map(), ring: [], lastSequence: 0, lease: null, leaseTimer: null };
      this.instances.set(instanceId, s);
    }
    return s;
  }

  private onHostEvent(frame: HostEventFrame): void {
    const instanceId = String(frame.instanceId ?? '');
    if (!instanceId || (frame.type !== 'terminal.output' && frame.type !== 'terminal.resize')) return;
    const s = this.stateOf(instanceId);
    s.lastSequence = Math.max(s.lastSequence, Number(frame.sequence ?? 0));
    const text = JSON.stringify({
      type: frame.type,
      instanceId,
      sequence: frame.sequence,
      ...(frame.type === 'terminal.output' ? { data: frame.data ?? '' } : { cols: frame.cols, rows: frame.rows }),
    });
    s.ring.push({ sequence: Number(frame.sequence ?? 0), text });
    if (s.ring.length > LOCAL_RING) s.ring.shift();
    this.broadcast(instanceId, text, Number(frame.sequence ?? 0));
  }

  private broadcast(instanceId: string, text: string, sequence?: number): void {
    const s = this.instances.get(instanceId);
    if (!s) return;
    for (const c of s.clients.values()) {
      if (c.replaying && sequence !== undefined) continue;
      if (!c.send(text)) {
        // 背压：客户端消费不动即断开（§13.2 输出写失败不阻塞）——重连时重放
        this.detach(c.id);
      }
    }
  }

  /** 客户端接入：先重放 lastSequence 之后短窗（缺口发 gap 帧），再进实时订阅。 */
  attach(
    send: (text: string) => boolean,
    req: TerminalAttachRequest & { clientId: string },
  ): void {
    const s = this.stateOf(req.instanceId);
    const client: Client = { id: req.clientId, send, instanceId: req.instanceId, mode: req.mode, replaying: true };
    s.clients.set(client.id, client);

    void this.finishAttach(client, s, req);
  }

  private async finishAttach(
    client: Client,
    s: InstanceState,
    req: TerminalAttachRequest & { clientId: string },
  ): Promise<void> {
    const from = req.lastSequence ?? 0;
    const { instanceId } = req;
    const kept = s.ring.filter((e) => e.sequence > from);
    const localComplete = from > 0 &&
      s.lastSequence >= from && kept.every((e, i) => e.sequence === from + i + 1);
    const history: Array<{ sequence: number; text: string }> = [];
    let replayFailed = false;
    let unsupported = false;
    if (!localComplete) {
      try {
        const entries = await this.supervisor.replayAfter(instanceId, from);
        for (const e of entries) {
          if (e.kind === 'gap') continue;
          history.push({ sequence: e.sequence, text: JSON.stringify({
            type: `terminal.${e.kind}`,
            instanceId,
            sequence: e.sequence,
            ...(e.kind === 'output' ? { data: e.data } : { cols: e.cols, rows: e.rows }),
          }) });
        }
      } catch (err) {
        replayFailed = true;
        unsupported = /unknown request type/.test(String(err));
      }
    }
    if (s.clients.get(client.id) !== client) return;

    // IPC 回包与实时帧可同批抵达；合并两个有界 ring 再推进水位。
    const entries = [...history, ...kept, ...s.ring].sort((a, b) => a.sequence - b.sequence);
    let cursor = from;
    if (replayFailed && !client.send(JSON.stringify({
      type: 'terminal.gap', instanceId, after: from,
      ...(unsupported ? { reason: 'replay-unsupported' } : {}),
    }))) return this.detach(client.id);
    for (const e of entries) {
      if (e.sequence <= cursor) continue;
      if (!replayFailed && e.sequence > cursor + 1 && !client.send(JSON.stringify({
        type: 'terminal.gap', instanceId, after: cursor, until: e.sequence - 1,
      }))) return this.detach(client.id);
      if (!client.send(e.text)) return this.detach(client.id);
      cursor = e.sequence;
    }
    client.replaying = false;
    if (!client.send(JSON.stringify({ type: 'attached', instanceId, lastSequence: cursor, mode: req.mode }))) {
      this.detach(client.id);
    }
  }

  detach(clientId: string): void {
    for (const s of this.instances.values()) {
      const c = s.clients.get(clientId);
      if (c) {
        s.clients.delete(clientId);
        if (s.lease?.clientId === clientId) this.releaseLease(s);
        return;
      }
    }
  }

  // —— Input Lease（多读一写）——

  leaseInfo(instanceId: string): { lease: InputLease | null } {
    const s = this.instances.get(instanceId);
    return { lease: s?.lease ?? null };
  }

  /** 申请写权：无主或前任超时即授予。 */
  requestControl(instanceId: string, clientId: string): InputLease | null {
    const s = this.stateOf(instanceId);
    if (s.lease && s.lease.expiresAt > Date.now() && s.lease.clientId !== clientId) return null;
    const lease: InputLease = {
      instanceId,
      clientId,
      leaseId: randomUUID(),
      expiresAt: Date.now() + LEASE_TTL_MS,
    };
    s.lease = lease;
    this.rearmLeaseTimer(s);
    return lease;
  }

  heartbeatLease(instanceId: string, clientId: string, leaseId: string): boolean {
    const s = this.instances.get(instanceId);
    if (!s?.lease || s.lease.leaseId !== leaseId || s.lease.clientId !== clientId) return false;
    s.lease = { ...s.lease, expiresAt: Date.now() + LEASE_TTL_MS };
    this.rearmLeaseTimer(s);
    return true;
  }

  releaseControl(instanceId: string, clientId: string): void {
    const s = this.instances.get(instanceId);
    if (s?.lease && s.lease.clientId === clientId) this.releaseLease(s);
  }

  private releaseLease(s: InstanceState): void {
    if (s.leaseTimer) clearTimeout(s.leaseTimer);
    s.leaseTimer = null;
    const had = s.lease;
    s.lease = null;
    if (had) {
      this.broadcast(had.instanceId, JSON.stringify({ type: 'lease.released', instanceId: had.instanceId }));
    }
  }

  private rearmLeaseTimer(s: InstanceState): void {
    if (s.leaseTimer) clearTimeout(s.leaseTimer);
    s.leaseTimer = setTimeout(() => {
      if (s.lease && s.lease.expiresAt <= Date.now()) this.releaseLease(s);
    }, LEASE_TTL_MS + 100);
    s.leaseTimer.unref();
  }

  /** 写入通道闸：只有 Lease 持有者能写 stdin / resize。 */
  canWrite(instanceId: string, clientId: string): boolean {
    const s = this.instances.get(instanceId);
    return !!s?.lease && s.lease.clientId === clientId && s.lease.expiresAt > Date.now();
  }
}
