/** 会话扩展点域（L1 绑定域，批 3 web 面）：绑定 CRUD + 执行日志 + dry-run + 派生面。 */

import { apiFetch } from './client';

/** v1 端点两类（mirror of server `ExtensionEndpointKind`；plugin 随批 4 放开）。 */
export type ExtensionEndpointKind = 'session' | 'webhook';
/** v1 四个扩展点（tool-failed / session-end 引擎缓做，CRUD 先收形状）。 */
export type ExtensionPoint = 'turn-end' | 'idle' | 'tool-failed' | 'session-end';

/** 扁平端点列表的一项：放行后并行扇出、无屏障。 */
export type ExtensionEndpoint =
  | { kind: 'session'; target: string; text: string; oneWay?: boolean }
  | { kind: 'webhook'; url: string; secret?: string };

/** 执行阶段（mirror of server `ExtensionStage`；stage 着色的词表）。 */
export type ExtensionStage =
  | 'when-blocked'
  | 'condition-blocked'
  | 'delivered'
  | 'failed'
  | 'skipped:busy'
  | 'skipped:stale'
  | 'skipped:capped'
  | 'skipped:duplicate';

/** mirror of server `ExtensionBindingRow`。 */
export interface ExtensionBindingRow {
  id: number;
  name: string;
  projectId: number;
  /** null = 项目级（对该项目全部会话生效）；非空 = 会话级（只绑这一个会话）。 */
  sessionId: string | null;
  point: ExtensionPoint;
  when: string | null;
  condition: string | null;
  summarize: string | null;
  endpoints: ExtensionEndpoint[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** mirror of server `ExtensionExecutionRow`。 */
export interface ExtensionExecutionRow {
  id: number;
  bindingId: number;
  sessionId: string | null;
  eventId: number | null;
  /** event = 真实 hook 事件触发；dry-run = §1.6 测试台合成一拍。 */
  trigger: string;
  stage: ExtensionStage;
  endpointKind: string | null;
  endpointTarget: string | null;
  ok: boolean | null;
  error: string | null;
  /** 谁做的判断（decision-model / fork）；condition/summarize 行才带。 */
  source: string | null;
  /** 判断依据（如 fork 的回答）；「谁判的、依据」展开里的半句。 */
  detail: string | null;
  at: string;
}

/** 绑定表体（POST 全量；PUT 同一形状的子集）。 */
export interface ExtensionBindingInput {
  name: string;
  projectId: number;
  /** null/缺省 = 项目级。 */
  sessionId?: string | null;
  point: ExtensionPoint;
  when?: string | null;
  condition?: string | null;
  summarize?: string | null;
  endpoints: ExtensionEndpoint[];
  enabled?: boolean;
}

/** 派生面（GET /extensions/capabilities）：按 harness 派生的触发点/端点/决策可用性。 */
export interface ExtensionHarnessCapability {
  harness: string;
  /** 触发点 → 触发它的事件名表（空表 = 该点不可配）。 */
  points: Partial<Record<'turn-end' | 'idle', readonly string[]>>;
  /** 端点可用性：session 靠 prompt 通道（无通道 = 投不出，置灰）；webhook 恒可。 */
  endpoints: { session: boolean; webhook: boolean };
  /** 决策内核（condition/summarize）：无 fork 提取面的 harness 置灰并说明。 */
  decision: boolean;
  unsupportedReasons?: { messaging?: string };
}

export const extensionApi = {
  /** 项目绑定列表（项目级 + 该项目全部会话级；叠加展示由前端分组）。 */
  listExtensionBindings: (projectId: number): Promise<ExtensionBindingRow[]> =>
    apiFetch<{ bindings: ExtensionBindingRow[] }>(
      `/extensions/bindings?projectId=${projectId}`,
    ).then((r) => r.bindings),

  createExtensionBinding: (
    body: ExtensionBindingInput,
  ): Promise<{ ok: boolean; binding: ExtensionBindingRow }> =>
    apiFetch('/extensions/bindings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),

  updateExtensionBinding: (
    id: number,
    patch: Partial<ExtensionBindingInput>,
  ): Promise<{ ok: boolean; binding: ExtensionBindingRow }> =>
    apiFetch(`/extensions/bindings/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  deleteExtensionBinding: (id: number): Promise<{ ok: boolean }> =>
    apiFetch(`/extensions/bindings/${id}`, { method: 'DELETE' }),

  /** 执行日志（新在前；`before` 游标向前翻页）。 */
  listExtensionExecutions: (q: {
    bindingId?: number;
    sessionId?: string;
    before?: number;
    limit?: number;
  }): Promise<{ executions: ExtensionExecutionRow[]; nextBefore: number | null }> => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(q)) {
      if (value != null && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    return apiFetch(`/extensions/executions${qs ? `?${qs}` : ''}`);
  },

  /** dry-run（§1.6 测试台）：合成一拍执行，不真扇出；逐阶段回报。 */
  dryRunExtensionBinding: (
    id: number,
    opts: { sessionId?: string; upstream?: string } = {},
  ): Promise<{
    ok: boolean;
    stages: Array<{
      stage: ExtensionStage;
      ok: boolean | null;
      error: string | null;
      endpointKind: string | null;
      endpointTarget: string | null;
      source: string | null;
      detail: string | null;
      at: string;
    }>;
  }> =>
    apiFetch(`/extensions/bindings/${id}/dry-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts),
    }),

  /** 派生面：按 harness 的触发点/端点/决策可用性（置灰与原因由此下发）。 */
  extensionCapabilities: (): Promise<{ harnesses: ExtensionHarnessCapability[] }> =>
    apiFetch('/extensions/capabilities'),
};
