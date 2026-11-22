/**
 * 终端流 WebSocket 客户端（B4，CLAUDE.md §9 唯一 WS 例外的前端实现）：
 * `/terminals/ws` 的 NDJSON 协议（attach / terminal.output / gap / lease.*）。
 * 唯一客户端——别的组件不得再 new WebSocket。
 */

export type TerminalFrame =
  | { type: 'attached'; instanceId: string; lastSequence: number; mode: string }
  | { type: 'terminal.output'; instanceId: string; sequence: number; data: string }
  | { type: 'terminal.gap'; instanceId: string; after?: number; until?: number }
  | { type: 'terminal.resize'; instanceId: string; sequence: number; cols: number; rows: number }
  | { type: 'lease.granted'; instanceId: string; leaseId: string; expiresAt: number }
  | { type: 'lease.denied'; instanceId: string }
  | { type: 'lease.released'; instanceId: string }
  | { type: 'error'; error: string };

export interface TerminalClientCallbacks {
  onFrame: (frame: TerminalFrame) => void;
  /** 连接断开（重连由本客户端负责，带 lastSequence）。 */
  onDisconnect?: () => void;
  onReconnect?: () => void;
}

export class TerminalClient {
  private ws: WebSocket | null = null;
  private lastSequence: number | undefined;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private leaseId: string | null = null;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly instanceId: string,
    private readonly mode: 'readonly' | 'interactive',
    private readonly cb: TerminalClientCallbacks,
  ) {}

  connect(): void {
    this.closedByUser = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const wasReconnect = this.lastSequence !== undefined;
    const ws = new WebSocket(`${proto}://${location.host}/terminals/ws`);
    this.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          type: 'attach',
          instanceId: this.instanceId,
          lastSequence: this.lastSequence,
          mode: this.mode,
          cols: 80,
          rows: 24,
        }),
      );
      if (this.mode === 'interactive') this.requestControl();
      if (wasReconnect) this.cb.onReconnect?.();
    });
    ws.addEventListener('message', (e) => {
      let frame: TerminalFrame;
      try {
        frame = JSON.parse(String(e.data)) as TerminalFrame;
      } catch {
        return;
      }
      if (frame.type === 'terminal.output' && typeof frame.sequence === 'number') {
        this.lastSequence = frame.sequence;
      }
      this.cb.onFrame(frame);
    });
    ws.addEventListener('close', () => {
      this.stopLeaseHeartbeat();
      if (this.closedByUser) return;
      this.cb.onDisconnect?.();
      // 重连（指数退避封顶 5s）
      const delay = Math.min(500 * (this.reconnectAttempts++ + 1), 5000);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private reconnectAttempts = 0;

  send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** 申请写权；获批后自动心跳。 */
  requestControl(): void {
    this.send({ type: 'request_control', instanceId: this.instanceId });
  }

  releaseControl(): void {
    this.send({ type: 'release', instanceId: this.instanceId });
    this.stopLeaseHeartbeat();
  }

  stdin(data: string): void {
    this.send({ type: 'stdin', instanceId: this.instanceId, data });
  }

  resize(cols: number, rows: number): void {
    this.send({ type: 'resize', instanceId: this.instanceId, cols, rows });
  }

  /** Lease 心跳（获批后调用；15s TTL，5s 一拍）。 */
  startLeaseHeartbeat(leaseId: string): void {
    this.stopLeaseHeartbeat();
    this.leaseId = leaseId;
    this.leaseTimer = setInterval(() => {
      this.send({ type: 'heartbeat', instanceId: this.instanceId, leaseId: this.leaseId });
    }, 5000);
  }

  private stopLeaseHeartbeat(): void {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    this.leaseId = null;
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopLeaseHeartbeat();
    this.send({ type: 'detach', instanceId: this.instanceId });
    this.ws?.close();
    this.ws = null;
  }
}
