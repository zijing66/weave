import { describe, expect, it } from 'vitest';
import { CODEX_ATTACH } from '../messaging.js';

const file = (path: string, name = 'a.md') => ({ path, mediaType: 'text/markdown', name });

describe('CODEX_ATTACH.composePrompt', () => {
  it('路径一行一条追加在原文之后', () => {
    expect(CODEX_ATTACH.composePrompt('读一下', [file('D:/up/a.md'), file('D:/up/b.md')])).toBe(
      '读一下\n\nD:/up/a.md\nD:/up/b.md',
    );
  });

  it('纯附件发送（无原文）= 只有路径', () => {
    expect(CODEX_ATTACH.composePrompt('', [file('D:/up/a.md')])).toBe('D:/up/a.md');
  });

  it('原文已含某附件路径（占位胶囊原地展开）＝不再重复追加', () => {
    expect(CODEX_ATTACH.composePrompt('先读 D:/up/a.md', [file('D:/up/a.md'), file('D:/up/b.md')])).toBe(
      '先读 D:/up/a.md\n\nD:/up/b.md',
    );
  });

  it('全部附件都已内联 = 原样返回原文', () => {
    expect(CODEX_ATTACH.composePrompt('读 D:/up/a.md', [file('D:/up/a.md')])).toBe('读 D:/up/a.md');
  });
});
