import type {
  ExtensionBindingInput,
  ExtensionBindingRow,
  ExtensionEndpoint,
  ExtensionExecutionRow,
  ExtensionHarnessCapability,
  ExtensionPoint,
} from '@/lib/api';
import type { MessageKey } from '@/i18n/dict';

/**
 * 绑定域的**纯逻辑**（表单状态 / 校验 / 叠加分组 / stage 着色）——组件只渲染，
 * 这里只算数；测试直接打这层（组件测试基建不在 web，形态照 HooksPanel 的
 * 纯函数同僚：orchestration-graph、review-prompt）。
 */

// ---------------------------------------------------------------------------
// 表单状态
// ---------------------------------------------------------------------------

/** 端点行的表单形态（session/webhook 字段都留着，按 kind 各取各的）。 */
export interface EndpointForm {
  kind: 'session' | 'webhook';
  target: string;
  text: string;
  oneWay: boolean;
  url: string;
  secret: string;
}

export interface BindingFormState {
  name: string;
  /** null = 项目级；非空 = 会话级（绑这一个会话）。 */
  sessionId: string | null;
  point: ExtensionPoint;
  when: string;
  condition: string;
  summarize: string;
  endpoints: EndpointForm[];
  enabled: boolean;
}

export function emptyForm(): BindingFormState {
  return {
    name: '',
    sessionId: null,
    point: 'turn-end',
    when: '',
    condition: '',
    summarize: '',
    endpoints: [emptyEndpoint('session')],
    enabled: true,
  };
}

export function emptyEndpoint(kind: 'session' | 'webhook'): EndpointForm {
  return { kind, target: '', text: '', oneWay: false, url: '', secret: '' };
}

export function formFromBinding(binding: ExtensionBindingRow): BindingFormState {
  return {
    name: binding.name,
    sessionId: binding.sessionId,
    point: binding.point,
    when: binding.when ?? '',
    condition: binding.condition ?? '',
    summarize: binding.summarize ?? '',
    endpoints:
      binding.endpoints.length > 0 ? binding.endpoints.map(endpointFromRow) : [emptyEndpoint('session')],
    enabled: binding.enabled,
  };
}

function endpointFromRow(e: ExtensionEndpoint): EndpointForm {
  return {
    kind: e.kind,
    ...(e.kind === 'session'
      ? { target: e.target, text: e.text, oneWay: e.oneWay === true }
      : { url: e.url, secret: e.secret ?? '' }),
  } as EndpointForm;
}

/** 表单 → API 体（无项目：projectId 由调用方带上——面板锚着项目）。 */
export function formToInput(form: BindingFormState, projectId: number): ExtensionBindingInput {
  return {
    name: form.name.trim(),
    projectId,
    ...(form.sessionId ? { sessionId: form.sessionId } : { sessionId: null }),
    point: form.point,
    when: form.when.trim() || null,
    condition: form.condition.trim() || null,
    summarize: form.summarize.trim() || null,
    endpoints: form.endpoints.map(toEndpointRow),
    enabled: form.enabled,
  };
}

function toEndpointRow(e: EndpointForm): ExtensionEndpoint {
  return e.kind === 'session'
    ? {
        kind: 'session',
        target: e.target === 'self' ? 'self' : e.target,
        text: e.text,
        ...(e.oneWay ? { oneWay: true } : {}),
      }
    : {
        kind: 'webhook',
        url: e.url.trim(),
        ...(e.secret.trim() ? { secret: e.secret.trim() } : {}),
      };
}

// ---------------------------------------------------------------------------
// 校验（返回词条 key；'' = 通过）
// ---------------------------------------------------------------------------

export function validateForm(form: BindingFormState): MessageKey | '' {
  if (!form.name.trim()) return 'ext.errNameRequired';
  for (const e of form.endpoints) {
    if (e.kind === 'session') {
      if (!e.target.trim()) return 'ext.errSessionTargetRequired';
      if (!e.text.trim()) return 'ext.errEndpointTextRequired';
    } else {
      try {
        new URL(e.url.trim());
      } catch {
        return 'ext.errEndpointUrlRequired';
      }
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// 派生面（capabilities）→ 表单可用性
// ---------------------------------------------------------------------------

export interface PointAvailability {
  available: boolean;
  /** 不可用原因词条（available 时忽略）。 */
  reason: MessageKey | null;
  /** 触发它的事件名（提示文案用）。 */
  events: readonly string[];
}

/** 触发点可用性按派生面答：点缺席/事件表空 = 置灰并说明原因。 */
export function pointAvailability(
  cap: ExtensionHarnessCapability | null,
  point: ExtensionPoint,
): PointAvailability {
  if (point === 'tool-failed' || point === 'session-end') {
    // 引擎缓做的两点：恒不可配（如实置灰，不摆空壳）。
    return { available: false, reason: 'ext.pointUnsupported', events: [] };
  }
  const events = cap?.points?.[point] ?? [];
  if (events.length === 0) {
    return {
      available: false,
      reason: point === 'turn-end' ? 'ext.pointTurnEndUnavailable' : 'ext.pointIdleUnavailable',
      events: [],
    };
  }
  return { available: true, reason: null, events };
}

/** session 端点可用性：无 prompt 通道 = 投不出去（置灰 + 原因）。 */
export function sessionEndpointAvailable(
  cap: ExtensionHarnessCapability | null,
): { available: boolean; reason: MessageKey | null } {
  return {
    available: cap?.endpoints.session ?? true,
    reason: cap?.endpoints.session === false ? 'ext.endpointSessionUnavailable' : null,
  };
}

/** 决策（condition/summarize）可用性：无 fork 提取面 = 置灰 + 原因。 */
export function decisionAvailable(
  cap: ExtensionHarnessCapability | null,
): { available: boolean; reason: MessageKey | null } {
  return {
    available: cap?.decision ?? true,
    reason: cap?.decision === false ? 'ext.decisionUnsupported' : null,
  };
}

// ---------------------------------------------------------------------------
// 叠加展示（会话详情：项目级 + 会话级各自独立，互不抑制）
// ---------------------------------------------------------------------------

export interface ScopedBindingGroup {
  /** 项目级绑定（sessionId=null）。 */
  project: ExtensionBindingRow[];
  /** 该会话的会话级绑定。 */
  session: ExtensionBindingRow[];
}

/** 叠加分组：项目级在前、会话级在后（渲染顺序即生效次序的可视化）。 */
export function scopedBindingsOf(
  bindings: readonly ExtensionBindingRow[],
  sessionId: string,
): ScopedBindingGroup {
  const project: ExtensionBindingRow[] = [];
  const session: ExtensionBindingRow[] = [];
  for (const b of bindings) {
    if (b.sessionId === null) project.push(b);
    else if (b.sessionId === sessionId) session.push(b);
  }
  return { project, session };
}

// ---------------------------------------------------------------------------
// stage 着色（执行日志行）
// ---------------------------------------------------------------------------

/** stage → 徽标配色（tailwind 类）与文案词条。着色语义：绿 = 投出去了，红 = 失败，
 *  琥珀 = 被闸拦下（预筛/条件），灰 = 跳过（忙/过期/频次/重复）。 */
export const STAGE_STYLE: Record<ExtensionExecutionRow['stage'], { badge: string; key: MessageKey }> = {
  delivered: { badge: 'bg-emerald-900/40 text-emerald-300', key: 'ext.stageDelivered' },
  failed: { badge: 'bg-red-900/40 text-red-300', key: 'ext.stageFailed' },
  'when-blocked': { badge: 'bg-amber-900/40 text-amber-300', key: 'ext.stageWhenBlocked' },
  'condition-blocked': { badge: 'bg-amber-900/40 text-amber-300', key: 'ext.stageConditionBlocked' },
  'skipped:busy': { badge: 'bg-neutral-800 text-neutral-400', key: 'ext.stageSkippedBusy' },
  'skipped:stale': { badge: 'bg-neutral-800 text-neutral-400', key: 'ext.stageSkippedStale' },
  'skipped:capped': { badge: 'bg-neutral-800 text-neutral-400', key: 'ext.stageSkippedCapped' },
  'skipped:duplicate': { badge: 'bg-neutral-800 text-neutral-400', key: 'ext.stageSkippedDuplicate' },
};

/** 谁判的（source → 词条；null/未知原样展示）。 */
export function sourceKey(source: string | null): MessageKey | null {
  if (source === 'fork') return 'ext.execWhoFork';
  if (source === 'decision-model') return 'ext.execWhoDecision';
  return null;
}

/** 触发来源文案（event / dry-run）。 */
export function triggerKey(trigger: string): MessageKey {
  return trigger === 'dry-run' ? 'ext.execTriggerDryRun' : 'ext.execTriggerEvent';
}
