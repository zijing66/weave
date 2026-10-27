import { describe, expect, it } from 'vitest';
import { CODEX_ATTACH, CODEX_MESSAGING } from '../messaging.js';

const file = (path: string, name = 'a.md') => ({ path, mediaType: 'text/markdown', name });
const image = (path: string, name = 'a.png') => ({ path, mediaType: 'image/png', name });

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

  it('图片也走路径（view_image 工具默认开启，模型拿路径自己看图）', () => {
    expect(CODEX_ATTACH.kinds).toContain('image');
    expect(CODEX_ATTACH.composePrompt('看看这张', [image('D:/up/a.png')])).toBe('看看这张\n\nD:/up/a.png');
  });
});

describe('CODEX_PATH_REF（裸相对路径文法）', () => {
  const spec = CODEX_MESSAGING.pathRefs!;

  it('expression：文件 = 裸路径、目录带尾斜杠、无行区间', () => {
    expect(spec.expression({ path: 'src/main.rs', kind: 'file' })).toBe('src/main.rs');
    expect(spec.expression({ path: 'src', kind: 'dir' })).toBe('src/');
    expect(spec.lines).toBe(false);
  });

  it('recognize：裸相对路径与目录尾斜杠', () => {
    const refs = spec.recognize('先看 src/main.rs 和 docs/plan/ 再说');
    expect(refs.map((r) => [r.path, r.kind])).toEqual([
      ['src/main.rs', 'file'],
      ['docs/plan', 'dir'],
    ]);
  });

  it('recognize：双引号形式认带空格路径（宿主补全插的形状）', () => {
    const refs = spec.recognize('看 "my file.md" 一下');
    expect(refs.map((r) => r.path)).toEqual(['my file.md']);
  });

  it('recognize：绝对路径、盘符、反斜杠的不算', () => {
    const refs = spec.recognize('看 D:\\x\\y.md 和 C:/a.md');
    expect(refs).toEqual([]);
  });

  it('recognize：普通单词与引语不当路径（须含 / 或 . 才像路径）', () => {
    const refs = spec.recognize('hello world 说 "你好呀" 一下');
    expect(refs).toEqual([]);
  });
});
