import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n/I18nProvider';
import { ToastProvider } from '@/components/Toast';
import type { RpgRoutingDecisionView } from '@/lib/api';
import { RoutingInbox } from '../inbox';

/**
 * 决策路由信箱（G6 批1）：pending 行带批准/拒绝（执行权恒等用户）、已决行只读
 * 徽章、空态如实说明——数据零伪造（没有待批就不摆待批区）。
 */

const decision = (over: Partial<RpgRoutingDecisionView> = {}): RpgRoutingDecisionView => ({
  id: 1,
  projectId: null,
  sessionId: null,
  action: 'crop-promote',
  level: 2,
  basis: 'irreversible|value',
  input: null,
  result: 'pending',
  source: null,
  detail: null,
  overturned: 0,
  at: '2026-11-11T00:00:00Z',
  ...over,
});

function render(data: { routingDecisions: RpgRoutingDecisionView[] | null; routingStats: object | null; profile?: object | null }): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <I18nProvider>
          <RoutingInbox open onClose={() => {}} data={data as never} />
        </I18nProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('决策信箱（G6）', () => {
  it('open=false 不渲染信箱本体（HUD 不占位；Toast 容器是 provider 自带的）', () => {
    const qc = new QueryClient();
    const html = renderToString(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <I18nProvider>
            <RoutingInbox open={false} onClose={() => {}} data={{ routingDecisions: null, routingStats: null, profile: null }} />
          </I18nProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(html).not.toContain('决策信箱');
  });

  it('pending 行带批准/拒绝两枚（执行权恒等用户）+ 动作词表文案（G6 级2 八条）', () => {
    const html = render({
      routingDecisions: [decision({ id: 7, action: 'goal-change' })],
      routingStats: { total: 1, pending: 1, approved: 0, rejected: 0, allowed: 0, blocked: 0, tripped: 0, overturned: 0 },
    });
    expect(html).toContain('目标变更');
    expect(html).toContain('>批准<');
    expect(html).toContain('>拒绝<');
    // 级别徽章 L2（SSR 把字面量与表达式拆成两段文本，认注释分隔形式）
    expect(html).toMatch(/L<!-- -->2/);
  });

  it('已决行只读徽章（approved/rejected/翻案位）不带裁决按钮', () => {
    const html = render({
      routingDecisions: [
        decision({ id: 8, result: 'approved', source: 'god' }),
        decision({ id: 9, result: 'allowed', source: 'fork', action: 'patrol', level: 1, overturned: 1 }),
      ],
      routingStats: { total: 2, pending: 0, approved: 1, rejected: 0, allowed: 1, blocked: 0, tripped: 0, overturned: 1 },
    });
    expect(html).toContain('已批准');
    expect(html).toContain('放行');
    expect(html).toContain('已翻案');
    // settled 行不带裁决按钮（「已批准」徽章里的子串除外——按钮文案独立成文本节点）
    expect(html).not.toContain('>批准<');
    expect(html).not.toContain('>拒绝<');
  });

  it('空账空态如实说明 + 零伪造（stats 全零不摆统计行）', () => {
    const html = render({ routingDecisions: [], routingStats: { total: 0, pending: 0, approved: 0, rejected: 0, allowed: 0, blocked: 0, tripped: 0, overturned: 0 } });
    expect(html).toContain('没有待批');
    expect(html).not.toContain('决策轨迹');
    expect(html).not.toContain('共 ');
  });
});

describe('策略档段（G6 批5 进化闭环）', () => {
  const profileData = {
    current: { goalStallLimit: 5 },
    resolved: { goalStallLimit: 5, goalDriveCooldownMs: 90_000 },
    versions: [
      { id: 2, params: { goalStallLimit: 5 }, note: '降敏', appliedBy: 'proposal', fromDecision: 7, createdAt: '2026-11-11T00:00:00Z', isCurrent: true },
      { id: 1, params: {}, note: null, appliedBy: 'god', fromDecision: null, createdAt: '2026-11-10T00:00:00Z', isCurrent: false },
    ],
  };

  it('当前参数行 + 复盘按钮 + 版本链（当前徽章 vs 回滚按钮）', () => {
    const html = render({
      routingDecisions: [],
      routingStats: { total: 0, pending: 0, approved: 0, rejected: 0, allowed: 0, blocked: 0, tripped: 0, overturned: 0 },
      profile: profileData,
    });
    expect(html).toContain('策略档');
    expect(html).toContain('熔断拍数 5');
    expect(html).toContain('推进冷却 90s');
    // 版本链：当前版只读徽章，旧版给回滚
    expect(html).toContain('>当前<');
    expect(html).toContain('>回滚<');
    // 复盘入口常在
    expect(html).toContain('复盘提提案');
  });

  it('无档不摆（策略段只在信箱容器里——空版本链如实不摆版本区）', () => {
    const html = render({
      routingDecisions: [],
      routingStats: { total: 0, pending: 0, approved: 0, rejected: 0, allowed: 0, blocked: 0, tripped: 0, overturned: 0 },
      profile: { current: {}, resolved: { goalStallLimit: 3, goalDriveCooldownMs: 90_000 }, versions: [] },
    });
    expect(html).toContain('熔断拍数 3');
    expect(html).not.toContain('>回滚<');
  });
});
