/** 外发提醒通道域：设置页 CRUD + 测试发送（编排画布的下拉也读同一份列表）。 */

import { apiFetch } from './client';

export type NotifyChannelKind = 'wecom' | 'feishu' | 'dingtalk' | 'email' | 'serverchan' | 'pushplus';

export interface NotifyChannelConfig {
  url?: string;
  secret?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from?: string;
  to?: string;
  sendKey?: string;
  token?: string;
}

export interface NotifyChannelRow {
  id: string;
  kind: NotifyChannelKind;
  name: string;
  config: NotifyChannelConfig;
  enabled: boolean;
  createdAt: string;
}

export interface NotifyChannelInput {
  kind: NotifyChannelKind;
  name: string;
  config: NotifyChannelConfig;
  enabled?: boolean;
}

export interface NotifySendResult {
  ok: boolean;
  status: 'succeeded' | 'failed' | 'timeout';
  output?: string;
  error?: string;
}

export const notifyApi = {
  listNotifyChannels: () => apiFetch<{ channels: NotifyChannelRow[] }>('/notify/channels'),
  createNotifyChannel: (input: NotifyChannelInput) =>
    apiFetch<{ channel: NotifyChannelRow }>('/notify/channels', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateNotifyChannel: (id: string, patch: Partial<NotifyChannelInput>) =>
    apiFetch<{ channel: NotifyChannelRow }>(`/notify/channels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  deleteNotifyChannel: (id: string) =>
    apiFetch<{ ok: true }>(`/notify/channels/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testNotifyChannel: (id: string) =>
    apiFetch<{ result: NotifySendResult }>(`/notify/channels/${encodeURIComponent(id)}/test`, {
      method: 'POST',
    }),
};
