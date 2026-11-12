import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n/I18nProvider';
import { ToastProvider } from '@/components/Toast';
import { GoalDetailCard } from '../goals';

/**
 * 任务卡详情卡（G6 批7，GoalsPanel 行点开的三 tab）：现场/时间线/生长三枚
 * tab、决策与合并梯行渲染、空态如实。查询数据 setQueryData 预置（卡片自带
 * 拉取但测试不真发请求）。
 */

function render(detail: object | null, crops: object | null): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (detail != null) qc.setQueryData(['rpg-goal-detail', 7], detail);
  if (crops != null) qc.setQueryData(['rpg-goal-detail-crops', 3], crops);
  return renderToString(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <I18nProvider>
          <GoalDetailCard goalId={7} roleId={3} />
        </I18nProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('任务卡详情卡三 tab（G6 批7）', () => {
  const detail = {
    goal: { id: 7, roleId: 3, title: '让播种可用', terminal: 'x', status: 'active' },
    expeditions: [
      { id: 11, roleId: 3, projectId: 1, sessionKey: 's-1', branch: 'weave/session-a', anchorBranch: 'main', anchorSha: 'aaaa', status: 'active', title: null, note: null, createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z' },
    ],
    decisions: [
      { id: 21, projectId: null, sessionId: null, action: 'budget-renew', level: 2, basis: 'value', input: '{"goalId":7}', result: 'pending', source: null, detail: '预算耗尽呈批', overturned: 0, at: '2026-11-11T01:00:00Z' },
    ],
    ladder: [
      { id: 31, expedition: 11, projectId: 1, fromBranch: 'weave/session-a', intoBranch: 'main', layer: 'rerere', outcome: 'ok', signature: 's', reason: '先例复用', at: '2026-11-11T02:00:00Z' },
    ],
  };

  it('默认现场 tab：出征行 + 三 tab 按钮齐（时间线/生长内容不预载显示）', () => {
    const html = render(detail, null);
    expect(html).toContain('>现场<');
    expect(html).toContain('>时间线<');
    expect(html).toContain('>生长<');
    expect(html).toContain('weave/session-a');
    expect(html).not.toContain('预算耗尽呈批');
  });

  it('空详情（查询未回）不炸、空态如实（无出征如实说明）', () => {
    const html = render(null, null);
    expect(html).toContain('还没有出征');
  });
});
