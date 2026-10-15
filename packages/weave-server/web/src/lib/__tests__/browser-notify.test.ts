import { describe, it, expect, vi, afterEach } from 'vitest';
import { ensureNotifyPermission, notifyBrowser } from '../browser-notify';

/**
 * 浏览器通知门控（node 环境没有 Notification → stub 全局）：未授权一律不发，
 * 权限申请只在缺省态发起（denied 不再反复弹窗）。失败三分态各自可辨：
 * insecure（手机 HTTP 访问）≠ denied（用户拒绝）≠ unsupported（无 API）。
 */

const withNotification = (permission: string, requestPermission?: () => Promise<string>) =>
  vi.stubGlobal(
    'Notification',
    Object.assign(vi.fn(), { permission, ...(requestPermission ? { requestPermission } : {}) }),
  );

afterEach(() => vi.unstubAllGlobals());

describe('notifyBrowser', () => {
  it('无 Notification（环境不支持）→ 静默跳过，不抛', async () => {
    vi.stubGlobal('Notification', undefined);
    await expect(notifyBrowser('t', 'b')).resolves.toBeUndefined();
  });

  it('未授权 → 不发（调用方 toast 兜底）', async () => {
    const ctor = vi.fn();
    vi.stubGlobal('Notification', Object.assign(ctor, { permission: 'default' }));
    await notifyBrowser('t', 'b');
    expect(ctor).not.toHaveBeenCalled();
  });

  it('已授权 → 标题 + 正文（无 SW 时走构造器兜底）', async () => {
    const ctor = vi.fn();
    vi.stubGlobal('Notification', Object.assign(ctor, { permission: 'granted' }));
    await notifyBrowser('会话空闲提醒', '「a」已空闲');
    expect(ctor).toHaveBeenCalledWith('会话空闲提醒', { body: '「a」已空闲' });
  });

  it('已授权 + SW 已注册 → showNotification 优先（Android Chromium 只认它）', async () => {
    const ctor = vi.fn();
    const showNotification = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('Notification', Object.assign(ctor, { permission: 'granted' }));
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: () => Promise.resolve({ showNotification }) } });
    await notifyBrowser('会话空闲提醒', '「a」已空闲');
    expect(showNotification).toHaveBeenCalledWith('会话空闲提醒', { body: '「a」已空闲' });
    expect(ctor).not.toHaveBeenCalled();
  });
});

describe('ensureNotifyPermission', () => {
  it('无 Notification API（iOS 普通标签页）→ unsupported', async () => {
    vi.stubGlobal('Notification', undefined);
    expect(await ensureNotifyPermission()).toBe('unsupported');
  });

  it('非安全上下文（手机经局域网 HTTP 访问）→ insecure，permission 恒报 denied 也不去申请', async () => {
    const requestPermission = vi.fn();
    vi.stubGlobal('isSecureContext', false);
    withNotification('denied', requestPermission);
    expect(await ensureNotifyPermission()).toBe('insecure');
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('已授权 → granted，不再申请', async () => {
    const requestPermission = vi.fn();
    withNotification('granted', requestPermission);
    expect(await ensureNotifyPermission()).toBe('granted');
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('已拒绝 → denied，不重复弹窗', async () => {
    const requestPermission = vi.fn();
    withNotification('denied', requestPermission);
    expect(await ensureNotifyPermission()).toBe('denied');
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('缺省态 → 申请并按其结果', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted');
    withNotification('default', requestPermission);
    expect(await ensureNotifyPermission()).toBe('granted');
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });
});
