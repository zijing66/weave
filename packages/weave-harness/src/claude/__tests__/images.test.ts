import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_ATTACH } from '../messaging.js';
import { CLAUDE_IMAGES } from '../images.js';

const img = (path: string, name = 'a.png') => ({ path, mediaType: 'image/png', name });

describe('CLAUDE_ATTACH.composePrompt', () => {
  it('图引用 = 裸绝对路径、每张一行，落在用户原文之后', () => {
    expect(
      CLAUDE_ATTACH.composePrompt('看看这个', [img('D:/up/aa.png'), img('D:/up/bb.png')]),
    ).toBe('看看这个\n\nD:/up/aa.png\nD:/up/bb.png');
  });

  it('纯图发送（无原文）= 只有路径', () => {
    expect(CLAUDE_ATTACH.composePrompt('', [img('D:/up/aa.png')])).toBe('D:/up/aa.png');
  });

  it('用户原文不得被改写（回执比对靠包含匹配）', () => {
    const text = '第一行\n第二行  带  空格';
    const out = CLAUDE_ATTACH.composePrompt(text, [img('D:/up/aa.png')]);
    expect(out.startsWith(text)).toBe(true);
  });

  it('不加任何解释性文字（粘贴处理器按路径行认图，多余文字会混进 prompt）', () => {
    const out = CLAUDE_ATTACH.composePrompt('hi', [img('D:/up/aa.png')]);
    expect(out).not.toMatch(/image|图片|attach/i);
  });

  it('普通文件同一种形状（宿主没有文件附件形态，路径由模型自己 Read）', () => {
    expect(
      CLAUDE_ATTACH.composePrompt('读一下', [
        { path: 'D:/up/notes.md', mediaType: 'text/markdown', name: 'notes.md' },
      ]),
    ).toBe('读一下\n\nD:/up/notes.md');
    expect(CLAUDE_ATTACH.kinds).toEqual(['image', 'file']);
  });
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-images-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (lines: unknown[]): string => {
  const path = join(dir, 'sess.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
  return path;
};

const userEntry = (parts: unknown[], ts?: string) => ({
  type: 'user',
  ...(ts ? { timestamp: ts } : {}),
  message: { content: parts },
});

const imgPart = (b64: string, mediaType = 'image/png') => ({
  type: 'image',
  source: { type: 'base64', media_type: mediaType, data: b64 },
});

const textPart = (t: string) => ({ type: 'text', text: t });

describe('CLAUDE_IMAGES.sessionImages', () => {
  it('带图的 user 消息按时间序给出：正文（含占位记号）与图字节', async () => {
    const path = write([
      userEntry(
        [textPart('看看这个 [Image #1]'), imgPart(Buffer.from('one').toString('base64'))],
        '2026-10-21T01:00:00.000Z',
      ),
      userEntry([textPart('纯文字')]),
      userEntry([imgPart(Buffer.from('two').toString('base64'), 'image/jpeg')], '2026-10-21T01:02:00.000Z'),
    ]);
    const sets = await CLAUDE_IMAGES.sessionImages({ sessionId: 's', transcriptPath: path });
    expect(sets).toHaveLength(2);
    expect(sets![0]!.text).toBe('看看这个 [Image #1]');
    expect(sets![0]!.at).toBe('2026-10-21T01:00:00.000Z');
    expect(Buffer.from(sets![0]!.images[0]!.bytes).toString()).toBe('one');
    expect(sets![0]!.images[0]!.mediaType).toBe('image/png');
    // 纯图消息：正文空串、时刻还在（server 按时间兜底匹配）
    expect(sets![1]!.text).toBe('');
    expect(sets![1]!.at).toBe('2026-10-21T01:02:00.000Z');
    expect(sets![1]!.images[0]!.mediaType).toBe('image/jpeg');
  });

  it('工具结果里的图、不认的媒体类型、assistant 条目都不算', async () => {
    const path = write([
      // 工具结果的回执也是 user 条目，但带 toolUseResult
      {
        type: 'user',
        toolUseResult: { ok: true },
        message: { content: [imgPart(Buffer.from('tool').toString('base64'))] },
      },
      // 顶层不带 image 块：工具结果包一层 tool_result，里面的图不搬
      userEntry([{ type: 'tool_result', content: [imgPart(Buffer.from('nested').toString('base64'))] }]),
      // bmp 不在 uploads 的四种类型里
      userEntry([imgPart(Buffer.from('bmp').toString('base64'), 'image/bmp')]),
      { type: 'assistant', message: { content: [imgPart(Buffer.from('asst').toString('base64'))] } },
      userEntry([imgPart(Buffer.from('keep').toString('base64'))]),
    ]);
    const sets = await CLAUDE_IMAGES.sessionImages({ sessionId: 's', transcriptPath: path });
    expect(sets).toHaveLength(1);
    expect(Buffer.from(sets![0]!.images[0]!.bytes).toString()).toBe('keep');
  });

  it('无转录路径 / 文件不存在 → null（不猜）', async () => {
    expect(await CLAUDE_IMAGES.sessionImages({ sessionId: 's', transcriptPath: null })).toBeNull();
    expect(
      await CLAUDE_IMAGES.sessionImages({ sessionId: 's', transcriptPath: join(dir, 'missing.jsonl') }),
    ).toBeNull();
  });
});
