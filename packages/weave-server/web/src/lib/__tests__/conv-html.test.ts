import { describe, it, expect } from 'vitest';
import { conversationHtml, htmlFileName } from '../conv-html';

const labels = { user: '我', assistant: '会话', plan: '计划' };
const at = '2026-10-22T04:00:00.000Z';

describe('conversationHtml', () => {
  it('单页骨架：DOCTYPE / 标题 / 样式内联，不引用任何外部资源', () => {
    const html = conversationHtml([{ role: 'assistant', at, text: '嗨' }], {
      title: '会话 A',
      labels,
      exportedAt: new Date(at),
    });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>会话 A');
    expect(html).toContain('<style>');
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/<script[^>]*src=/);
  });

  it('正文里的 HTML 一律转义（模型输出不能当标记用）', () => {
    const html = conversationHtml(
      [{ role: 'assistant', at, text: '<script>alert(1)</script> 与 <img onerror=x>' }],
      { title: 't', labels },
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img onerror=x&gt;');
  });

  it('markdown 块：标题 / 列表 / 代码 / 表格 / 真链接', () => {
    const text = [
      '## 标题',
      '',
      '- 甲',
      '- 乙',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '[文档](https://a.b/c)',
    ].join('\n');
    const html = conversationHtml([{ role: 'assistant', at, text }], { title: 't', labels });
    expect(html).toContain('<h2>标题</h2>');
    expect(html).toContain('<li>甲</li>');
    expect(html).toContain('<pre><code class="language-ts">const a = 1;</code></pre>');
    expect(html).toContain('<table><thead>');
    expect(html).toContain('<a href="https://a.b/c"');
  });

  it('javascript: 链接降成纯文本，不出 <a>', () => {
    const html = conversationHtml([{ role: 'assistant', at, text: '[点我](javascript:alert(1))' }], {
      title: 't',
      labels,
    });
    expect(html).not.toContain('href="javascript:');
  });

  it('自定义头原样插在 </head> 前；没给就不插', () => {
    const head = '<style>body{background:#000}</style><div id="mag"></div><script>1+1</script>';
    const withHead = conversationHtml([{ role: 'assistant', at, text: 'x' }], {
      title: 't',
      labels,
      head,
    });
    expect(withHead).toContain(head);
    expect(withHead.indexOf(head)).toBeLessThan(withHead.indexOf('</head>'));

    const without = conversationHtml([{ role: 'assistant', at, text: 'x' }], { title: 't', labels });
    expect(without).not.toContain('<script>');
  });

  it('图片内联 data URL；取不到就给占位文本（不摆裂图），普通文件只列文件名', () => {
    const assets = new Map([['img1', 'data:image/png;base64,AAA']]);
    const html = conversationHtml(
      [
        {
          role: 'user',
          at,
          text: '看',
          attachments: [
            { id: 'img1', name: 'a.png', mediaType: 'image/png' },
            { id: 'img2', name: 'b.png', mediaType: 'image/png' },
            { id: 'doc1', name: 'r.pdf', mediaType: 'application/pdf' },
          ],
        },
      ],
      { title: 't', labels, assets },
    );
    expect(html).toContain('src="data:image/png;base64,AAA"');
    expect(html).toContain('alt="a.png"');
    expect(html).toContain('[Image #2] b.png');
    expect(html).toContain('[File] r.pdf');
  });

  it('mermaid：有 SVG 就内联，没有回落成代码块', () => {
    const text = '```mermaid\nflowchart LR\n A-->B\n```';
    const diagrams = new Map([['flowchart LR\n A-->B', '<svg id="x"></svg>']]);
    const withSvg = conversationHtml([{ role: 'assistant', at, text }], {
      title: 't',
      labels,
      diagrams,
    });
    expect(withSvg).toContain('<figure class="diagram"><svg id="x"></svg></figure>');

    const without = conversationHtml([{ role: 'assistant', at, text }], { title: 't', labels });
    expect(without).toContain('<pre><code class="language-mermaid">');
  });

  it('压缩分隔不进导出；角色、计划 tag 保留', () => {
    const html = conversationHtml(
      [
        { role: 'compaction', at, text: '' },
        { role: 'user', at, text: '问' },
        { role: 'assistant', at, text: '答', plan: true },
      ],
      { title: 't', labels },
    );
    expect(html).not.toContain('compaction');
    expect(html).toContain('class="msg from-user"');
    expect(html).toContain('计划');
  });
});

describe('htmlFileName', () => {
  it('<label>-<时间>.html，非法字符换掉（无 weave 前缀）', () => {
    expect(htmlFileName('会话/A', new Date(2026, 9, 22, 4, 5, 6))).toBe(
      '会话-A-20261022-040506.html',
    );
  });
});
