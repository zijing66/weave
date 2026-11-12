import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n/I18nProvider';
import { ToastProvider } from '@/components/Toast';
import type { HandbookEntryView } from '@/lib/api';
import { HandbookPanel } from '../HomeConsole';

/**
 * 手法库面（G6 批6，统一控制台第四 tab）：条目行（source 徽章/剪枝按钮/
 * 点击展开正文）、坏文件如实分账、learn 表单词表闸、空态如实说明。数据走
 * rpg-handbook query（setQueryData 预置——面板自带拉取但测试不真发请求）。
 */

function render(entries: HandbookEntryView[] | null, broken: string[] = []): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (entries != null) qc.setQueryData(['rpg-handbook'], { entries, broken });
  return renderToString(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <I18nProvider>
          <HandbookPanel />
        </I18nProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('手法库面（G6 批6）', () => {
  const entry = (over: Partial<HandbookEntryView> = {}): HandbookEntryView => ({
    name: 'retry-then-flush',
    description: '先探活再入队',
    source: 'coordinator',
    createdAt: '2026-11-11T00:00:00Z',
    body: '判死（pidAliveOf===false）不入队——[[queued-command-flush]] 同拍处理',
    ...over,
  });

  it('条目行：name + 一句话 + source 徽章 + 剪枝；learn 表单三件齐', () => {
    const html = render([entry()]);
    expect(html).toContain('retry-then-flush');
    expect(html).toContain('先探活再入队');
    expect(html).toContain('>coordinator</span>');
    expect(html).toContain('>剪枝<');
    expect(html).toContain('落手法');
    expect(html).toContain('手法名（kebab');
  });

  it('坏文件如实列出不伪造；空库空态说明', () => {
    const html = render([], ['garbled.md']);
    expect(html).toContain('garbled.md');
    expect(html).toContain('解析不了');
    const empty = render([]);
    expect(empty).toContain('还空着');
    expect(empty).not.toContain('>剪枝<');
  });

  it('source 缺席行摆 — 占位（分身钉账格同形）', () => {
    const html = render([entry({ name: 'legacy', source: null })]);
    expect(html).toContain('legacy');
    expect(html).toContain('>—</span>');
  });
});
