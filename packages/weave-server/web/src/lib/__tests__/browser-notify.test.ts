import { describe, it, expect, vi, afterEach } from 'vitest';
import { ensureNotifyPermission, notifyBrowser } from '../browser-notify';

/**
 * 浏览器通知门控（node 环境没有 Notification → stub 全局）：未授权一律不发，
 * 权限申请只在缺省态发起（denied 不再反复弹窗）。
 */

const withNotification = (permission: string, requestPermission?: () => Promise<string>) =>
  vi.stubGlobal(
    'Notification',
    Object.assign(vi.fn(), { permission, ...(requestPermission ? { requestPermission } : {}) }),
  );

afterEach(() => vi.unstubAllGlobals());

describe('notifyBrowser', () => {
  it('无 Notification（环境不支持）→ 静默跳过，不抛', () => {
    vi.stubGlobal('Notification', undefined);
    expect(() => notifyBrowser('t', 'b')).not.toThrow();
  });

  it('未授权 → 不发（调用方 toast 兜底）', () => {
    const ctor = vi.fn();
    vi.stubGlobal('Notification', Object.assign(ctor, { permission: 'default' }));
    notifyBrowser('t', 'b');
    expect(ctor).not.toHaveBeenCalled();
  });

  it('已授权 → 标题 + 正文', () => {
    const ctor = vi.fn();
    vi.stubGlobal('Notification', Object.assign(ctor, { permission: 'granted' }));
    notifyBrowser('会话空闲提醒', '「a」已空闲');
    expect(ctor).toHaveBeenCalledWith('会话空闲提醒', { body: '「a」已空闲' });
  });
});

describe('ensureNotifyPermission', () => {
  it('已授权 → true，不再申请', async () => {
    const requestPermission = vi.fn();
    withNotification('granted', requestPermission);
    expect(await ensureNotifyPermission()).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('已拒绝 → false，不重复弹窗', async () => {
    const requestPermission = vi.fn();
    withNotification('denied', requestPermission);
    expect(await ensureNotifyPermission()).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('缺省态 → 申请并按其结果', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted');
    withNotification('default', requestPermission);
    expect(await ensureNotifyPermission()).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });
});
