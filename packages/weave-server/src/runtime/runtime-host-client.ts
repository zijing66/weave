import { connect, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import type {
  HostAckPayload,
  HostInstanceSummary,
  InstanceSpawnPayload,
  RuntimeHostRequest,
  RuntimeHostResponse,
} from './protocol.js';
import { RUNTIME_PROTOCOL_VERSION } from './protocol.js';

/**
 * daemon 侧 Runtime Host 客户端（agent-runtime-host-design.md §2）：NDJSON 帧、
 * 请求按 id 关联、事件回调订阅。失联语义单向（daemon→Host）：断线只置
 * unreachable，Host 永远不因「没人管」自杀。
 */

export type HostEventFrame = {
  eventId: string;
  timestamp: number;
} & Record<string, unknown>;

export class RuntimeHostClient {
  private socket: Socket | null = null;
  private buffer = '';
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private events: (frame: HostEventFrame) => void = () => {};

  constructor(
    private readonly pipePath: string,
    private readonly localToken: string,
    private readonly onDisconnect: () => void = () => {},
  ) {}

  onEvent(cb: (frame: HostEventFrame) => void): void {
    this.events = cb;
  }

  /** 连接 + 握手（hello/ack）；ack 里的实例清单即对账起点。 */
  async connect(timeoutMs = 3_000): Promise<HostAckPayload> {
    const socket: Socket = await new Promise((resolve, reject) => {
      const s = connect(this.pipePath);
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`connect timeout: ${this.pipePath}`));
      }, timeoutMs);
      s.once('connect', () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    const gone = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      const err = new Error('runtime host disconnected');
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.onDisconnect();
    };
    socket.on('close', gone);
    socket.on('error', gone);
    const ack = (await this.request('hello', {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      weaveVersion: process.env.WEAVE_VERSION ?? 'dev',
      localToken: this.localToken,
    })) as HostAckPayload;
    return ack;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      let msg: RuntimeHostResponse & Record<string, unknown>;
      try {
        msg = JSON.parse(line) as RuntimeHostResponse & Record<string, unknown>;
      } catch {
        continue; // 坏行丢弃（NDJSON 可恢复）
      }
      if (typeof msg.id === 'string' && msg.id !== '' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.success) p.resolve(msg.payload);
        else p.reject(new Error(msg.error ?? 'runtime host request failed'));
        continue;
      }
      // 事件帧（含 terminal.gap 背压标记）
      this.events({ eventId: String(msg.eventId ?? ''), timestamp: Number(msg.timestamp ?? Date.now()), ...msg });
    }
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  request(type: string, payload?: unknown, instanceId?: string, timeoutMs = 15_000): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error('runtime host not connected'));
    const id = randomUUID();
    const msg: RuntimeHostRequest = { id, type, payload, ...(instanceId ? { instanceId } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`runtime host request "${type}" timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      socket.write(JSON.stringify(msg) + '\n');
    });
  }

  spawnInstance(payload: InstanceSpawnPayload): Promise<{ osPid: number }> {
    return this.request('instance.spawn', payload) as Promise<{ osPid: number }>;
  }

  sendStdin(instanceId: string, data: string): Promise<unknown> {
    return this.request('instance.stdin', { data }, instanceId);
  }

  resize(instanceId: string, cols: number, rows: number): Promise<unknown> {
    return this.request('instance.resize', { cols, rows }, instanceId);
  }

  killInstance(instanceId: string): Promise<unknown> {
    return this.request('instance.kill', undefined, instanceId);
  }

  listInstances(): Promise<HostInstanceSummary[]> {
    return this.request('instances.list').then((r) => (r as { instances: HostInstanceSummary[] }).instances);
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
