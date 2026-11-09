import { describe, it, expect } from 'vitest';
import {
  decisionAvailable,
  emptyEndpoint,
  emptyForm,
  formFromBinding,
  formToInput,
  pointAvailability,
  scopedBindingsOf,
  sessionEndpointAvailable,
  sourceKey,
  STAGE_STYLE,
  triggerKey,
  validateForm,
  type BindingFormState,
} from '../binding-model';
import type {
  ExtensionBindingRow,
  ExtensionExecutionRow,
  ExtensionHarnessCapability,
} from '@/lib/api';

/** 绑定域纯逻辑（批 3 验收三案：表单校验 / 叠加展示 / stage 着色）。 */

const binding = (over: Partial<ExtensionBindingRow> = {}): ExtensionBindingRow => ({
  id: 1,
  name: 'b',
  projectId: 1,
  sessionId: null,
  point: 'turn-end',
  when: null,
  condition: null,
  summarize: null,
  endpoints: [{ kind: 'session', target: 'self', text: 'x' }],
  enabled: true,
  createdAt: '',
  updatedAt: '',
  ...over,
});

const cap = (over: Partial<ExtensionHarnessCapability> = {}): ExtensionHarnessCapability => ({
  harness: 'claude',
  points: { 'turn-end': ['Stop'], idle: ['Stop', 'SessionEnd'] },
  endpoints: { session: true, webhook: true },
  decision: true,
  ...over,
});

// ---- 1. 表单校验 ----
describe('表单校验（validateForm）', () => {
  it('缺名称、会话端点缺 target/文案、webhook 端点坏 URL 各自报对应词条', () => {
    const base = emptyForm();
    expect(validateForm(base)).toBe('ext.errNameRequired');

    const named: BindingFormState = { ...base, name: 'b' };
    expect(validateForm(named)).toBe('ext.errSessionTargetRequired');

    const withTarget: BindingFormState = {
      ...named,
      endpoints: [{ ...named.endpoints[0]!, target: 'self' }],
    };
    expect(validateForm(withTarget)).toBe('ext.errEndpointTextRequired');

    const withText: BindingFormState = {
      ...withTarget,
      endpoints: [{ ...withTarget.endpoints[0]!, text: 'hi' }],
    };
    expect(validateForm(withText)).toBe('');

    const badUrl: BindingFormState = {
      ...named,
      endpoints: [{ ...emptyEndpoint('webhook'), url: 'not a url' }],
    };
    expect(validateForm(badUrl)).toBe('ext.errEndpointUrlRequired');
  });

  it('formToInput 保留形状：会话级带 sessionId、oneWay/secret 按需、空白 when 归 null', () => {
    const form = formFromBinding(
      binding({
        sessionId: 'sess-a',
        when: '  ',
        condition: 'did it work',
        endpoints: [
          { kind: 'session', target: 'self', text: 'go', oneWay: true },
          { kind: 'webhook', url: ' https://x.co ', secret: '' },
        ],
      }),
    );
    const input = formToInput(form, 7);
    expect(input.projectId).toBe(7);
    expect(input.sessionId).toBe('sess-a');
    expect(input.when).toBeNull();
    expect(input.condition).toBe('did it work');
    expect(input.endpoints).toEqual([
      { kind: 'session', target: 'self', text: 'go', oneWay: true },
      { kind: 'webhook', url: 'https://x.co' },
    ]);
  });
});


// ---- 2. 叠加展示 ----
describe('叠加分组（scopedBindingsOf）', () => {
  it('项目级在前、该会话的会话级在后；别的会话的会话级不出现', () => {
    const projectLevel = binding({ id: 1, sessionId: null });
    const own = binding({ id: 2, sessionId: 'sess-a' });
    const other = binding({ id: 3, sessionId: 'sess-b' });
    const g = scopedBindingsOf([other, projectLevel, own], 'sess-a');
    expect(g.project.map((b) => b.id)).toEqual([1]);
    expect(g.session.map((b) => b.id)).toEqual([2]);
  });
});

// ---- 3. stage 着色 ----
describe('stage 着色（STAGE_STYLE）', () => {
  it('八阶段全表覆盖，色带语义：delivered 绿 / failed 红 / 闸拦下琥珀 / 跳过灰', () => {
    const stages: ExtensionExecutionRow['stage'][] = [
      'delivered',
      'failed',
      'when-blocked',
      'condition-blocked',
      'skipped:busy',
      'skipped:stale',
      'skipped:capped',
      'skipped:duplicate',
    ];
    for (const s of stages) expect(STAGE_STYLE[s].badge).toBeTruthy();
    expect(STAGE_STYLE.delivered.badge).toContain('emerald');
    expect(STAGE_STYLE.failed.badge).toContain('red');
    expect(STAGE_STYLE['when-blocked'].badge).toContain('amber');
    expect(STAGE_STYLE['skipped:busy'].badge).toContain('neutral');
  });

  it('source/trigger 词条映射：fork / decision-model / dry-run 各归各键，未知原样返回 null', () => {
    expect(sourceKey('fork')).toBe('ext.execWhoFork');
    expect(sourceKey('decision-model')).toBe('ext.execWhoDecision');
    expect(sourceKey('mystery')).toBeNull();
    expect(triggerKey('dry-run')).toBe('ext.execTriggerDryRun');
    expect(triggerKey('event')).toBe('ext.execTriggerEvent');
  });
});

// ---- 派生面可用性 ----
describe('派生面可用性', () => {
  it('事件表空 = 触发点置灰并给原因词条；缓存两点恒不可配', () => {
    expect(pointAvailability(cap(), 'turn-end').available).toBe(true);
    const noIdle = pointAvailability(cap({ points: { 'turn-end': ['Stop'] } }), 'idle');
    expect(noIdle.available).toBe(false);
    expect(noIdle.reason).toBe('ext.pointIdleUnavailable');
    expect(pointAvailability(null, 'tool-failed')).toEqual({
      available: false,
      reason: 'ext.pointUnsupported',
      events: [],
    });
  });

  it('无 prompt 通道 = session 端点置灰；无 fork 面 = 决策置灰', () => {
    expect(sessionEndpointAvailable(cap({ endpoints: { session: false, webhook: true } }))).toEqual({
      available: false,
      reason: 'ext.endpointSessionUnavailable',
    });
    expect(decisionAvailable(cap({ decision: false }))).toEqual({
      available: false,
      reason: 'ext.decisionUnsupported',
    });
  });
});
