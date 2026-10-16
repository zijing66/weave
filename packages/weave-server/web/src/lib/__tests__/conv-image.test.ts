import { describe, it, expect } from 'vitest';
import {
  IMG_WIDTH,
  imageFileName,
  layoutConversation,
  pickScale,
  wrapText,
  type ConvImageEntry,
  type Measure,
} from '../conv-image';

/** 等宽假量宽：中日韩字宽 13、其余 7（只为验证折行规则，不追求真字宽）。 */
const width = (text: string): number =>
  [...text].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e80 ? 13 : 7), 0);

const opts = {
  title: '会话 A',
  subtitle: 'proj · 导出',
  labels: { user: '我', assistant: '会话' },
  stamp: (iso: string) => `T(${iso})`,
};

describe('pickScale', () => {
  it('低画布走 2 倍、超上限降 1 倍', () => {
    expect(pickScale(IMG_WIDTH, 3000)).toBe(2);
    expect(pickScale(IMG_WIDTH, 12000)).toBe(1);
  });
});

describe('wrapText', () => {
  it('中日韩任意处可折，拉丁词整体不折', () => {
    const lines = wrapText(width, '这是一段中文说明文字', 26);
    expect(lines).toEqual(['这是', '一段', '中文', '说明', '文字']);
    const latin = wrapText(width, 'hello world foo', 40);
    expect(latin).toEqual(['hello', 'world', 'foo']);
  });

  it('单个超长串逐字硬断，不溢出', () => {
    const lines = wrapText(width, 'https://example.com/averyverylongpath', 35);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(width(l)).toBeLessThanOrEqual(35);
  });

  it('保留显式换行与空行，行首空白吃掉', () => {
    expect(wrapText(width, 'a\n\nb', 100)).toEqual(['a', '', 'b']);
    expect(wrapText(width, '  缩进', 100)).toEqual(['缩进']);
  });
});

describe('layoutConversation', () => {
  const measure: Measure = (_font, text) => width(text);
  const entries: ConvImageEntry[] = [
    { role: 'user', at: '2026-10-16T09:00:00.000Z', text: '我发的很长的消息' },
    { role: 'assistant', at: '2026-10-16T09:00:05.000Z', text: '回复' },
  ];

  it('自己发的贴右、回复贴左，恰好留出页边距', () => {
    const layout = layoutConversation(measure, entries, opts);
    const [user, assistant] = layout.bubbles;
    expect(user!.role).toBe('user');
    expect(user!.x + user!.w).toBe(IMG_WIDTH - 24);
    expect(assistant!.x).toBe(24);
    expect(layout.width).toBe(IMG_WIDTH);
  });

  it('时刻戳带角色文案；高度随条目与换行增长', () => {
    const one = layoutConversation(measure, entries.slice(0, 1), opts);
    const two = layoutConversation(measure, entries, opts);
    expect(two.height).toBeGreaterThan(one.height);
    expect(two.bubbles[0]!.meta).toContain('我');
    expect(two.bubbles[1]!.meta).toContain('会话');
    expect(two.bubbles[1]!.meta).toContain('2026-10-16T09:00:05.000Z');
    const wide = layoutConversation(measure, [entries[0]!], opts);
    const taller = layoutConversation(measure, [{ ...entries[0]!, text: entries[0]!.text.repeat(20) }], opts);
    expect(taller.height).toBeGreaterThan(wide.height);
    expect(taller.bubbles[0]!.w).toBeLessThanOrEqual(IMG_WIDTH - 48);
  });
});

describe('imageFileName', () => {
  it('剥掉路径不友好字符', () => {
    const name = imageFileName('a/b:c*d', new Date(2026, 9, 16, 9, 8, 7));
    expect(name).toBe('weave-a-b-c-d-20261016-090807.png');
  });
});
