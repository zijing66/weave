import { describe, expect, it, vi } from 'vitest';
import { createCodexForkExtract } from '../fork.js';

/**
 * codex fork 提取面的 JSON-RPC 状态机：真实 app-server 不起——spawn 注入 fake。
 * 预期节拍：initialize → thread/fork（ephemeral）→ 回调 onForkId → turn/start →
 * item/completed（agentMessage 累积，别的 threadId 不混入）→ turn/completed 收尾。
 * 失败路：fork RPC 错误 / 回合 interrupted / 超时 → null。
 */

interface ScriptedWrite {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

interface FakeChild {
  pid?: number;
  writes: string[];
  emitToStdout(chunk: string): void;
}

interface FakeSpawned extends FakeChild {
  on(event: string, cb: (...args: never[]) => void): unknown;
  kill(): void;
  stdin: { write(chunk: string): boolean; on(event: string, cb: (...a: never[]) => void): unknown; end(): void };
  stdout: { setEncoding(enc: string): void; on(event: string, cb: (chunk: string) => void): void };
}

/** fake 子进程：stdin.write 捕获进 writes 并回调脚本；stdout 经 emitToStdout 喂数据。 */
const fakeChild = (onWrite?: (msg: ScriptedWrite) => void): FakeSpawned => {
  const child = {
    pid: 4321,
    writes: [] as string[],
    emitToStdout: (_chunk: string) => {},
  };
  const exitCbs: Array<(...args: never[]) => void> = [];
  const dataCbs: Array<(chunk: string) => void> = [];
  let onWriteHook = onWrite;
  child.emitToStdout = (chunk: string) => {
    for (const cb of dataCbs) cb(chunk);
  };
  const spawned: FakeSpawned = {
    ...child,
    on: (event, cb) => {
      if (event === 'exit') exitCbs.push(cb);
      return undefined;
    },
    kill: () => {
      for (const cb of exitCbs) cb();
    },
    stdin: {
      write: (chunk: string) => {
        child.writes.push(chunk);
        try {
          onWriteHook?.(JSON.parse(chunk) as ScriptedWrite);
        } catch {
          /* 脚本不用管坏行 */
        }
        return true;
      },
      on: () => undefined,
      end: () => undefined,
    },
    stdout: {
      setEncoding: () => undefined,
      on: (event, cb) => {
        if (event === 'data') dataCbs.push(cb);
      },
    },
  };
  return spawned;
};

/** 后台排一拍（fake 脚本用 setImmediate 模拟宿主异步回包）。 */
const laterRef: Array<() => void> = [];
const later = (fn: () => void): void => {
  laterRef.push(fn);
  setImmediate(() => {
    const next = laterRef.shift();
    next?.();
  });
};

/** 喂给子进程 stdout 的行（模拟 app-server 响应与通知）。 */
const feed = (child: FakeSpawned, msg: unknown): void => {
  child.emitToStdout(`${JSON.stringify(msg)}\n`);
};

describe('codex fork 提取（app-server thread/fork → turn/start → 通知流）', () => {
  it('完整节拍：fork → onForkId → 回合输出聚合返回', async () => {
    const child = fakeChild((msg) => {
      if (msg.id === 1) later(() => feed(child, { id: 1, result: {} }));
      if (msg.method === 'thread/fork')
        later(() => feed(child, { id: 2, result: { thread: { id: 'fork-t1' } } }));
      if (msg.method === 'turn/start')
        later(() => {
          feed(child, { id: 3, result: { turn: { id: 'turn-1' } } });
          // fork 回合里的两条助手消息（夹杂源 thread 的通知与别的 item 类型，都不混入）
          feed(child, {
            method: 'item/completed',
            params: { threadId: 'fork-t1', turnId: 'turn-1', item: { type: 'agentMessage', text: '第一段' } },
          });
          feed(child, {
            method: 'item/completed',
            params: { threadId: 'source-t', turnId: 'turn-0', item: { type: 'agentMessage', text: '不相关的源消息' } },
          });
          feed(child, {
            method: 'item/completed',
            params: { threadId: 'fork-t1', turnId: 'turn-1', item: { type: 'reasoning', summary: [] } },
          });
          feed(child, {
            method: 'item/completed',
            params: { threadId: 'fork-t1', turnId: 'turn-1', item: { type: 'agentMessage', text: '第二段' } },
          });
          feed(child, {
            method: 'turn/completed',
            params: { threadId: 'fork-t1', turn: { id: 'turn-1', status: 'completed' } },
          });
        });
    });
    const onForkId = vi.fn();
    const extract = createCodexForkExtract({ spawnImpl: (() => child) as never });
    const result = await extract.run({ sessionId: 'source-t', prompt: '总结', onForkId });
    expect(result).toBe('第一段\n\n第二段');
    expect(onForkId).toHaveBeenCalledWith('fork-t1');
    // fork 请求带 ephemeral（不落盘）+ excludeTurns（0.167 实测硬性契约）；turn/start 的 input 是 Text 项
    const forkReq = JSON.parse(child.writes.find((w) => w.includes('thread/fork'))!) as {
      params: { threadId: string; ephemeral: boolean; excludeTurns: boolean };
    };
    expect(forkReq.params).toEqual({ threadId: 'source-t', ephemeral: true, excludeTurns: true });
    const turnReq = JSON.parse(child.writes.find((w) => w.includes('turn/start'))!) as {
      params: { threadId: string; input: Array<{ type: string; text: string }> };
    };
    expect(turnReq.params).toEqual({ threadId: 'fork-t1', input: [{ type: 'text', text: '总结' }] });
  });

  it('thread/fork 报错 → null（调用方回落上游输出）', async () => {
    const child = fakeChild((msg) => {
      if (msg.id === 1) later(() => feed(child, { id: 1, result: {} }));
      if (msg.method === 'thread/fork')
        later(() => feed(child, { id: 2, error: { message: 'rollout not found' } }));
    });
    const extract = createCodexForkExtract({ spawnImpl: (() => child) as never });
    const result = await extract.run({ sessionId: 'nope', prompt: 'x', onForkId: vi.fn() });
    expect(result).toBeNull();
  });

  it('回合 interrupted → null（半截输出不可靠，不凑合）', async () => {
    const child = fakeChild((msg) => {
      if (msg.id === 1) later(() => feed(child, { id: 1, result: {} }));
      if (msg.method === 'thread/fork')
        later(() => feed(child, { id: 2, result: { thread: { id: 'fork-t1' } } }));
      if (msg.method === 'turn/start')
        later(() => {
          feed(child, { id: 3, result: { turn: { id: 'turn-1' } } });
          feed(child, {
            method: 'item/completed',
            params: { threadId: 'fork-t1', turnId: 'turn-1', item: { type: 'agentMessage', text: '半截' } },
          });
          feed(child, {
            method: 'turn/completed',
            params: { threadId: 'fork-t1', turn: { status: 'interrupted' } },
          });
        });
    });
    const extract = createCodexForkExtract({ spawnImpl: (() => child) as never });
    const result = await extract.run({ sessionId: 'source-t', prompt: 'x', onForkId: vi.fn() });
    expect(result).toBeNull();
  });

  it('超时 → null（不等挂死的回合）', async () => {
    const child = fakeChild();
    const extract = createCodexForkExtract({ spawnImpl: (() => child) as never, timeoutMs: 5 });
    const result = await extract.run({ sessionId: 'source-t', prompt: 'x', onForkId: vi.fn() });
    expect(result).toBeNull();
  }, 1_000);
});
