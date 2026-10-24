/** 编排域：命名编排的定义、运行与运行日志。 */

import { apiFetch } from './client';

/** mirror of `OrchestrationEdge` in packages/weave-server/src/repositories/orchestrations.ts。 */
export interface OrchestrationEdge {
  id: string;
  from: string;
  to: string;
  /** 源节点每完成一轮就投给目标的正文（支持 {upstream}/{summary}/{session} 变量）。 */
  text: string;
  /** 本边提取指令（对上游会话 fork 无头回合产出 {summary}；空 = 不提取）。 */
  extract?: string;
  /** 本边放行条件（对上游会话问 yes/no；no 或判不出都拦下不投，webhook 入口边不可设）。 */
  condition?: string;
  /** 本边文本预筛（{upstream} 命中任一关键词才继续/才 fork；webhook 入口边不可设）。 */
  when?: string;
}

export type OrchestrationNodeKind = 'session' | 'webhook' | 'trigger';

/** mirror of `OrchestrationNode`：session 节点 id = sessionId；webhook = `w:<uuid>`；手动触发 = `t:<uuid>`。 */
export interface OrchestrationNode {
  id: string;
  kind: OrchestrationNodeKind;
  /** webhook 入口的触发 token（端点 = `/webhooks/orchestrate/<token>`）。 */
  webhookToken?: string;
  /** webhook 出口的出站目标与可选 HMAC 密钥。 */
  url?: string;
  secret?: string;
  /** session 中间节点也参与自然回合触发（入口恒可；enabled 闸全局管）。 */
  autoFire?: boolean;
}

export type OrchestrationTrigger = 'manual' | 'webhook' | 'cron';
export type OrchestrationRunStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

/** mirror of `OrchestrationRow` + 服务端现算的 `nextRunAt`。 */
export interface OrchestrationRow {
  id: number;
  name: string;
  /** 入口 session 节点所属项目（项目编排即按它过滤）。 */
  projectId: number;
  startText: string;
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  /** false = 停用：cron 不触发、入口会话的自然回合不自动启动。 */
  enabled: boolean;
  cron: string | null;
  lastCronAt: string | null;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
}

export interface OrchestrationRunEvent {
  at: string;
  from: string;
  to: string;
  edgeId: string;
  ok: boolean;
  error?: string;
  /**
   * 缺省 = 一次投递；ensure = 拉起会话的尝试；condition = 条件边判定（放行与
   * 拦下都落一条）；defer = 人在场闸挂起。
   */
  stage?: 'ensure' | 'condition' | 'defer';
  ms?: number;
  /** condition 事件专用：谁做的判断（decision-model / fork）。 */
  source?: string;
  /** condition 事件专用：判断依据（如 `P(yes)=0.85`）。 */
  detail?: string;
}

export interface OrchestrationRunState {
  pending: Record<string, Array<{ messageId: string; at: string }>>;
  events: OrchestrationRunEvent[];
}

/** 列表行 = summary（无 state）；详情行另带 state。 */
export interface OrchestrationRunRow {
  id: number;
  orchestrationId: number;
  orchestrationName: string;
  projectId: number;
  trigger: OrchestrationTrigger;
  status: OrchestrationRunStatus;
  deliveries: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  updatedAt: string;
  pendingCounts: Record<string, number>;
  state?: OrchestrationRunState;
}

/** 定义体（POST/PUT 同一个形状；PUT 接受它的部分字段）。 */
export interface OrchestrationInput {
  name: string;
  startText?: string;
  /** webhook-only 编排的项目归属（有 session 入口时由服务端从入口派生）。 */
  projectId?: number;
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  cron?: string | null;
  /** false = 停用：cron 不触发、入口会话的自然回合不自动启动。 */
  enabled?: boolean;
}

export const orchestrationApi = {
  /** 跨会话序列列表（新在前；编排画布用，全项目共用一张表）。 */
  listOrchestrations: (projectId?: number): Promise<OrchestrationRow[]> =>
    apiFetch<{ orchestrations: OrchestrationRow[] }>(
      projectId == null
        ? '/messaging/orchestrations'
        : `/messaging/orchestrations?projectId=${projectId}`,
    ).then((r) => r.orchestrations),

  createOrchestration: (
    body: OrchestrationInput,
  ): Promise<{ ok: boolean; orchestration: OrchestrationRow }> =>
    apiFetch('/messaging/orchestrations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),

  updateOrchestration: (
    id: number,
    patch: Partial<OrchestrationInput>,
  ): Promise<{ ok: boolean; orchestration: OrchestrationRow }> =>
    apiFetch(`/messaging/orchestrations/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  deleteOrchestration: (id: number): Promise<{ ok: boolean }> =>
    apiFetch(`/messaging/orchestrations/${id}`, { method: 'DELETE' }),

  triggerOrchestration: (
    id: number,
    opts: { text?: string; entries?: string[] } = {},
  ): Promise<{ ok: boolean; runId: number }> =>
    apiFetch(`/messaging/orchestrations/${id}/trigger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts),
    }),

  rotateOrchestrationWebhook: (
    id: number,
    nodeId: string,
  ): Promise<{ ok: boolean; webhookToken: string }> =>
    apiFetch(`/messaging/orchestrations/${id}/rotate-webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId }),
    }),

  listOrchestrationRuns: (q: {
    orchestrationId?: number;
    projectId?: number;
    status?: OrchestrationRunStatus;
    text?: string;
    before?: number;
    limit?: number;
  }): Promise<{ runs: OrchestrationRunRow[]; nextBefore: number | null }> => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(q)) {
      if (value != null && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    return apiFetch(`/messaging/orchestration-runs${qs ? `?${qs}` : ''}`);
  },

  getOrchestrationRun: (id: number): Promise<{ run: OrchestrationRunRow }> =>
    apiFetch(`/messaging/orchestration-runs/${id}`),

  cancelOrchestrationRun: (id: number): Promise<{ ok: boolean }> =>
    apiFetch(`/messaging/orchestration-runs/${id}/cancel`, { method: 'POST' }),

  clearOrchestrationRuns: (
    scope: 'finished' | 'all',
    projectId?: number,
  ): Promise<{ ok: boolean; deleted: number }> => {
    const params = new URLSearchParams({ scope });
    if (projectId != null) params.set('projectId', String(projectId));
    return apiFetch(`/messaging/orchestration-runs?${params.toString()}`, { method: 'DELETE' });
  },
};
