import { describe, it, expect, vi } from 'vitest';
import { sendToChannel, feishuSign, dingtalkSign } from '../notify-channels.js';
import type { NotifyChannelRow } from '../../repositories/notify-channels.js';

/**
 * 外发通道适配器：平台差异只在载荷形状与签名位置（飞书签名进 body、钉钉进
 * URL、其余直发），签名用固定向量钉死（两者同为 HMAC-SHA256 base64 但 key
 * 构造相反，最容易写混）。
 */

const mockNodemailer = vi.hoisted(() => {
  const sendMail = vi.fn(async () => ({ messageId: 'mid-1' }));
  const createTransport = vi.fn(() => ({ sendMail }));
  return { sendMail, createTransport };
});

vi.mock('nodemailer', () => ({ default: { createTransport: mockNodemailer.createTransport } }));

const channel = (kind: NotifyChannelRow['kind'], config: NotifyChannelRow['config']): NotifyChannelRow => ({
  id: 'c1',
  kind,
  name: 'test',
  config,
  enabled: true,
  createdAt: new Date().toISOString(),
});

const fakeFetch = (status = 200, text = '{"errcode":0}') => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (input: unknown, init: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(text, { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
};

const payload = { title: 'Title', body: 'Body' };

describe('signatures', () => {
  it('飞书签名 = HMAC(key="ts\\nsecret", msg="") base64', () => {
    expect(feishuSign(1_700_000_000, 'sec')).toBe('ttGYnPblC3CcNExnS7y5igm57JhpqZJtHpJ+TURiUeg=');
  });

  it('钉钉签名 = HMAC(key=secret, msg="ts\\nsecret") base64', () => {
    expect(dingtalkSign(1_700_000_000, 'sec')).toBe('cf42ICPYLw6bZPdT9RYqB9aTVcBpg/4C+X63xCzV4bs=');
  });
});

describe('sendToChannel', () => {
  it('企微 = text 消息直发 webhook URL', async () => {
    const { fn, calls } = fakeFetch();
    const result = await sendToChannel(channel('wecom', { url: 'https://qy.example/hook?key=k' }), payload, fn);
    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toBe('https://qy.example/hook?key=k');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ msgtype: 'text', text: { content: 'Title\nBody' } });
  });

  it('飞书带密钥 = 签名放 body', async () => {
    const { fn, calls } = fakeFetch();
    await sendToChannel(channel('feishu', { url: 'https://fs.example/hook', secret: 'sec' }), payload, fn);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.msg_type).toBe('text');
    expect(body.sign).toBe(feishuSign(Number(body.timestamp), 'sec'));
  });

  it('飞书无密钥 = 不带签名键', async () => {
    const { fn, calls } = fakeFetch();
    await sendToChannel(channel('feishu', { url: 'https://fs.example/hook' }), payload, fn);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.sign).toBeUndefined();
    expect(body.timestamp).toBeUndefined();
  });

  it('钉钉带密钥 = 签名拼进 URL', async () => {
    const { fn, calls } = fakeFetch();
    await sendToChannel(channel('dingtalk', { url: 'https://dd.example/robot?access_token=t', secret: 'sec' }), payload, fn);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('access_token')).toBe('t');
    expect(url.searchParams.get('sign')).toBe(dingtalkSign(Number(url.searchParams.get('timestamp')), 'sec'));
    expect(JSON.parse(String(calls[0]!.init.body)).msgtype).toBe('text');
  });

  it('Server酱 = sendKey 进 URL、title/desp 进行文', async () => {
    const { fn, calls } = fakeFetch();
    await sendToChannel(channel('serverchan', { sendKey: 'SCT123' }), payload, fn);
    expect(calls[0]!.url).toBe('https://sctapi.ftqq.com/SCT123.send');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ title: 'Title', desp: 'Body' });
  });

  it('PushPlus = token 进 body', async () => {
    const { fn, calls } = fakeFetch();
    await sendToChannel(channel('pushplus', { token: 'pp-token' }), payload, fn);
    expect(calls[0]!.url).toBe('https://www.pushplus.plus/send');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      token: 'pp-token',
      title: 'Title',
      content: 'Body',
    });
  });

  it('HTTP 失败照实回 failed', async () => {
    const { fn } = fakeFetch(500, 'boom');
    const result = await sendToChannel(channel('wecom', { url: 'https://qy.example/hook' }), payload, fn);
    expect(result).toMatchObject({ ok: false, status: 'failed', error: 'HTTP 500' });
  });

  it('邮件缺 host/to = failed 且不抛', async () => {
    const result = await sendToChannel(channel('email', {}), payload);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('host and to');
  });

  it('邮件 = nodemailer 动态导入并带 subject/text', async () => {
    mockNodemailer.sendMail.mockClear();
    const result = await sendToChannel(
      channel('email', { host: 'smtp.example', port: 465, user: 'u', pass: 'p', to: 'a@b.c' }),
      payload,
    );
    expect(result).toMatchObject({ ok: true, output: 'mid-1' });
    expect(mockNodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example', port: 465, secure: true, auth: { user: 'u', pass: 'p' } }),
    );
    expect(mockNodemailer.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@b.c', subject: 'Title', text: 'Body' }),
    );
  });
});
