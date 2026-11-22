import { describe, expect, it } from 'vitest';
import { TerminalGateway } from '../session-gateway.js';
import { HeadlessTerminal } from '../../headless-terminal.js';
import type { RuntimeSupervisor } from '../../supervisor.js';
import type { TerminalAttachRequest } from '../../protocol.js';

/** 最小假 supervisor：只回答 replayAfter / listInstances（Gateway 其余面不参与本测）。 */
function fakeSupervisor(
  entries: Array<{ kind: 'output' | 'resize'; sequence: number; data?: string; cols?: number; rows?: number }>,
  replayError?: Error,
  liveIds: string[] = ['wvi-test'],
) {
  const calls: number[] = [];
  let onEvent: ((frame: { type: string; instanceId: string; sequence: number; data: string }) => void) | null = null;
  const sup = {
    onEvent: (cb: typeof onEvent) => { onEvent = cb; },
    emit: (frame: { type: string; instanceId: string; sequence: number; data: string }) => onEvent?.(frame),
    listInstances: async () => liveIds.map((id) => ({ id, status: 'running' as const, lastSequence: 0 })),
    replayAfter: async (_id: string, after: number) => {
      calls.push(after);
      if (replayError) throw replayError;
      return entries;
    },
  };
  return { sup: sup as unknown as RuntimeSupervisor, calls, emit: sup.emit };
}

function attachOnce(gateway: TerminalGateway, req: Partial<TerminalAttachRequest> & { clientId: string }) {
  const frames: string[] = [];
  gateway.attach((text) => {
    frames.push(text);
    return true;
  }, {
    instanceId: 'wvi-test',
    mode: 'readonly',
    cols: 80,
    rows: 24,
    ...req,
  } as TerminalAttachRequest & { clientId: string });
  return frames;
}

describe('TerminalGateway attach 重放', () => {
  it('首次接入（无 lastSequence）从 0 重放 Host ring——黑屏根因的回归', async () => {
    const { sup, calls } = fakeSupervisor([{ kind: 'output', sequence: 7, data: 'Hello' }]);
    const gateway = new TerminalGateway(sup);
    const frames = attachOnce(gateway, { clientId: 'c1' });
    await new Promise((r) => setTimeout(r, 10));
    expect(frames.some((f) => f.includes('"type":"attached"'))).toBe(true);
    expect(calls).toEqual([0]);
    expect(frames.some((f) => f.includes('"type":"terminal.output"') && f.includes('"sequence":7'))).toBe(true);
  });

  it('旧 Host 不支持 replay 时明确标注协议不兼容，而不是普通输出缺口', async () => {
    const { sup } = fakeSupervisor([], new Error('unknown request type "instance.replay"'));
    const frames = attachOnce(new TerminalGateway(sup), { clientId: 'old-host' });
    await new Promise((r) => setTimeout(r, 10));
    expect(frames.some((f) => JSON.parse(f).reason === 'replay-unsupported')).toBe(true);
  });

  it('Host 真正不可达时不误称旧版协议', async () => {
    const { sup } = fakeSupervisor([], new Error('runtime host not connected'));
    const frames = attachOnce(new TerminalGateway(sup), { clientId: 'offline-host' });
    await new Promise((r) => setTimeout(r, 10));
    expect(frames.some((f) => JSON.parse(f).reason === 'replay-unsupported')).toBe(false);
  });

  it('daemon 短窗为空的重连仍向 Host 补拉', async () => {
    const { sup, calls } = fakeSupervisor([{ kind: 'output', sequence: 4, data: 'next' }]);
    const gateway = new TerminalGateway(sup);
    const frames = attachOnce(gateway, { clientId: 'c2', lastSequence: 3 });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([3]);
    expect(frames.some((f) => f.includes('"sequence":4') && f.includes('next'))).toBe(true);
    expect(frames.filter((f) => f.includes('"type":"attached"'))).toHaveLength(1);
  });

  it('Host 重放完成前的实时输出排在历史后且不重复', async () => {
    let resolveReplay!: (value: Array<{ kind: 'output'; sequence: number; data: string }>) => void;
    let onEvent: ((frame: { type: string; instanceId: string; sequence: number; data: string }) => void) | null = null;
    const replay = new Promise<Array<{ kind: 'output'; sequence: number; data: string }>>((resolve) => {
      resolveReplay = resolve;
    });
    const sup = {
      onEvent: (cb: typeof onEvent) => { onEvent = cb; },
      replayAfter: () => replay,
    } as unknown as RuntimeSupervisor;
    const gateway = new TerminalGateway(sup);
    gateway.start();
    const frames = attachOnce(gateway, { clientId: 'ordered' });
    onEvent?.({ type: 'terminal.output', instanceId: 'wvi-test', sequence: 2, data: 'live' });
    resolveReplay([{ kind: 'output', sequence: 1, data: 'history' }]);
    await new Promise((r) => setTimeout(r, 10));
    const output = frames.filter((f) => f.includes('"type":"terminal.output"'));
    expect(output.map((f) => JSON.parse(f).sequence)).toEqual([1, 2]);
  });
});

describe('TerminalGateway 实例终态（恢复向导的判据面）', () => {
  it('tailText 拼 ring 尾部原始输出（读屏判据的供给面）', async () => {
    const { sup, emit } = fakeSupervisor([]);
    const gateway = new TerminalGateway(sup);
    gateway.start();
    attachOnce(gateway, { clientId: 't1' });
    emit({ type: 'terminal.output', instanceId: 'wvi-test', sequence: 1, data: 'first\r\n' });
    emit({ type: 'terminal.output', instanceId: 'wvi-test', sequence: 2, data: 'second' });
    await new Promise((r) => setTimeout(r, 10));
    expect(gateway.tailText('wvi-test')).toBe('first\r\nsecond');
    expect(gateway.tailText('wvi-unknown')).toBeNull();
  });

  it('tailText 跳过 resize 帧只取 output', async () => {
    const { sup, emit } = fakeSupervisor([]);
    const gateway = new TerminalGateway(sup);
    gateway.start();
    emit({ type: 'terminal.resize', instanceId: 'wvi-test', sequence: 1, cols: 80, rows: 24 } as never);
    emit({ type: 'terminal.output', instanceId: 'wvi-test', sequence: 2, data: 'text' });
    await new Promise((r) => setTimeout(r, 10));
    expect(gateway.tailText('wvi-test')).toBe('text');
  });

  it('HeadlessTerminal.getPaneText 剥 ANSI、CR 归一（外部 capture-pane 同口径）', async () => {
    const { sup, emit } = fakeSupervisor([]);
    const gateway = new TerminalGateway(sup);
    gateway.start();
    const term = new HeadlessTerminal(sup as never, { get: () => null } as never, gateway);
    emit({ type: 'terminal.output', instanceId: 'wvi-test', sequence: 1, data: '❯ \x1b[32mok\x1b[0m\r\n· done' });
    await new Promise((r) => setTimeout(r, 10));
    expect(await term.getPaneText('wvi-test')).toBe('❯ ok\n· done');
  });

  it('ring 空（daemon 刚重启/无输出）→ getPaneText null，判据侧不动作', async () => {
    const { sup } = fakeSupervisor([]);
    const gateway = new TerminalGateway(sup);
    const term = new HeadlessTerminal(sup as never, { get: () => null } as never, gateway);
    expect(await term.getPaneText('wvi-test')).toBeNull();
  });
  it('attach 时 Host 已不报该实例 → 回致命 error，不装「已连接」', async () => {
    const { sup } = fakeSupervisor([], undefined, []);
    const frames = attachOnce(new TerminalGateway(sup), { clientId: 'late' });
    await new Promise((r) => setTimeout(r, 10));
    const fatal = frames.map((f) => JSON.parse(f) as { type: string; fatal?: boolean; error?: string }).find((f) => f.type === 'error');
    expect(fatal?.fatal).toBe(true);
    expect(fatal?.error).toBe('instance not found');
    expect(frames.some((f) => f.includes('"type":"attached"'))).toBe(false);
  });

  it('instance.exited 广播到客户端（前端转终态停重连）', async () => {
    const { sup, emit } = fakeSupervisor([]);
    const gateway = new TerminalGateway(sup);
    gateway.start();
    const frames = attachOnce(gateway, { clientId: 'c9' });
    await new Promise((r) => setTimeout(r, 10));
    emit({ type: 'instance.exited', instanceId: 'wvi-test', sequence: 0, data: '' } as never);
    expect(frames.some((f) => f.includes('"type":"instance.exited"'))).toBe(true);
  });
});
