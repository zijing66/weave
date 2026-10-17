import { describe, it, expect } from 'vitest';
import { CLAUDE_IMAGE_ATTACH } from '../messaging.js';

const img = (path: string, name = 'a.png') => ({ path, mediaType: 'image/png', name });

describe('CLAUDE_IMAGE_ATTACH.composePrompt', () => {
  it('图引用 = 裸绝对路径、每张一行，落在用户原文之后', () => {
    expect(
      CLAUDE_IMAGE_ATTACH.composePrompt('看看这个', [img('D:/up/aa.png'), img('D:/up/bb.png')]),
    ).toBe('看看这个\n\nD:/up/aa.png\nD:/up/bb.png');
  });

  it('纯图发送（无原文）= 只有路径', () => {
    expect(CLAUDE_IMAGE_ATTACH.composePrompt('', [img('D:/up/aa.png')])).toBe('D:/up/aa.png');
  });

  it('用户原文不得被改写（回执比对靠包含匹配）', () => {
    const text = '第一行\n第二行  带  空格';
    const out = CLAUDE_IMAGE_ATTACH.composePrompt(text, [img('D:/up/aa.png')]);
    expect(out.startsWith(text)).toBe(true);
  });

  it('不加任何解释性文字（粘贴处理器按路径行认图，多余文字会混进 prompt）', () => {
    const out = CLAUDE_IMAGE_ATTACH.composePrompt('hi', [img('D:/up/aa.png')]);
    expect(out).not.toMatch(/image|图片|attach/i);
  });
});
