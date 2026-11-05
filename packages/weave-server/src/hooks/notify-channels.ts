import { createHmac } from 'node:crypto';
import { postJson, type WebhookResult } from './handlers/webhook.js';
import type { NotifyChannelConfig, NotifyChannelRow } from '../repositories/notify-channels.js';

/** 统一载荷：提醒扇出与编排出口都按这一份喂给各平台适配器。 */
export interface NotifyPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

/** 飞书自定义机器人签名：key = `${timestamp}\n${secret}`，消息为空串，base64。 */
export function feishuSign(timestamp: number, secret: string): string {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

/** 钉钉加签：key = secret，消息 = `${timestamp}\n${secret}`，base64 后 URL 编码。 */
export function dingtalkSign(timestamp: number, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64');
}

/**
 * 单个通道的发送：平台差异只在这里（载荷形状、签名放 body 还是 URL、SMTP）。
 * HTTP 类全部走 postJson（协议白名单/5s 超时/响应截断的唯一边界）；邮件是
 * SMTP 协议，走 nodemailer 动态导入（daemon 启动不硬载，测试可 mock）。
 */
export async function sendToChannel(
  channel: Pick<NotifyChannelRow, 'kind' | 'config'>,
  payload: NotifyPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<WebhookResult> {
  const config = channel.config;
  const text = `${payload.title}\n${payload.body}`;
  switch (channel.kind) {
    case 'wecom':
      return postJson(config.url ?? '', undefined, { msgtype: 'text', text: { content: text } }, fetchImpl);
    case 'feishu': {
      const ts = Math.floor(Date.now() / 1000);
      return postJson(
        config.url ?? '',
        undefined,
        {
          ...(config.secret ? { timestamp: String(ts), sign: feishuSign(ts, config.secret) } : {}),
          msg_type: 'text',
          content: { text },
        },
        fetchImpl,
      );
    }
    case 'dingtalk': {
      const ts = Date.now();
      let url = config.url ?? '';
      if (config.secret) {
        const sign = encodeURIComponent(dingtalkSign(ts, config.secret));
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}timestamp=${ts}&sign=${sign}`;
      }
      return postJson(url, undefined, { msgtype: 'text', text: { content: text } }, fetchImpl);
    }
    case 'serverchan':
      return postJson(
        `https://sctapi.ftqq.com/${config.sendKey ?? ''}.send`,
        undefined,
        { title: payload.title, desp: payload.body },
        fetchImpl,
      );
    case 'pushplus':
      return postJson(
        'https://www.pushplus.plus/send',
        undefined,
        { token: config.token ?? '', title: payload.title, content: payload.body, template: 'txt' },
        fetchImpl,
      );
    case 'email':
      return sendEmail(config, payload);
  }
}

async function sendEmail(config: NotifyChannelConfig, payload: NotifyPayload): Promise<WebhookResult> {
  const host = config.host;
  const to = config.to;
  if (!host || !to) {
    return { ok: false, status: 'failed', error: 'email channel needs host and to' };
  }
  try {
    const nodemailer = (await import('nodemailer')).default;
    const transport = nodemailer.createTransport({
      host,
      port: config.port ?? 465,
      secure: config.secure ?? (config.port ?? 465) === 465,
      ...(config.user ? { auth: { user: config.user, pass: config.pass ?? '' } } : {}),
    });
    const info = await transport.sendMail({
      from: config.from ?? config.user ?? 'weave@localhost',
      to,
      subject: payload.title,
      text: payload.body,
    });
    return { ok: true, status: 'succeeded', output: String(info.messageId ?? 'sent') };
  } catch (err) {
    return { ok: false, status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}
