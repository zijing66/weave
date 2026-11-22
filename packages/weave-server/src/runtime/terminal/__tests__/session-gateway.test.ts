import { describe, expect, it } from 'vitest';
import { TerminalGateway } from '../session-gateway.js';
import type { RuntimeSupervisor } from '../../supervisor.js';
import type { TerminalAttachRequest } from '../../protocol.js';

/** 最小假 supervisor：只回答 replayAfter（Gateway 其余面不参与本测）。 */
function fakeSupervisor(entries: Array<{ kind: 'output'; sequence: number; data: string }>) {
  const calls: number[] = [];
  const sup = {
    replayAfter: async (_id: string, after: number) => {
      calls.push(after);
      return entries;
    },
  };
  return { sup: sup as unknown as RuntimeSupervisor, calls };
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
    const { sup, calls } = fakeSupervisor([{ kind: 'output', sequence: 7, data: 'SGVsbG8=' }]);
    const gateway = new TerminalGateway(sup);
    const frames = attachOnce(gateway, { clientId: 'c1' });
    expect(frames.some((f) => f.includes('"type":"attached"'))).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([0]);
    expect(frames.some((f) => f.includes('"type":"terminal.output"') && f.includes('"sequence":7'))).toBe(true);
  });

  it('带 lastSequence 的重连不整段重放（只补缺口）', async () => {
    const { sup, calls } = fakeSupervisor([]);
    const gateway = new TerminalGateway(sup);
    const frames = attachOnce(gateway, { clientId: 'c2', lastSequence: 3 });
    await new Promise((r) => setTimeout(r, 10));
    // 本地短窗为空且无更早缺口 → 不找 Host 要任何东西
    expect(calls).toEqual([]);
    expect(frames.filter((f) => f.includes('"type":"attached"'))).toHaveLength(1);
  });
});
