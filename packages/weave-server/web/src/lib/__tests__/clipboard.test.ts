import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyImage, copyText } from '../clipboard';

/**
 * 手机经局域网 IP 打开时 `navigator.clipboard` 整个不存在（无安全上下文）——
 * 老代码直接调它 → TypeError → 按钮点了没反应。copyText 两条路都要覆盖：有 API
 * 走 API、缺 API 回落 execCommand、两条都不行返回 false 让调用方报错出去。
 */

afterEach(() => vi.unstubAllGlobals());

describe('copyText', () => {
  it('有 Clipboard API → 走 API，不碰 execCommand', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const exec = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('isSecureContext', true);
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
 * copyImage 吃渲染函数（不是现成 Blob）：`navigator.clipboard.write` 要在用户
 * 手势内先落子，渲染 promise 直接喂给 `ClipboardItem`——等渲染完再 write 会丢
 * 激活、掉进已证死的老式路（2026-11-10 实测：Chromium 156 里 execCommand 图片
 * 复制只落一枚已撤销的 blob: URL 标记，粘贴即 ￼），故老式路已退役：写不进就
 * 如实报，绝不再落「execCommand 成功」的假 ok。
 */
describe('copyImage', () => {
  const blob = new Blob(['x'], { type: 'image/png' });
  const render = (): Promise<Blob> => Promise.resolve(blob);
  /** 真实引擎会 await ClipboardItem 里的 promise 值（渲染失败 → write 拒绝），
   *  mock 也要仿真这一点，否则「渲染失败上抛」的路径测不出来。 */
  const write = vi.fn(async (items: { [k: string]: unknown }[]) => {
    for (const it of items) {
      for (const v of Object.values(it)) {
        if (v instanceof Promise) await v;
      }
    }
  });

  /** 捕获喂给 ClipboardItem 构造器的值（promise 形断言要看它）。
   *  `opts.throwOnPromise`：老引擎不认 promise 值（构造即抛）。 */
  const stubClipboardItem = (opts: { throwOnPromise?: boolean } = {}): {
    values: Map<string, unknown>[];
  } => {
    const values: Map<string, unknown>[] = [];
    class Item {
      constructor(v: Record<string, unknown>) {
        Object.assign(this, v);
        for (const k of Object.keys(v)) {
          if (v[k] instanceof Promise && opts.throwOnPromise) {
            throw new TypeError('ClipboardItem: promise values not supported');
          }
        }
        values.push(new Map(Object.entries(v)));
      }
    }
    vi.stubGlobal('ClipboardItem', Item);
    return { values };
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    write.mockClear();
  });

  it('非安全上下文 → insecure，并且不渲染（别让人白等十几秒）', async () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('navigator', { clipboard: { write } });
    let called = 0;
    await expect(
      copyImage(() => {
        called += 1;
        return Promise.resolve(blob);
      }),
    ).resolves.toBe('insecure');
    expect(called).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  it('安全上下文但没有 ClipboardItem → unsupported（同样不渲染）', async () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { clipboard: { write } });
    vi.stubGlobal('ClipboardItem', undefined);
    let called = 0;
    await expect(
      copyImage(() => {
        called += 1;
        return Promise.resolve(blob);
      }),
    ).resolves.toBe('unsupported');
    expect(called).toBe(0);
  });

  it('安全上下文且支持 → 渲染 promise 直接喂 ClipboardItem（不等渲染再 write）', async () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { clipboard: { write } });
    const { values } = stubClipboardItem();
    await expect(copyImage(render)).resolves.toBe('ok');
    expect(write).toHaveBeenCalledTimes(1);
    const v = values[0]!.get('image/png');
    expect(v).toBeInstanceOf(Promise);
    await expect(v as Promise<Blob>).resolves.toBe(blob);
  });

  it('promise 形 write 被拒（Android 图片写不支持）→ 现成 blob 补一枪能成则 ok', async () => {
    vi.stubGlobal('isSecureContext', true);
    let calls = 0;
    const write2 = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('denied')) : Promise.resolve(undefined);
    });
    vi.stubGlobal('navigator', { clipboard: { write: write2 } });
    const { values } = stubClipboardItem();
    await expect(copyImage(render)).resolves.toBe('ok');
    expect(values[1]!.get('image/png')).toBe(blob);
  });

  it('构造器不吃 promise（老引擎，构造即抛）→ 渲染出来后用现成 blob 写', async () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { clipboard: { write } });
    const { values } = stubClipboardItem({ throwOnPromise: true });
    await expect(copyImage(render)).resolves.toBe('ok');
    expect(write).toHaveBeenCalledTimes(1);
    expect(values[0]!.get('image/png')).toBe(blob);
  });

  it('两连拒（Android 剪贴板写图片不可靠）→ failed——绝不落 execCommand 假成功', async () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { clipboard: { write: vi.fn().mockRejectedValue(new Error('denied')) } });
    stubClipboardItem();
    const exec = vi.fn().mockReturnValue(true);
    vi.stubGlobal('document', { execCommand: exec, createElement: () => ({ style: {} }), body: {} });
    await expect(copyImage(render)).resolves.toBe('failed');
    expect(exec).not.toHaveBeenCalled();
  });

  it('渲染失败 → 原样上抛（按生成失败报，不算剪贴板的账）', async () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { clipboard: { write } });
    stubClipboardItem();
    const boom = new Error('canvas dead');
    await expect(copyImage(() => Promise.reject(boom))).rejects.toBe(boom);
  });

  it('write 因渲染 promise 拒绝而拒绝 → 也按渲染失败上抛', async () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', {
      clipboard: { write: vi.fn().mockRejectedValue(new Error('write awaited a rejected promise')) },
    });
    stubClipboardItem();
    const boom = new Error('render boom');
    await expect(copyImage(() => Promise.reject(boom))).rejects.toBe(boom);
  });
});
