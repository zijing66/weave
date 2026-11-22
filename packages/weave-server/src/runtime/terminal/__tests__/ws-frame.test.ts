import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { writeClientFrame, startReading, writeFrame } from '../ws-frame';

describe('ws-frame client masking (B5 attach)', () => {
  it('client text frames unmask back via startReading (all length tiers)', () => {
    for (const payload of ['{}', 'x'.repeat(125), 'y'.repeat(300)]) {
      const socket = new PassThrough();
      const got: string[] = [];
      startReading(
        socket,
        (text) => got.push(text),
        () => undefined,
      );
      writeClientFrame(socket, 0x1, payload);
      expect(got).toEqual([payload]);
    }
  });

  it('client close frame reaches server onClose', () => {
    const socket = new PassThrough();
    let closed = -1;
    startReading(
      socket,
      () => undefined,
      (code) => {
        closed = code;
      },
    );
    writeClientFrame(socket, 0x8, Buffer.alloc(0));
    expect(closed).toBe(1005);
  });

  it('server unmasked frames still roundtrip (writeFrame → client parse shape)', () => {
    const socket = new PassThrough();
    const got: string[] = [];
    startReading(
      socket,
      (text) => got.push(text),
      () => undefined,
    );
    writeFrame(socket, 0x1, 'ok');
    expect(got).toEqual(['ok']);
  });
});
