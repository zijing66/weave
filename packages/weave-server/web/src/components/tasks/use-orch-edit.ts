import type { Connection } from '@xyflow/react';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { errorText, type ActionFeedback } from '@/lib/action-feedback';
import { ORCH_MAX_EDGES, addEdge, findCycle } from './orchestration-graph';
import { asEditing, type Editing } from './orchestration-canvas-nodes';
import type { OrchDraft } from './orchestration-graph';
import type { Dispatch, SetStateAction } from 'react';
import type { OrchestrationRow } from '@/lib/api';
import type { TFunc } from '@/i18n/t';

/**
 * 编辑面操作域：加边（本地先拒：自环/重边/成环/上限）、拖线连接、选边、
 * 保存/删除/手动触发/轮换 webhook 令牌、复制端点。破坏性动作走 setConfirmState
 * （应用内确认弹窗），落定后报 weave:orchestrations-changed 让卡片计数跟上。
 */
export function useOrchEdit(deps: {
  /** 编辑中的编排（null = 总览态）。 */
  editing: Editing | null;
  setEditing: Dispatch<SetStateAction<Editing | null>>;
  /** 当前草稿（editing?.draft）。 */
  draft: OrchDraft | null;
  patch: (fn: (d: OrchDraft) => OrchDraft) => void;
  /** 保存前校验结果（validateDraft 的产物）。 */
  check: { ok: boolean; error?: string } | null;
  /** 边错误提示（tryAddEdge 拒绝时写）。 */
  setEdgeError: (e: string | null) => void;
  /** 选中态（连线落定/选边要写）。 */
  setSel: (s: { kind: 'edge' | 'node'; id: string } | null) => void;
  /** 布局产物（selectEdge 要从渲染边键反查原始边）。 */
  laid: { edges: { key: string; edgeIds: string[] }[] } | null;
  projectId: number | null;
  /** 编排清单（save/remove/rotate 就地更新）。 */
  setList: Dispatch<SetStateAction<OrchestrationRow[] | null>>;
  /** 手动触发正文与入口选择。 */
  triggerText: string;
  setTriggerText: (t: string) => void;
  triggerEntries: string[] | null;
  fb: ActionFeedback;
  t: TFunc;
  show: (kind: 'success' | 'error', msg: string) => void;
  setConfirmState: (s: {
    title: string;
    message: string;
    confirmLabel: string;
    action: () => void;
  }) => void;
  refreshRuns: () => Promise<void>;
}) {
  const {
    editing, setEditing, draft, patch, check, setEdgeError, setSel, laid,
    projectId, setList, triggerText, setTriggerText, triggerEntries,
    fb, t, show, setConfirmState, refreshRuns,
  } = deps;
/**
 * 加一条连线：自环、重边、成环、条数上限都在本地先拒（服务端同判据才是权威）。
 * 成功回新边的 id——图上拖出来的那条要立刻选中，正文就在检查器里填。
 */
const tryAddEdge = (from: string, to: string): string | null => {
  if (!draft) return null;
  if (!from || !to) {
    setEdgeError(t('orch.edgeInvalid'));
    return null;
  }
  if (from === to) {
    setEdgeError(t('orch.edgeSelf'));
    return null;
  }
  if (draft.edges.some((e) => e.from === from && e.to === to)) {
    setEdgeError(t('orch.edgeExists'));
    return null;
  }
  if (draft.edges.length >= ORCH_MAX_EDGES) {
    setEdgeError(t('orch.edgeLimit', { max: ORCH_MAX_EDGES }));
    return null;
  }
  const next = addEdge(draft, from, to, '');
  const cycle = findCycle(next.nodes, next.edges);
  if (cycle) {
    setEdgeError(`${t('orch.edgeCycle')}：${cycle.join(' → ')}`);
    return null;
  }
  setEdgeError(null);
  patch(() => next);
  return next.edges[next.edges.length - 1]?.id ?? null;
};

/** 渲染节点 id → 编排节点 id：session 挂 `s:` 前缀，webhook 用裸 `w:` id；`g:` 不参与连线。 */
const orchNodeIdOf = (flowNodeId: string | undefined): string | null => {
  if (!flowNodeId) return null;
  if (flowNodeId.startsWith('s:')) return flowNodeId.slice(2);
  if (flowNodeId.startsWith('w:') || flowNodeId.startsWith('t:')) return flowNodeId;
  return null;
};

/** 从节点右侧圆点拖到另一个节点 = 连一条边，随即选中好去写正文。 */
const connectEdge = (c: Connection): void => {
  const from = orchNodeIdOf(c.source);
  const to = orchNodeIdOf(c.target);
  if (!from || !to) return;
  const id = tryAddEdge(from, to);
  if (id) setSel({ kind: 'edge', id });
};

/**
 * 渲染边的 id 是布局合并后的键（两段各带 `::a` / `::b` 后缀），选中的必须是
 * 底下那条原始边。连接点节点 id 是 `h:<边键>`，同一条线点哪儿都落到同一处。
 */
const selectEdge = (flowEdgeId: string): void => {
  const baseKey = flowEdgeId.startsWith('h:')
    ? flowEdgeId.slice(2)
    : flowEdgeId.replace(/::[ab]$/, '');
  const real = laid?.edges.find((e) => e.key === baseKey)?.edgeIds[0];
  if (real) setSel({ kind: 'edge', id: real });
};

const save = (): void => {
  if (!editing || !check?.ok) return;
  // 项目归属：有 session 节点 = 服务端从入口派生（不传）；无 session 节点
  // （纯 webhook/trigger 编排）= 必须显式给——画布定义行的项目选择器写
  // editing.projectId（全局视图新建时必选，否则服务端 400）。
  const hasSessionNode = editing.draft.nodes.some((n) => n.kind === 'session');
  const body = {
    name: editing.draft.name.trim(),
    startText: editing.draft.startText,
    ...(hasSessionNode ? {} : { projectId: editing.projectId ?? projectId ?? undefined }),
    nodes: editing.draft.nodes,
    edges: editing.draft.edges,
    cron: editing.draft.cron,
  };
  void fb.run(
    'orch:save',
    async () => {
      const res =
        editing.id == null
          ? await api.createOrchestration(body)
          : await api.updateOrchestration(editing.id, body);
      setEditing(asEditing(res.orchestration));
      setList((prev) => {
        if (!prev) return [res.orchestration];
        const found = prev.some((row) => row.id === res.orchestration.id);
        return found
          ? prev.map((row) => (row.id === res.orchestration.id ? res.orchestration : row))
          : [res.orchestration, ...prev];
      });
      show('success', t('orch.saved'));
      // 编排卡的计数归 App，改完定义报一声（同 HooksPanel 的 rules 事件）。
      window.dispatchEvent(new Event('weave:orchestrations-changed'));
    },
    { fail: (e) => t('orch.saveFailed', { error: errorText(e) }) },
  );
};




const remove = (): void => {
  if (!editing) return;
  if (editing.id == null) {
    setEditing(null);
    return;
  }
  const name = editing.draft.name.trim() || t('orch.untitled');
  const id = editing.id;
  setConfirmState({
    title: t('orch.deleteOrch'),
    message: t('orch.deleteConfirm', { name }),
    confirmLabel: t('orch.deleteOrch'),
    action: () => {
      void fb.run(
        'orch:delete',
        async () => {
          await api.deleteOrchestration(id);
          setEditing(null);
          setList((prev) => prev?.filter((row) => row.id !== id) ?? prev);
          show('success', t('orch.deleted'));
          window.dispatchEvent(new Event('weave:orchestrations-changed'));
          void refreshRuns();
        },
        { fail: (e) => t('orch.deleteFailed', { error: errorText(e) }) },
      );
    },
  });
};

const trigger = (): void => {
  if (!editing || editing.id == null) return;
  void fb.run(
    'orch:trigger',
    async () => {
      const res = await api.triggerOrchestration(editing.id!, {
        ...(triggerText.trim() ? { text: triggerText.trim() } : {}),
        ...(triggerEntries ? { entries: triggerEntries } : {}),
      });
      setTriggerText('');
      show('success', t('orch.triggerOk', { id: res.runId }));
      void refreshRuns();
    },
    { fail: (e) => t('orch.triggerFailed', { error: errorText(e) }) },
  );
};

const rotate = (nodeId: string): void => {
  if (!editing || editing.id == null) return;
  const id = editing.id;
  setConfirmState({
    title: t('orch.rotate'),
    message: t('orch.rotateConfirm'),
    confirmLabel: t('orch.rotate'),
    action: () => {
      void fb.run(
        'orch:rotate',
        async () => {
          const res = await api.rotateOrchestrationWebhook(id, nodeId);
          setList((prev) =>
            prev?.map((row) =>
              row.id === id
                ? {
                    ...row,
                    nodes: row.nodes.map((n) =>
                      n.id === nodeId ? { ...n, webhookToken: res.webhookToken } : n,
                    ),
                  }
                : row,
            ) ?? prev,
          );
          setEditing((prev) =>
            prev && prev.id === id
              ? {
                  ...prev,
                  draft: {
                    ...prev.draft,
                    nodes: prev.draft.nodes.map((n) =>
                      n.id === nodeId ? { ...n, webhookToken: res.webhookToken } : n,
                    ),
                  },
                }
              : prev,
          );
          show('success', t('orch.rotate'));
        },
        { fail: (e) => t('orch.rotateFailed', { error: errorText(e) }) },
      );
    },
  });
};


const copyEndpoint = (token: string): void => {
  const endpoint = `${window.location.origin}/webhooks/orchestrate/${token}`;
  void copyText(endpoint).then((ok) =>
    show(ok ? 'success' : 'error', ok ? t('orch.copied') : t('common.copyFailed')),
  );
};
  return { tryAddEdge, orchNodeIdOf, connectEdge, selectEdge, save, remove, trigger, rotate, copyEndpoint };
}
