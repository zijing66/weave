import { describe, it, expect, vi, afterEach } from 'vitest';
import { streamChat } from '../ai';

/** lib/ai 的流式契约：跨块拼接、半行、error 帧抛错、done 帧收束。 */

const encoder = new TextEncoder();

function stubStream(chunks: string[], init: ResponseInit = { status: 200 }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
        init,
      );
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lib/ai streamChat', () => {
  it('跨块拼接 + 半行：帧被切在三块之间也能还原', async () => {
    stubStream([
      'data: {"delta":"你"}', // 半行（无换行）
      '\n\ndata: {"del',
      'ta":"好"}\n\ndata: {"done":true}\n\n',
    ]);
    const deltas: string[] = [];
    await streamChat([{ role: 'user', content: 'hi' }], {
      onDelta: (text) => deltas.push(text),
    });
    expect(deltas).toEqual(['你', '好']);
  });

  it('error 帧 → 抛出该错误', async () => {
    stubStream(['data: {"error":"upstream 401: bad key"}\n\n']);
    await expect(
      streamChat([{ role: 'user', content: 'hi' }], { onDelta: () => {} }),
    ).rejects.toThrow('upstream 401');
  });

  it('HTTP 非 2xx → 抛服务端原文', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"AI assistant is not configured"}', { status: 409 })),
    );
    await expect(
      streamChat([{ role: 'user', content: 'hi' }], { onDelta: () => {} }),
    ).rejects.toThrow('not configured');
  });

  it('非 data 行（空行/注释/坏 JSON）忽略，不中断整轮', async () => {
    stubStream([
      ': keep-alive\n\n',
      'data: not-json\n\n',
      'data: {"delta":"ok"}\n\n',
      'data: {"done":true}\n\n',
    ]);
    const deltas: string[] = [];
    await streamChat([{ role: 'user', content: 'hi' }], {
      onDelta: (text) => deltas.push(text),
    });
    expect(deltas).toEqual(['ok']);
  });
});
