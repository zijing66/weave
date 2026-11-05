import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyImage, copyText } from '../clipboard';

/**
 * 手机经局域网 HTTP 打开时 `navigator.clipboard` 整个不存在（无安全上下文）——
 * 老代码直接调它 → TypeError → 按钮点了没反应。两条路都要覆盖：有 API 走 API、
 * 缺 API 回落 execCommand、两条都不行返回 false 让调用方报错。
 */

afterEach(() => vi.unstubAllGlobals());

describe('copyText', () => {
  it('有 Clipboard API → 走 API，不碰 execCommand', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const exec = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('document', { execCommand: exec, createElement: vi.fn() });
    await expect(copyText('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(exec).not.toHaveBeenCalled();
  });

  it('无 Clipboard API（手机 HTTP）→ 回落 execCommand 复制成功', async () => {
    const area = { style: {}, focus: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn(), value: '' };
    const exec = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', {
      execCommand: exec,
      createElement: () => area,
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
    });
    await expect(copyText('prompt 原文')).resolves.toBe(true);
    expect(area.value).toBe('prompt 原文');
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('两条路都不行 → false（调用方据此 toast，不静默）', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    vi.stubGlobal('document', {
      execCommand: () => false,
      createElement: () => ({ style: {}, focus: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn() }),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
    });
    await expect(copyText('x')).resolves.toBe(false);
  });
});

/**
 * 局域网 HTTP 打开时连 `navigator.clipboard` 都不存在——这类失败要报成
 * 「地址不安全、换 HTTPS」，不能和「浏览器不支持」混成一条文案。
 */
describe('copyImage', () => {
  const blob = new Blob(['x'], { type: 'image/png' });
  const write = vi.fn().mockResolvedValue(undefined);

  /** 老式图片复制那套 DOM：离屏容器 + 选中 img + execCommand。`ok` = 复制是否成功。 */
  const stubLegacyDom = (ok: boolean): ReturnType<typeof vi.fn> => {
    const exec = vi.fn().mockReturnValue(ok);
    const img = { src: '', alt: '', decode: () => Promise.resolve() };
    const holder = {
      contentEditable: '',
      style: { cssText: '' },
      setAttribute: vi.fn(),
      appendChild: vi.fn(),
      remove: vi.fn(),
    };
    vi.stubGlobal('document', {
      createElement: (tag: string) => (tag === 'img' ? img : holder),
      createRange: () => ({ selectNode: vi.fn() }),
      execCommand: exec,
      body: { appendChild: vi.fn() },
    });
    vi.stubGlobal('window', { getSelection: () => ({ removeAllRanges: vi.fn(), addRange: vi.fn() }) });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: vi.fn() });
    return exec;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    write.mockClear();
  });

  it('非安全上下文 → insecure（不碰 Clipboard API）', async () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('navigator', { clipboard: { write } });
    await expect(copyImage(blob)).resolves.toBe('insecure');
    expect(write).not.toHaveBeenCalled();
  });

  it('非安全上下文但老式图片复制能成 → ok（局域网 HTTP 照常能复制）', async () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('navigator', { clipboard: { write } });
    const exec = stubLegacyDom(true);
    await expect(copyImage(blob)).resolves.toBe('ok');
    expect(write).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('Clipboard API 被拒但老式图片复制能成 → ok（不误报失败）', async () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { clipboard: { write: vi.fn().mockRejectedValue(new Error('denied')) } });
    vi.stubGlobal('ClipboardItem', class {});
    stubLegacyDom(true);
    await expect(copyImage(blob)).resolves.toBe('ok');
  });

  it('安全上下文但没有 ClipboardItem、老式路也不行 → unsupported', async () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { clipboard: { write } });
    vi.stubGlobal('ClipboardItem', undefined);
    stubLegacyDom(false);
    await expect(copyImage(blob)).resolves.toBe('unsupported');
    expect(write).not.toHaveBeenCalled();
  });

  it('安全上下文且支持 → 写进剪贴板', async () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { clipboard: { write } });
    vi.stubGlobal('ClipboardItem', class {});
    await expect(copyImage(blob)).resolves.toBe('ok');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('被权限拒绝 → failed', async () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { clipboard: { write: vi.fn().mockRejectedValue(new Error('denied')) } });
    vi.stubGlobal('ClipboardItem', class {});
    await expect(copyImage(blob)).resolves.toBe('failed');
  });
});
