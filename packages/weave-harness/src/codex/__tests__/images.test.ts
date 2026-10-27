import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_IMAGES } from '../images.js';

/**
 * rollout 形状（0.164 serde 实证）：`event_msg` → `payload.type = "item_completed"`
 * → `item.type = "UserMessage"`（TurnItem tag 无 rename）→ `content[]` 里
 * `{type:'text', text}` / `{type:'image', image_url:'data:...;base64,...'}`
 * （`UserInput::Image` + untagged `ImageReference::Inline`）。
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-codex-images-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (lines: unknown[]): string => {
  const path = join(dir, 'rollout.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
  return path;
};

const itemCompleted = (item: unknown, ts?: string) => ({
  type: 'event_msg',
  ...(ts ? { timestamp: ts } : {}),
  payload: { type: 'item_completed', item },
});

const userMessage = (content: unknown[]) => ({ type: 'UserMessage', id: 'u1', content });

const textPart = (t: string) => ({ type: 'text', text: t });

const imgPart = (b64: string, mediaType = 'image/png') => ({
  type: 'image',
  image_url: `data:${mediaType};base64,${b64}`,
});

describe('CODEX_IMAGES.sessionImages', () => {
  it('带图的 UserMessage 按时间序给出：正文（含占位记号）与图字节', async () => {
    const path = write([
      itemCompleted(
        userMessage([textPart('看看这个 [Image #1]'), imgPart(Buffer.from('one').toString('base64'))]),
        '2026-10-26T01:00:00.000Z',
      ),
      itemCompleted(userMessage([textPart('纯文字')])),
      itemCompleted(
        userMessage([imgPart(Buffer.from('two').toString('base64'), 'image/jpeg')]),
        '2026-10-26T01:02:00.000Z',
      ),
    ]);
    const sets = await CODEX_IMAGES.sessionImages({ sessionId: 's', transcriptPath: path });
    expect(sets).toHaveLength(2);
    expect(sets![0]!.text).toBe('看看这个 [Image #1]');
    expect(sets![0]!.at).toBe('2026-10-26T01:00:00.000Z');
    expect(Buffer.from(sets![0]!.images[0]!.bytes).toString()).toBe('one');
    expect(sets![0]!.images[0]!.mediaType).toBe('image/png');
    // 纯图消息：正文空串、时刻还在（server 按时间兜底匹配）
    expect(sets![1]!.text).toBe('');
    expect(sets![1]!.at).toBe('2026-10-26T01:02:00.000Z');
    expect(sets![1]!.images[0]!.mediaType).toBe('image/jpeg');
  });

  it('工具回执里的图（function_call_output）、不认的类型、非 UserMessage 条目都不算', async () => {
    const path = write([
      // view_image 等工具的回执：response_item 的 function_call_output，不是人贴的
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          output: [{ type: 'input_image', image_url: `data:image/png;base64,${Buffer.from('tool').toString('base64')}` }],
        },
      },
      // bmp 不在 uploads 的四种类型里
      itemCompleted(userMessage([imgPart(Buffer.from('bmp').toString('base64'), 'image/bmp')])),
      // AgentMessage 里的图不算
      itemCompleted({ type: 'AgentMessage', content: [imgPart(Buffer.from('asst').toString('base64'))] }),
      itemCompleted(userMessage([imgPart(Buffer.from('keep').toString('base64'))])),
    ]);
    const sets = await CODEX_IMAGES.sessionImages({ sessionId: 's', transcriptPath: path });
    expect(sets).toHaveLength(1);
    expect(Buffer.from(sets![0]!.images[0]!.bytes).toString()).toBe('keep');
  });

  it('无转录路径 / 文件不存在 → null（不猜）', async () => {
    expect(await CODEX_IMAGES.sessionImages({ sessionId: 's', transcriptPath: null })).toBeNull();
    expect(
      await CODEX_IMAGES.sessionImages({ sessionId: 's', transcriptPath: join(dir, 'missing.jsonl') }),
    ).toBeNull();
  });
});
