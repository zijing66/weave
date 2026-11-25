/**
 * 跨浏览器窗口/标签页的 pane 同步（BroadcastChannel，同源）：
 * - presence：每窗周期广播自己的屏幕范围与在显实例（同实例跨窗互斥的判据）；
 * - drag：拖 pane 时源窗口广播指针屏幕坐标，其余窗口据自家范围命中渲染落点预览
 *   （接缝丝滑：指针还在源窗口里时目标窗口已经在亮预览）。
 * pane 的转移与切回不走这里——归 pane-transfer（storage 记录 + returning 状态）；
 * 本通道只做 presence 与拖拽指针。单向数据流：各窗只读广播，不回写对方状态。
 */

type Bounds = { x: number; y: number; w: number; h: number };

interface PeerInfo {
  winId: string;
  bounds: Bounds;
  instances: string[];
  lastSeen: number;
}

type Msg =
  | { type: 'presence'; winId: string; bounds: Bounds; instances: string[] }
  | { type: 'bye'; winId: string }
  | { type: 'drag'; winId: string; screenX: number; screenY: number }
  | { type: 'drag-end'; winId: string }
  | {
      type: 'drop-offer';
      winId: string;
      to: string;
      screenX: number;
      screenY: number;
      projectId?: number;
      view: DropView;
    }
  | { type: 'drop-ack'; winId: string; to: string; accepted: boolean };

/** 跨窗投放的视图载荷（与 pane-transfer 的 FrameView 同形；不携带任何凭据）。 */
export type DropView =
  | { kind: 'terminal'; instanceId: string; label: string; sessionId: string }
  | { kind: 'conversation'; label: string; sessionId: string };

export interface DropOffer {
  winId: string;
  screenX: number;
  screenY: number;
  /** 视图所属项目；undefined = 未知（照收）。 */
  projectId?: number;
  view: DropView;
}

export interface RemoteDrag {
  winId: string;
  screenX: number;
  screenY: number;
}

const CHANNEL = 'weave:term-panes';
const PRESENCE_MS = 2000;
const PEER_TTL = 7000;

/** crypto.randomUUID 只在安全上下文（https/localhost）有——HTTP 局域网访问没有。 */
function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

class PaneSync {
  readonly winId = uuid();
  private channel: BroadcastChannel | null = null;
  private peers = new Map<string, PeerInfo>();
  private dragCb: ((drag: RemoteDrag | null) => void) | null = null;
  private dropOfferCb: ((offer: DropOffer) => boolean) | null = null;
  /** 在飞的投放请求（一次只等一单：拖拽天然串行）。 */
  private pendingDrop: { to: string; resolve: (accepted: boolean) => void } | null = null;

  start(): void {
    if (this.channel || typeof BroadcastChannel === 'undefined') return;
    this.channel = new BroadcastChannel(CHANNEL);
    this.channel.onmessage = (e: MessageEvent<Msg>) => this.onMsg(e.data);
    setInterval(() => {
      this.sendPresence();
      const now = Date.now();
      for (const [id, peer] of this.peers) {
        if (now - peer.lastSeen > PEER_TTL) this.peers.delete(id);
      }
    }, PRESENCE_MS);
    window.addEventListener('beforeunload', () => {
      this.post({ type: 'bye', winId: this.winId });
    });
    this.sendPresence();
  }

  private onMsg(msg: Msg): void {
    if (!msg || msg.winId === this.winId) return;
    if (msg.type === 'presence') {
      this.peers.set(msg.winId, {
        winId: msg.winId,
        bounds: msg.bounds,
        instances: msg.instances,
        lastSeen: Date.now(),
      });
    } else if (msg.type === 'bye') {
      this.peers.delete(msg.winId);
    } else if (msg.type === 'drag') {
      this.dragCb?.({ winId: msg.winId, screenX: msg.screenX, screenY: msg.screenY });
    } else if (msg.type === 'drag-end') {
      this.dragCb?.(null);
    } else if (msg.type === 'drop-offer') {
      if (msg.to !== this.winId) return;
      const accepted =
        this.dropOfferCb?.({
          winId: msg.winId,
          screenX: msg.screenX,
          screenY: msg.screenY,
          projectId: msg.projectId,
          view: msg.view,
        }) ?? false;
      this.post({ type: 'drop-ack', winId: this.winId, to: msg.winId, accepted });
    } else if (msg.type === 'drop-ack') {
      const p = this.pendingDrop;
      if (!p || msg.to !== this.winId || msg.winId !== p.to) return;
      this.pendingDrop = null;
      p.resolve(msg.accepted);
    }
  }

  /** 更新本窗在显实例（presence 下一拍带上）。 */
  setInstances(instances: string[]): void {
    this.instances = instances;
    this.sendPresence();
  }
  private instances: string[] = [];

  private sendPresence(): void {
    this.post({
      type: 'presence',
      winId: this.winId,
      bounds: contentBounds(),
      instances: this.instances,
    });
  }

  instanceShownElsewhere(instanceId: string): boolean {
    for (const peer of this.peers.values()) {
      if (peer.instances.includes(instanceId)) return true;
    }
    return false;
  }

  onRemoteDrag(cb: (drag: RemoteDrag | null) => void): () => void {
    this.dragCb = cb;
    return () => {
      if (this.dragCb === cb) this.dragCb = null;
    };
  }

  broadcastDragPoint(screenX: number, screenY: number): void {
    this.post({ type: 'drag', winId: this.winId, screenX, screenY });
  }

  endDrag(): void {
    this.post({ type: 'drag-end', winId: this.winId });
  }

  /** 目标窗收到投放请求时调用；返回是否接单（true 终态才回 ack）。 */
  onDropOffer(cb: (offer: DropOffer) => boolean): () => void {
    this.dropOfferCb = cb;
    return () => {
      if (this.dropOfferCb === cb) this.dropOfferCb = null;
    };
  }

  /** 松手那一刻问目标窗要不要这份视图；无接单方（窗口已关/超上限）回 false。 */
  offerDrop(
    winId: string,
    payload: { screenX: number; screenY: number; projectId?: number; view: DropView },
  ): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.channel) {
        resolve(false);
        return;
      }
      this.pendingDrop = { to: winId, resolve };
      this.post({ type: 'drop-offer', winId: this.winId, to: winId, ...payload });
      setTimeout(() => {
        if (this.pendingDrop?.resolve === resolve) {
          this.pendingDrop = null;
          resolve(false);
        }
      }, 400);
    });
  }

  /** 指针落在哪个已知窗口（含本窗）的**内容区**里。 */
  windowAt(screenX: number, screenY: number): { winId: string; self: boolean } | null {
    const self = contentBounds();
    if (hit(screenX, screenY, self)) return { winId: this.winId, self: true };
    for (const peer of this.peers.values()) {
      if (hit(screenX, screenY, peer.bounds)) return { winId: peer.winId, self: false };
    }
    return null;
  }

  private post(msg: Msg): void {
    try {
      this.channel?.postMessage(msg);
    } catch {
      /* 通道异常不影响本窗功能 */
    }
  }
}

function contentBounds(): Bounds {
  // 内容区近似：水平居中、chrome 全在上侧（Windows 浏览器实测足够准）
  const x = window.screenX + Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const y = window.screenY + (window.outerHeight - window.innerHeight);
  return { x, y, w: window.innerWidth, h: window.innerHeight };
}

function hit(px: number, py: number, b: Bounds): boolean {
  return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
}

export const paneSync = new PaneSync();
