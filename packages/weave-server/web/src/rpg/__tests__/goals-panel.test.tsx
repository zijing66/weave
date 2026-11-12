import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n/I18nProvider';
import { ToastProvider } from '@/components/Toast';
import type { RpgGoalView } from '@/lib/api';
import { GoalsPanel } from '../goals';

/**
 * 任务沙盘全局面板（G6 批4c）：goal 行渲染（状态徽章/终态条件/回合账/无进展
 * 信号）、状态动作（active 行三枚、paused/budget_out 两枚、终态行零枚）、
 * 空态如实说明——数据由调用方注入，不自带拉取。
 */

const goal = (over: Partial<RpgGoalView> = {}): RpgGoalView => ({
  id: 1,
  houseId: null,
  roleId: 3,
  projectId: null,
  title: '让播种可用',
  terminal: 'farm 端点全绿',
  budgetTurns: null,
  budgetTokens: null,
  turnsUsed: 4,
  stallStreak: 0,
  status: 'active',
  statusNote: null,
  createdAt: '2026-11-11T00:00:00Z',
  updatedAt: '2026-11-11T00:00:00Z',
  ...over,
});

const roles = [{ id: 3, name: 'gardener', projectId: 1 }];

function render(goals: RpgGoalView[] | null): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <I18nProvider>
          <GoalsPanel open onClose={() => {}} data={{ goals, roles } as never} />
        </I18nProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('任务沙盘全局面板（G6 批4c）', () => {
  it('open=false 不渲染面板本体', () => {
    const qc = new QueryClient();
    const html = renderToString(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <I18nProvider>
            <GoalsPanel open={false} onClose={() => {}} data={{ goals: null, roles } as never} />
          </I18nProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(html).not.toContain('任务沙盘');
  });

  it('goal 行：角色名 + 标题 + 终态条件 + 回合账；active 行带收官/暂停/撤销三枚', () => {
    const html = render([goal({ budgetTurns: 10, turnsUsed: 4 })]);
    expect(html).toContain('gardener');
    expect(html).toContain('让播种可用');
    expect(html).toContain('终态：');
    expect(html).toContain('farm 端点全绿');
    expect(html).toContain('回合 4/10');
    expect(html).toContain('推进中');
    expect(html).toContain('>收官<');
    expect(html).toContain('>暂停<');
    expect(html).toContain('>撤销<');
  });

  it('无进展信号如实摆（stallStreak>0）且预算尽行恢复+撤销两枚', () => {
    const html = render([
      goal({ id: 2, stallStreak: 2, status: 'paused', statusNote: '上帝手动暂停' }),
      goal({ id: 3, status: 'budget_out' }),
    ]);
    expect(html).toContain('无进展 ×2');
    expect(html).toContain('预算尽');
    expect(html).toContain('>恢复<');
    // 恢复行没有收官（先恢复才能动）
    expect(html).not.toContain('>收官<');
  });

  it('终态行（achieved/abandoned）零动作只读 + 空态如实说明', () => {
    const html = render([goal({ id: 9, status: 'achieved', statusNote: '终态命中' })]);
    expect(html).not.toContain('>撤销<');
    expect(html).not.toContain('>恢复<');
    const empty = render(null);
    expect(empty).toContain('还没有 goal');
  });
});
