import type { HookEventBus } from './bus.js';
import { notifyPayloadFor } from './push-notify.js';
import { sendToChannel, type NotifyPayload } from './notify-channels.js';
import type { WebhookResult } from './handlers/webhook.js';
import type { NotifyChannelRepository, NotifyChannelRow } from '../repositories/notify-channels.js';

/**
 * 外发提醒扇出：把与 Web Push 同一份载荷（`notifyPayloadFor`）发给全部启用
 * 通道。逐通道隔离失败、绝不抛回总线（hooks 非阻塞不变式）；不自动禁用通道
 * ——禁用是管理决策，诊断交给设置页的「测试发送」。
 */
export class NotifyFanout {
  constructor(
    private readonly deps: {
      channels: Pick<NotifyChannelRepository, 'listEnabled'>;
      bus: HookEventBus;
      labelOf: (sessionId: string) => string;
      /** 发送函数（测试注入）；缺省 sendToChannel。 */
      sendImpl?: (
        channel: Pick<NotifyChannelRow, 'kind' | 'config'>,
        payload: NotifyPayload,
        fetchImpl?: typeof fetch,
      ) => Promise<WebhookResult>;
      fetchImpl?: typeof fetch;
    },
  ) {
    deps.bus.subscribe((message) => this.onBus(message));
  }

  private onBus(message: Parameters<HookEventBus['emit']>[0]): void {
    try {
      const payload = notifyPayloadFor(message, this.deps.labelOf);
      if (!payload) return;
      const channels = this.deps.channels.listEnabled();
      if (channels.length === 0) return;
      void this.fanAll(channels, payload);
    } catch {
      // 订阅回调绝不能把异常带进 emit（ingest 路径）
    }
  }

  private async fanAll(channels: NotifyChannelRow[], payload: NotifyPayload): Promise<void> {
    for (const channel of channels) {
      try {
        const result = await (this.deps.sendImpl ?? sendToChannel)(
          channel,
          payload,
          this.deps.fetchImpl,
        );
        if (!result.ok) {
          console.warn(`[weave] notify channel ${channel.name} failed: ${result.error ?? result.status}`);
        }
      } catch (err) {
        console.warn(
          `[weave] notify channel ${channel.name} threw: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}
