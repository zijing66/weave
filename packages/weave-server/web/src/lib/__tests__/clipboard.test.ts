import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyText } from '../clipboard';

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
