import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, type HookDispatch, type HookEventRow, type SessionRow } from '@/lib/api';
import { EVENT_TYPE_STYLES, formatTime, parseDetail } from '@/lib/hook-payload';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';
import {
  buildLifecycleGroups,
  type LifecycleGroup,
} from '@/components/tasks/build-lifecycle-groups';
import { HARNESS_LIFECYCLE } from '@/components/tasks/lifecycle';
import { ChevronDown, ChevronRight } from 'lucide-react';

/**
 * 生命周期思维导图（Weave 画布第二视图，项目形态）：每个折叠根 = 一次
 * prompt（lifecycle 组）；展开 → 组内 hook 事件（时序，SubagentStop 打
 * subagent tag）→ 事件触发的指令 → 指令执行详情，层级如思维导图。
 * 父节点挂 tag（未正常结束 / subagent×n / 指令×n）；链路上存在 pending
 * 指令的节点常亮 amber 高光，新建指令入场闪烁（weave-node-flash）。
 */

// ---------------------------------------------------------------------------
// 布局（纯函数，可单测）
// ---------------------------------------------------------------------------

export type MindmapKind = 'group' | 'event' | 'subagent' | 'dispatch' | 'detail';

export interface LaidNode {
  key: string;
  kind: MindmapKind;
  depth: number;
  y: number;
  group?: LifecycleGroup;
  event?: HookEventRow;
  dispatch?: HookDispatch;
  expandable: boolean;
  expanded: boolean;
  /** 本节点或其子路径上存在 pending 指令 — amber 高光。 */
  highlight: boolean;
}

const COL_W = 320;
const ROW_H = 84;

/** 展开集驱动的可见树 + 分层布局：depth 列、叶子顺序流、父居子中。 */
export function layoutMindmap(
  groups: LifecycleGroup[],
  expanded: ReadonlySet<string>,
): { nodes: LaidNode[]; edges: { id: string; source: string; target: string }[] } {
  interface TNode {
    key: string;
    kind: MindmapKind;
    group?: LifecycleGroup;
    event?: HookEventRow;
    dispatch?: HookDispatch;
    children: TNode[];
    /** 自身或子树含 pending 指令（回传高光）。 */
    highlight: boolean;
  }

  const dispatchNodes = (list: HookDispatch[]): TNode[] =>
    list.map((d) => {
      const key = `d:${d.id}`;
      const pending = d.status === 'pending';
      const children: TNode[] = [];
      if (expanded.has(key)) {
        children.push({
          key: `${key}:detail`,
          kind: 'detail',
          dispatch: d,
          children: [],
          highlight: pending,
        });
      }
      return { key, kind: 'dispatch', dispatch: d, children, highlight: pending };
    });

  const roots: TNode[] = [];
  for (const g of groups) {
    const gKey = `g:${g.id}`;
    const children: TNode[] = [];
    if (expanded.has(gKey)) {
      if (g.events.length > 0) {
        for (const e of g.events) {
          const eKey = `e:${e.id}`;
          const kids =
            expanded.has(eKey)
              ? dispatchNodes(g.dispatches.filter((d) => d.eventId === e.id))
              : [];
          const hl = kids.some((k) => k.highlight);
          // SubagentStop 独立成「子代理」层节点（与普通 hook 事件分型），
          // 从属关系 = prompt 组 → 子代理 → 其触发的指令。
          const kind: MindmapKind =
            e.eventType === HARNESS_LIFECYCLE.claude.subagentStop ? 'subagent' : 'event';
          children.push({ key: eKey, kind, event: e, children: kids, highlight: hl });
        }
      } else {
        // 游离指令组（orphan）：无事件边界，指令直挂 prompt 根下。
        children.push(...dispatchNodes(g.dispatches));
      }
    }
    const hl =
      children.some((c) => c.highlight) || g.dispatches.some((d) => d.status === 'pending');
    roots.push({ key: gKey, kind: 'group', group: g, children, highlight: hl });
  }

  // 后序分配 y：叶子占槽递增，父取子中点；边构建随遍历走。
  const nodes: LaidNode[] = [];
  const edges: { id: string; source: string; target: string }[] = [];
  let cursor = 0;
  const walk = (n: TNode, depth: number, parentKey: string | null): number => {
    if (parentKey) edges.push({ id: `${parentKey}->${n.key}`, source: parentKey, target: n.key });
    let y: number;
    if (n.children.length === 0) {
      y = cursor * ROW_H;
      cursor += 1;
    } else {
      const first = walk(n.children[0], depth + 1, n.key);
      let last = first;
      for (let i = 1; i < n.children.length; i++) last = walk(n.children[i], depth + 1, n.key);
      y = (first + last) / 2;
    }
    nodes.push({
      key: n.key,
      kind: n.kind,
      depth,
      y,
      group: n.group,
      event: n.event,
      dispatch: n.dispatch,
      expandable: n.children.length > 0 || expandable(n),
      expanded: expanded.has(n.key),
      highlight: n.highlight,
    });
    return y;
  };
  // expandable 判定需要「有可展开的潜在子级」：group 总可展开（事件/指令可能为空仍
  // 给入口由调用方空态兜底）——折叠的 group/dispatch/event/subagent 一律给 chevron。
  function expandable(n: TNode): boolean {
    if (n.kind === 'group') return true;
    if (n.kind === 'event') return true;
    if (n.kind === 'subagent') return true;
    if (n.kind === 'dispatch') return true;
    return false;
  }
  for (const r of roots) walk(r, 0, null);
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// 节点渲染
// ---------------------------------------------------------------------------

function rawOf(event: HookEventRow): Record<string, unknown> {
  try {
    const p = JSON.parse(event.payload) as { raw?: unknown };
    return p.raw && typeof p.raw === 'object' ? (p.raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const flat = (v: string): string => v.replace(/\s+/g, ' ').trim();
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * 按 hook 类型提取该事件的关键信息（完整展示，不只路径）：prompt 原文 /
 * tool 参数与结果首行 / 通知消息 / 子代理结束消息。空串 = 该类型无正文，
 * 节点退化为类型 tag + 时间。
 */
export function summarizeEvent(event: HookEventRow): string {
  const raw = rawOf(event);
  const detail = parseDetail(event.payload);
  switch (event.eventType) {
    case 'UserPromptSubmit':
      return flat(str(raw.prompt) ?? '');
    case 'PreToolUse':
    case 'PostToolUse': {
      const input = (detail.toolInput ?? {}) as Record<string, unknown>;
      const arg =
        str(input.file_path) ??
        str(input.path) ??
        str(input.description) ??
        str(input.pattern) ??
        str(input.url) ??
        str(input.command) ??
        '';
      const head = flat([detail.toolName, arg].filter(Boolean).join(' '));
      if (event.eventType === 'PostToolUse') {
        const r = detail.toolResponse as Record<string, unknown> | null;
        const out =
          r && typeof r === 'object'
            ? (str((r as Record<string, unknown>).stdout) ??
              str((r as Record<string, unknown>).type))
            : null;
        if (out) return `${head} → ${flat(out).slice(0, 90)}`;
      }
      return head;
    }
    case 'Notification': {
      const msg = str(raw.message) ?? '';
      const nt = str(raw.notification_type);
      return nt && msg ? `${nt} · ${msg}` : (nt ?? msg);
    }
    case 'SubagentStop':
      return flat(str(raw.last_assistant_message) ?? '');
    case 'SessionStart':
    case 'SessionEnd': {
      const title = str(raw.session_title) ?? '';
      const source = str(raw.source) ?? '';
      return [title, source].filter(Boolean).join(' · ');
    }
    default:
      return '';
  }
}

type MindmapData = {
  node: LaidNode;
  flash: boolean;
  /** dispatch 节点的规则显示名（规则名映射由组件算好传入）。 */
  ruleName?: string;
  onToggle: (key: string) => void;
};
type MindmapFlowNode = Node<MindmapData, 'mindmap'>;

function tagCls(base: string): string {
  return `${base} rounded px-1 py-px text-[10px] leading-tight`;
}

function MindmapNode({ data }: NodeProps<MindmapFlowNode>) {
  const t = useT();
  const { node, flash, onToggle } = data;
  const chevron = node.expandable ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle(node.key);
      }}
      className="shrink-0 rounded p-0.5 text-neutral-500 transition-colors hover:bg-white/[0.08] hover:text-neutral-200"
      aria-expanded={node.expanded}
    >
      {node.expanded ? (
        <ChevronDown className="h-3.5 w-3.5" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5" />
      )}
    </button>
  ) : (
    <span className="w-4 shrink-0" />
  );

  let body: React.ReactNode = null;
  if (node.kind === 'group' && node.group) {
    const g = node.group;
    const head = g.preSession
      ? t('hooks.mindmap.preSession')
      : g.id === 'orphan'
        ? t('hooks.mindmap.orphan')
        : (g.prompt ?? t('hooks.mindmap.preSession'));
    const startedAt = g.events[0]?.createdAt;
    body = (
      <>
        <span className="block truncate text-xs text-neutral-100" title={g.prompt ?? head}>
          {head}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1">
          {g.preSession || g.id === 'orphan' ? (
            <span className={tagCls('bg-neutral-800 text-neutral-300')}>{head}</span>
          ) : (
            <span className={tagCls('bg-cyan-900/40 text-cyan-300')}>prompt</span>
          )}
          {g.open && (
            <span className={tagCls('bg-red-900/40 text-red-300')}>
              {t('hooks.mindmap.openTag')}
            </span>
          )}
          {g.subagentStops > 0 && (
            <span className={tagCls('bg-orange-900/40 text-orange-300')}>
              {t('hooks.mindmap.subagentCount', { n: g.subagentStops })}
            </span>
          )}
          {g.dispatches.length > 0 && (
            <span className={tagCls('bg-emerald-900/40 text-emerald-300')}>
              {t('hooks.mindmap.dispatchCount', { n: g.dispatches.length })}
            </span>
          )}
          <span className="text-[10px] text-neutral-500">
            {t('catbar.items', { n: g.events.length })}
            {startedAt ? ` · ${formatTime(startedAt)}` : ''}
          </span>
        </span>
      </>
    );
  } else if ((node.kind === 'event' || node.kind === 'subagent') && node.event) {
    const e = node.event;
    const isSub = node.kind === 'subagent';
    const summary = summarizeEvent(e);
    const raw = isSub ? rawOf(e) : null;
    const agentId = raw ? str(raw.agent_id) : null;
    body = (
      <>
        <span className="flex flex-wrap items-center gap-1">
          <span
            className={tagCls(EVENT_TYPE_STYLES[e.eventType] ?? 'bg-neutral-800 text-neutral-300')}
          >
            {e.eventType}
          </span>
          {isSub && (
            <span className={tagCls('border border-orange-700/50 bg-orange-950/60 text-orange-300')}>
              subagent
            </span>
          )}
          {agentId && (
            <span className="text-[10px] text-neutral-500">agent …{agentId.slice(-8)}</span>
          )}
          <span className="text-[10px] text-neutral-500">{formatTime(e.createdAt)}</span>
        </span>
        {summary && (
          <span
            className={cn(
              'mt-0.5 block text-[11px] text-neutral-400',
              isSub ? 'line-clamp-2 text-orange-100/70' : 'truncate',
            )}
            title={summary}
          >
            {summary}
          </span>
        )}
      </>
    );
  } else if (node.kind === 'dispatch' && node.dispatch) {
    const d = node.dispatch;
    body = (
      <>
        <span className="flex items-center gap-1">
          <span className={tagCls('bg-emerald-900/40 text-emerald-300')}>
            {t('hooks.mindmap.dispatchTag')}
          </span>
          <span className="truncate text-[10px] text-neutral-400" title={data.ruleName ?? d.ruleId}>
            {data.ruleName ?? d.ruleId}
          </span>
          <StatusDot status={d.status} />
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-neutral-400" title={d.prompt}>
          {d.prompt}
        </span>
      </>
    );
  } else if (node.kind === 'detail' && node.dispatch) {
    const d = node.dispatch;
    body = (
      <span className="block space-y-0.5 text-[11px] text-neutral-400">
        <span className="flex items-center gap-1.5">
          <StatusDot status={d.status} />
          <span className="text-neutral-500">{formatTime(d.startedAt)}</span>
          {d.finishedAt && (
            <span className="text-neutral-600">→ {formatTime(d.finishedAt)}</span>
          )}
        </span>
        <span className="block whitespace-pre-wrap break-all line-clamp-4" title={d.prompt}>
          {d.prompt}
        </span>
        {d.output && (
          <span className="block whitespace-pre-wrap break-all line-clamp-4 text-neutral-500">
            {d.output}
          </span>
        )}
        {d.error && <span className="block text-red-400/80 line-clamp-2">{d.error}</span>}
      </span>
    );
  }

  return (
    <div
      className={cn(
        'flex w-[280px] items-start gap-1 rounded-lg border border-white/[0.08] bg-neutral-900/95 px-2 py-1.5 shadow-mac',
        node.highlight && 'ring-1 ring-amber-400/70',
        flash && 'weave-node-flash',
      )}
      title={node.highlight ? t('hooks.mindmap.pendingTip') : undefined}
    >
      {chevron}
      <div className="min-w-0 flex-1">{body}</div>
    </div>
  );
}

const STATUS_LABEL: Record<string, MessageKey> = {
  pending: 'hooks.status.pending',
  injected: 'hooks.status.injected',
  running: 'hooks.status.running',
  succeeded: 'hooks.status.succeeded',
  failed: 'hooks.status.failed',
  timeout: 'hooks.status.timeout',
};

function StatusDot({ status }: { status: string }) {
  const t = useT();
  const tone =
    status === 'succeeded'
      ? 'bg-emerald-500'
      : status === 'failed' || status === 'timeout'
        ? 'bg-red-400'
        : status === 'running'
          ? 'bg-blue-400 animate-pulse'
          : status === 'injected'
            ? 'bg-cyan-400'
            : 'bg-amber-400';
  const key = STATUS_LABEL[status];
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-neutral-500">
      <span className={`h-1.5 w-1.5 rounded-full ${tone}`} />
      {key ? t(key) : status}
    </span>
  );
}

const nodeTypes = { mindmap: MindmapNode };

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

interface SseFrame {
  kind?: string;
  dispatchId?: number;
}

export function LifecycleMindmap({
  projectId,
  sessionId,
  sessions,
  onSelect,
}: {
  projectId: number;
  sessionId: string;
  sessions: SessionRow[];
  onSelect: (sessionId: string) => void;
}) {
  const t = useT();
  const [events, setEvents] = useState<HookEventRow[] | null>(null);
  const [dispatches, setDispatches] = useState<HookDispatch[] | null>(null);
  const [ruleNames, setRuleNames] = useState<Map<string, string>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  /** 新建指令入场闪烁的节点 key（900ms 摘除）。 */
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  const refreshTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [ev, ds, rs] = await Promise.all([
        api.listSessionHooks(projectId, sessionId, 300),
        api.listHookDispatches({ limit: 200 }),
        api.listHooksRules(projectId),
      ]);
      setEvents(ev);
      setDispatches(ds);
      setRuleNames(new Map(rs.map((r) => [r.id, r.name])));
    } catch {
      // daemon 未连：保持上次数据
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    setEvents(null);
    setDispatches(null);
    setExpanded(new Set());
    void load();
  }, [load]);

  // SSE：指令帧 → 闪烁新建节点 + 500ms 防抖重拉（事件与指令一起刷新）。
  useEffect(() => {
    const onHook = (ev: Event): void => {
      const frame = (ev as CustomEvent<SseFrame>).detail;
      if (frame.kind === 'dispatch.created' && frame.dispatchId != null) {
        setFlashKey(`d:${frame.dispatchId}`);
        if (flashTimer.current) window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setFlashKey(null), 900);
      }
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => void load(), 500);
    };
    window.addEventListener('weave:hook', onHook);
    return () => {
      window.removeEventListener('weave:hook', onHook);
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, [load]);

  const groups = useMemo(() => {
    if (!events || !dispatches) return [];
    const eventIds = new Set(events.map((e) => e.id));
    // 归本会话的指令 + 由本会话事件触发但尚未投送（sessionId null）的指令。
    // 服务端指令池按最新在前返回——归组前升序，组内子节点才与事件同为时间升序。
    const mine = dispatches
      .filter((d) => d.sessionId === sessionId || (d.eventId != null && eventIds.has(d.eventId)))
      .sort((a, b) => a.id - b.id);
    return buildLifecycleGroups(events, mine, HARNESS_LIFECYCLE.claude);
  }, [events, dispatches, sessionId]);

  const laid = useMemo(() => layoutMindmap(groups, expanded), [groups, expanded]);

  const onToggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const flowNodes: MindmapFlowNode[] = useMemo(
    () =>
      laid.nodes.map((n) => ({
        id: n.key,
        type: 'mindmap',
        position: { x: n.depth * COL_W, y: n.y },
        data: {
          node: n,
          flash: flashKey === n.key,
          ruleName: n.dispatch ? ruleNames.get(n.dispatch.ruleId) : undefined,
          onToggle,
        },
        draggable: true,
      })),
    [laid.nodes, flashKey, ruleNames, onToggle],
  );
  const flowEdges: Edge[] = useMemo(
    () =>
      laid.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'smoothstep',
        style: { stroke: 'rgba(255,255,255,0.2)', strokeWidth: 1.5 },
      })),
    [laid.edges],
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-neutral-500">{t('hooks.mindmap.pickSession')}</label>
        <select
          value={sessionId}
          onChange={(e) => onSelect(e.target.value)}
          className="rounded-md border border-white/[0.08] bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
        >
          {sessions.map((s) => (
            <option key={s.sessionId} value={s.sessionId}>
              {s.title ?? s.sessionId.slice(0, 8)}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-neutral-500">
          {events === null ? t('hooks.loading') : t('catbar.items', { n: groups.length })}
        </span>
        <span className="ml-auto text-[11px] text-neutral-600">{t('hooks.mindmap.hint')}</span>
      </div>

      <div className="h-96 rounded-lg border border-white/[0.06] bg-neutral-950/40">
        {events === null ? (
          <div className="flex h-full items-center justify-center text-xs text-neutral-500">
            {t('hooks.loading')}
          </div>
        ) : flowNodes.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-neutral-500">
            {t('hooks.mindmap.empty')}
          </div>
        ) : (
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.15}
            maxZoom={1.5}
            nodesDraggable
            nodesConnectable={false}
            deleteKeyCode={null}
            defaultEdgeOptions={{
              type: 'smoothstep',
              style: { stroke: 'rgba(255,255,255,0.2)', strokeWidth: 1.5 },
            }}
          >
            <Background gap={14} size={1} color="rgba(255,255,255,0.06)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}
