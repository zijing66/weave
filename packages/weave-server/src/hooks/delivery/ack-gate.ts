import type { PipeMessage } from '../message-deliverer.js';

/**
 * 回执闸与暂停闸（消息域投递的「1 送 1 回」秩序）：
 *
 * - **回执闸**（`awaitingAck`）：同会话队头在等它的 UPS 回执——终端层把一条贴进
 *   输入框后必须等回执才发下一条，再贴一份会在同一个框里叠成一段（两条并一条提交）。
 * - **暂停闸**（`stalled`）：未回执超窗 / 投递失败 → 该会话队列冲洗暂停；解除 =
 *   回执命中 / 手动重发 / 到点自动清除（「已发出却没回执」的行到点直接从队列清除）。
 *
 * 两个闸的状态都活在宿主（MessageDeliverer）的 Map 里，本模块只承载**判定与计时
 * 逻辑**；宿主以回调形式提供状态读写（`store`），闸自己不持有数据——测试可以直接
 * 注入假 store。
 */

/** 暂停闸成因：`unacked` = 已发出却没等到回执；`failed` = 投递失败。 */
export type StallReason = 'unacked' | 'failed';

export interface AckGateTimes {
  /** 未回执判 stall 的等待窗（ms）。 */
  ackStallMs: number;
  /** stall 自动解除窗（ms）；「已发出却没回执」的行到点从队列清除。 */
  ackStallReleaseMs: number;
  /** 斜杠命令的回执宽限（ms）：内建命令不发 UPS，宽限过即按已送达收。 */
  commandAckGraceMs: number;
}

export interface AckGateStore {
  /** 队头在等的消息 id（sessionId → messageId）。 */
  awaitingAck: Map<string, string>;
  /** 暂停闸（sessionId → 成因）。 */
  stalled: Map<string, { messageId: string; reason: StallReason }>;
  /** 内存消息行（闸读写它的 acked/status/stalled/releaseAt）。 */
  memory: Map<string, PipeMessage>;
}

export interface AckGateEvents {
  /** 消息域帧（message.stalled 等）；失败静默由宿主的 bus 包装保证。 */
  emit(message: { kind: string; [key: string]: unknown }): void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class AckGate {
  constructor(
    private readonly store: AckGateStore,
    private readonly times: AckGateTimes,
    private readonly events: AckGateEvents,
  ) {}

  /** 等回执的那条已经落地（回执到 / 失败 / 行没了）→ 撤防，返回 true。 */
  open(sessionId: string): boolean {
    const id = this.store.awaitingAck.get(sessionId);
    if (id === undefined) return true;
    const msg = this.store.memory.get(id);
    if (msg && msg.acked !== true && msg.status !== 'failed' && msg.status !== 'timeout') return false;
    this.store.awaitingAck.delete(sessionId);
    return true;
  }

  /** 队头在等回执？（send 的低延迟路径用：压着就只能排队。） */
  awaiting(sessionId: string): boolean {
    return !this.open(sessionId);
  }

  /** 队头在等的那条消息 id（重发「只补回车」判定用）。 */
  headOf(sessionId: string): string | undefined {
    return this.store.awaitingAck.get(sessionId);
  }

  /** 占住队头（投递出手即登记：下一条必须等它的回执）。 */
  await(sessionId: string, messageId: string): void {
    this.store.awaitingAck.set(sessionId, messageId);
  }

  /** 撤防（回执命中 / 行被删 / 会话退出时）。 */
  release(sessionId: string, messageId?: string): void {
    if (messageId === undefined) {
      this.store.awaitingAck.delete(sessionId);
      return;
    }
    if (this.store.awaitingAck.get(sessionId) === messageId) {
      this.store.awaitingAck.delete(sessionId);
    }
  }

  /** 该会话是否处于暂停闸（冲洗入口的第一道检查）。 */
  isStalled(sessionId: string): boolean {
    return this.store.stalled.has(sessionId);
  }

  /** 暂停闸成因行（重发判定 / 诊断面用）。 */
  stallCause(sessionId: string): { messageId: string; reason: StallReason } | undefined {
    return this.store.stalled.get(sessionId);
  }

  /** 解除暂停闸（回执命中 / 手动重发 / 行删除时）。 */
  clearStall(sessionId: string, messageId?: string): void {
    const cause = this.store.stalled.get(sessionId);
    if (!cause) return;
    if (messageId === undefined || cause.messageId === messageId) {
      this.store.stalled.delete(sessionId);
    }
  }

  /**
   * 未回执闸布防：prompt 送达后 `ackStallMs` 内没等到 UPS 回执 → 暂停该会话队列。
   * 斜杠命令走 `armCommandAck`（内建命令压根不发 UPS）。
   */
  armAckWatch(msg: PipeMessage): void {
    const timer = setTimeout(() => {
      const current = this.store.memory.get(msg.id);
      if (!current || current.acked || current.status !== 'delivered') return;
      this.stall(msg.sessionId, current, 'unacked');
    }, this.times.ackStallMs);
    timer.unref?.();
  }

  /**
   * 斜杠命令的回执收尾：给一个短窗口等 UPS——skill/插件命令会报，届时正常核销；
   * 窗口过期还没回执 = 宿主内建命令（`/compact` 之类压根不发 UPS），按已送达收、
   * 解闸续排，**不布防未回执闸**（否则压缩几分钟里整段显示「发送中」）。
   */
  armCommandAck(messageId: string, onRelease: (sessionId: string) => void): void {
    const timer = setTimeout(() => {
      const current = this.store.memory.get(messageId);
      if (!current || current.acked || current.status !== 'delivered') return;
      this.store.memory.set(messageId, { ...current, acked: true });
      this.release(current.sessionId, messageId);
      onRelease(current.sessionId);
    }, this.times.commandAckGraceMs);
    timer.unref?.();
  }

  /** 置闸：成因消息标记 stalled（常驻在途视图）+ message.stalled 帧（web 重拉）。 */
  stall(sessionId: string, msg: PipeMessage, reason: StallReason): void {
    this.store.stalled.set(sessionId, { messageId: msg.id, reason });
    const current = this.store.memory.get(msg.id);
    // 「已发出却没回执」那条闸到点会被清出队列（见 release）：把时刻一并下发，
    // web 拿它走倒计时。投递失败的行没有这回事——它本来就是失败态，留在队列里等人重发。
    const clearAt =
      current && current.status === 'delivered' && current.acked !== true
        ? new Date(Date.now() + this.times.ackStallReleaseMs).toISOString()
        : null;
    if (current) this.store.memory.set(msg.id, { ...current, stalled: true, releaseAt: clearAt });
    this.events.emit({
      kind: 'message.stalled',
      messageId: msg.id,
      sessionId,
      reason,
      at: new Date().toISOString(),
    });
    const release = setTimeout(
      () => this.autoRelease(sessionId, msg.id),
      this.times.ackStallReleaseMs,
    );
    release.unref?.();
  }

  /**
   * 闸到点自动解除：回执一直不来 = 那条很可能压根没进对话（贴着文本按下去的时候
   * 会话正在重启，输入框被清掉就是这样），闸不能因此把该会话的队列永久停住。
   * 「已发出却没回执」的行到点**直接从队列清除**（用户裁决：正文只在这一行里，
   * 窗口期就是给人看清与重发的）；投递失败的行留着等人重发，只解闸续排。
   */
  autoRelease(sessionId: string, messageId: string): void {
    // 期间已被回执 / 重发 / 删除处理过：闸不在了或换了成因，这一拍作废。
    if (this.store.stalled.get(sessionId)?.messageId !== messageId) return;
    const current = this.store.memory.get(messageId);
    if (current && current.status === 'delivered' && current.acked !== true) {
      this.dropAndRelease(sessionId, messageId); // 解闸 + 撤防 + 续排都在里面
      return;
    }
    this.store.stalled.delete(sessionId);
    this.release(sessionId, messageId);
    this.onAutoRelease?.(sessionId);
  }

  /** 到点清除 / 手动删除共用的收尾：摘行 + 解闸 + 撤防 + dismissed 帧 + 续排回调。 */
  dropAndRelease(sessionId: string, messageId: string): void {
    this.store.memory.delete(messageId);
    this.store.stalled.delete(sessionId);
    this.release(sessionId, messageId);
    this.events.emit({
      kind: 'message.dismissed',
      messageId,
      sessionId,
      at: new Date().toISOString(),
    });
    this.onAutoRelease?.(sessionId);
  }

  /** 闸解除后的续排钩子（宿主接 `scheduleFlushContinuation`）。 */
  onAutoRelease?: (sessionId: string) => void;

  /** 最近一次 `acknowledge` 是否命中（宿主据此决定要不要续排排空）。 */
  hitLast = false;

  /**
   * 投递回执核销（UPS 到达）：prompt 原文与在途条目匹配即成真。一条 UPS 可以
   * 核销多条在途（宿主把连发的几条合成一次提交）；返回命中消息的随附图 id。
   * 比对规则：剥跨会话壳折叠空白后「包含」；短文本（< `ackMinText`）认**尾部相等**
   * （层② 往框里追加，框里先在的内容只会垫在前面）；带图消息再去尽空白比一次。
   */
  acknowledge(
    sessionId: string,
    prompt: string,
    eventId: number | undefined,
    opts: { ackMinText: number },
  ): string[] {
    const seenRaw = normalizePromptText(prompt);
    const seen = seenRaw.replace(/\[Image #\d+\]/gi, '').trim();
    const imageIds: string[] = [];
    let hit = false;
    this.hitLast = false;
    for (const msg of [...this.store.memory.values()].reverse()) {
      if (msg.sessionId !== sessionId || msg.acked || msg.mode !== 'prompt') continue;
      const want = normalizePromptText(msg.text);
      const textHit =
        !!want && (want.length >= opts.ackMinText ? seenRaw.includes(want) : seenRaw.endsWith(want));
      const imageHit =
        (msg.attachments?.length ?? 0) > 0 &&
        (want ? stripSpace(seenRaw).includes(stripSpace(want)) : seen.length === 0);
      if (!textHit && !imageHit) continue;
      hit = true;
      this.store.memory.set(msg.id, {
        ...msg,
        acked: true,
        stalled: false,
        ...(eventId === undefined ? {} : { ackedEventId: eventId }),
      });
      // 回执命中暂停闸成因 → 闸解除；队头在等它 → 撤防（下一条可以发了）。
      if (this.store.stalled.get(sessionId)?.messageId === msg.id) {
        this.store.stalled.delete(sessionId);
      }
      this.release(sessionId, msg.id);
      imageIds.push(...(msg.attachments?.map((i) => i.id) ?? []));
      this.events.emit({
        kind: 'message.acknowledged',
        messageId: msg.id,
        sessionId,
        at: new Date().toISOString(),
      });
    }
    this.hitLast = hit;
    return hit ? imageIds : [];
  }

  /** 会话退出：进程没了，这一条的回执再也不会到——撤防即可（死信落定归宿主）。 */
  sessionExited(sessionId: string): void {
    this.release(sessionId);
  }

  /** 测试/等待辅助：到点再解析（原实现内联在 awaitInboxReady 的轮询里）。 */
  static sleep = sleep;
}

/** 回执比对归一：剥掉 Claude Code 给会话间消息裹的外壳再折叠空白。 */
export function normalizePromptText(text: string): string {
  return text
    .replace(/<\/?cross-session-message[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 带图消息的二次归一（粘贴处理器会把多行 chunk 用空串连起来）：去尽空白再比。 */
export function stripSpace(text: string): string {
  return text.replace(/\s+/g, '');
}
