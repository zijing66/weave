import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, type HookDispatch, type HookEventRow, type SessionRow } from '@/lib/api';
import {
  EVENT_TYPE_STYLES,
  agentDispatchOf,
  formatTime,
  parseDetail,
  rawOf,
  summarizeEvent,
  taskNotificationOf,
} from '@/lib/hook-payload';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';
import {
  buildLifecycleGroups,
  ORPHAN_GROUP_ID,
  type LifecycleGroup,
} from '@/components/tasks/build-lifecycle-groups';
import { HARNESS_LIFECYCLE } from '@/components/tasks/lifecycle';
import { ChevronDown, ChevronRight, X } from 'lucide-react';

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

export type MindmapKind =
  | 'group'
  | 'event'
  | 'subagent'
  | 'notification'
  | 'rule'
  | 'handler'
  | 'dispatch';

/** 规则最小信息（命中链层级用；handlerType 缺失时跳过处理器层）。 */
export type RuleInfo = { name: string | null; handlerType: string | null };

export interface LaidNode {
  key: string;
  kind: MindmapKind;
  depth: number;
  y: number;
  group?: LifecycleGroup;
  event?: HookEventRow;
  dispatch?: HookDispatch;
  /** kind=rule：命中规则展示名（null → 显示 ruleId 短名）。 */
  ruleId?: string;
  ruleName?: string | null;
  /** kind=handler：处理器类型。 */
  handlerType?: string;
  /** 派发子代理 id / 子代理结束的 agent_id（环成员回溯证据）。 */
  agentId?: string;
  /** 当前使用的 model（派发 resolvedModel / SessionStart raw.model）。 */
  model?: string;
  /** 派发环状态：true=子代理未返回（环不闭环）。仅派发事件节点有。 */
  agentRunning?: boolean;
  /** 真有（潜在）子节点才渲染折叠按钮——明细改点击节点右上面板承载。 */
  expandable: boolean;
  expanded: boolean;
  /** 本节点或其子路径上存在 pending 指令 — amber 高光。 */
  highlight: boolean;
}

const COL_W = 320;
/** 行距大于节点高度：父子边的 smoothstep 折线才有可见竖直段（DAG 连线）。 */
const ROW_H = 128;

/** SessionStart 携带的会话 model（其余事件类型无 model 字段）。 */
function sessionModelOf(event: HookEventRow): string | undefined {
  if (event.eventType !== 'SessionStart') return undefined;
  const m = rawOf(event).model;
  return typeof m === 'string' && m ? m : undefined;
}

/** 边：closure=true 是闭环回边（末事件 → prompt 根，成环）；vertical=true
 *  是同列时序链（底出顶入，防跨列锚点绕行交叉）。 */
export interface LaidEdge {
  id: string;
  source: string;
  target: string;
  closure?: boolean;
  vertical?: boolean;
}

/**
 * 展开集驱动的可见树 + 分层布局（depth 列、叶子顺序流、父居子中）：
 * 层级 = prompt 组 → hook 事件（SubagentStop=子代理分型）→ 命中规则 →
 * 处理器（handlerType 已知时）→ 派发结果。**组内事件按实际调用时序成链**：
 * 根→首事件→…→末事件→根（虚线闭环）——一次 prompt 完成闭环，非放射 DAG。
 * 节点明细走点击右上角浮层。
 */
export function layoutMindmap(
  groups: LifecycleGroup[],
  expanded: ReadonlySet<string>,
  ruleInfo: ReadonlyMap<string, RuleInfo> = new Map(),
  sessionModel?: string,
): { nodes: LaidNode[]; edges: LaidEdge[] } {
  interface TNode {
    key: string;
    kind: MindmapKind;
    group?: LifecycleGroup;
    event?: HookEventRow;
    dispatch?: HookDispatch;
    ruleId?: string;
    ruleName?: string | null;
    handlerType?: string;
    agentId?: string;
    model?: string;
    /** 派发环：true=子代理尚未返回（不画闭环）。 */
    agentRunning?: boolean;
    children: TNode[];
    /** 有（潜在）子节点——折叠按钮只给这类块。 */
    hasPotential: boolean;
    /** 自身或子树含 pending 指令（回传高光）。 */
    highlight: boolean;
  }

  const dispatchNodes = (list: HookDispatch[]): TNode[] =>
    list.map((d) => {
      const pending = d.status === 'pending';
      // 派发是叶子：明细由点击节点的右上面板承载（不再有 detail 子层）。
      return {
        key: `d:${d.id}`,
        kind: 'dispatch' as const,
        dispatch: d,
        children: [],
        hasPotential: false,
        highlight: pending,
      };
    });

  /** 事件的命中链子树：按 ruleId 去重 → rule →（已知类型时）handler → dispatch。 */
  const hitChain = (eventId: number, dispatches: HookDispatch[]): TNode[] => {
    const byRule = new Map<string, HookDispatch[]>();
    for (const d of dispatches) {
      const list = byRule.get(d.ruleId) ?? [];
      list.push(d);
      byRule.set(d.ruleId, list);
    }
    const out: TNode[] = [];
    for (const [ruleId, ds] of byRule) {
      const rKey = `e:${eventId}:r:${ruleId}`;
      const info = ruleInfo.get(ruleId);
      const pending = ds.some((d) => d.status === 'pending');
      const dispatchKids = dispatchNodes(ds);
      let kids: TNode[];
      if (info?.handlerType) {
        const hKey = `${rKey}:h`;
        kids = [
          {
            key: hKey,
            kind: 'handler',
            handlerType: info.handlerType,
            children: dispatchKids,
            hasPotential: dispatchKids.length > 0,
            highlight: pending,
          },
        ];
      } else {
        kids = dispatchKids; // 规则已删/类型未知：跳过处理器层
      }
      out.push({
        key: rKey,
        kind: 'rule',
        ruleId,
        ruleName: info ? info.name : null,
        children: kids,
        hasPotential: kids.length > 0,
        highlight: pending,
      });
    }
    return out;
  };

  const roots: TNode[] = [];
  /** 派发环收集（walk 后重构成链）：锚节点 + 环成员 + 是否已返回（可闭环）。 */
  const rings: { anchor: TNode; members: TNode[]; closed: boolean }[] = [];
  for (const g of groups) {
    const gKey = `g:${g.id}`;
    const children: TNode[] = [];
    if (expanded.has(gKey)) {
      if (g.events.length > 0) {
        // 主链 = 非环成员事件（时序）。三类节点：
        // ① 派发锚（PostToolUse + toolResponse.agentId）——进主链，登记锚表；
        // ② 环成员：SubagentStop.agent_id / task-notification 匹配锚 → 挂锚下
        //    不进主链（子代理的生命周期挂回派发节点，成独立环）；
        // ③ 其余 SubagentStop → 时序前驱分叉（同步子代理，无派发证据）。
        const chain: TNode[] = [];
        const nodesByRow = new Map<number, TNode>();
        /** 派发锚索引：agentId / tool_use_id → 锚节点。 */
        const anchors = new Map<string, TNode>();
        const ringMembers = new Map<TNode, TNode[]>();
        let prevRow: HookEventRow | null = null;
        for (const e of g.events) {
          const eKey = `e:${e.id}`;
          const hits = g.dispatches.filter((d) => d.eventId === e.id);
          const kids = expanded.has(eKey) ? hitChain(e.id, hits) : [];
          const isSub = e.eventType === HARNESS_LIFECYCLE.claude.subagentStop;
          const ad = agentDispatchOf(e);
          const notif = taskNotificationOf(e.payload);

          // 环成员归锚：先于主链判定（匹配则挂锚、不占主链）
          if (notif || isSub) {
            const raw = rawOf(e);
            const agentId =
              notif?.taskId ?? (typeof raw.agent_id === 'string' ? raw.agent_id : null);
            const anchor =
              (notif?.toolUseId ? anchors.get(notif.toolUseId) : undefined) ??
              (agentId ? anchors.get(agentId) : undefined);
            if (anchor) {
              const member: TNode = {
                key: eKey,
                kind: notif ? 'notification' : 'subagent',
                event: e,
                children: kids,
                hasPotential: kids.length > 0,
                highlight: kids.some((k) => k.highlight),
                // 环成员继承派发锚的 model（子代理实际使用的模型）
                model: anchor.model,
                agentId: anchor.agentId,
              };
              const list = ringMembers.get(anchor) ?? [];
              list.push(member);
              ringMembers.set(anchor, list);
              nodesByRow.set(e.id, member);
              if (notif) anchor.agentRunning = false; // 收到返回 → 环可闭环
              continue;
            }
            // 通知挂不上锚（派发在窗口外）：留主链作普通事件，不丢证据
          }

          const node: TNode = {
            key: eKey,
            kind: notif ? 'notification' : isSub ? 'subagent' : 'event',
            event: e,
            children: kids,
            hasPotential: hits.length > 0, // 无触发指令的事件是叶子——不给折叠按钮
            highlight: kids.some((k) => k.highlight),
            agentId: ad?.agentId ?? notif?.taskId ?? undefined,
            model: ad?.model ?? sessionModelOf(e), // 派发=resolvedModel；SessionStart=会话 model
            agentRunning: ad ? true : undefined,
          };
          if (ad) {
            anchors.set(ad.agentId, node);
            if (ad.toolUseId) anchors.set(ad.toolUseId, node);
            ringMembers.set(node, []);
          }

          if (isSub) {
            const prevNode = prevRow ? nodesByRow.get(prevRow.id) : undefined;
            if (prevNode) {
              prevNode.children.unshift(node); // 分叉：挂前驱下、恒显示
              prevNode.highlight = prevNode.highlight || node.highlight;
              prevRow = e;
              nodesByRow.set(e.id, node);
              continue;
            }
            // 首事件即 SubagentStop（无前驱）：退化并入主链
          }
          chain.push(node);
          nodesByRow.set(e.id, node);
          prevRow = e;
        }
        // 环成员挂锚前部（分叉语义，先于命中链子树展示）
        for (const [anchor, members] of ringMembers) {
          if (members.length > 0) {
            anchor.children = [...members, ...anchor.children];
            anchor.highlight = anchor.highlight || members.some((m) => m.highlight);
            rings.push({ anchor, members, closed: !anchor.agentRunning });
          }
        }
        children.push(...chain);
      } else {
        // 游离指令组（orphan，调用方已过滤）：指令直挂 prompt 根下。
        children.push(...dispatchNodes(g.dispatches));
      }
    }
    const hl =
      children.some((c) => c.highlight) || g.dispatches.some((d) => d.status === 'pending');
    roots.push({
      key: gKey,
      kind: 'group',
      group: g,
      children,
      hasPotential: g.events.length > 0 || g.dispatches.length > 0,
      highlight: hl,
      model: sessionModel,
    });
  }

  // 后序分配 y：叶子占槽递增，父取子中点；边构建随遍历走。
  const nodes: LaidNode[] = [];
  const edges: LaidEdge[] = [];
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
      ruleId: n.ruleId,
      ruleName: n.ruleName,
      handlerType: n.handlerType,
      agentId: n.agentId,
      model: n.model,
      agentRunning: n.agentRunning,
      expandable: n.hasPotential,
      expanded: expanded.has(n.key),
      highlight: n.highlight,
    });
    return y;
  };
  for (const r of roots) walk(r, 0, null);

  // 组内事件改为**实际调用时序链 + 闭环**：删 walk 生成的根→事件放射边，
  // 改 根→首事件→…→末事件→根（closure 虚线回边）——一次 prompt 首尾相接
  // 成环（可成环，非 DAG）；事件的规则/指令子树边保留。
  for (const r of roots) {
    if (r.kind !== 'group') continue;
    const evs = r.children.filter(
      (c) => c.kind === 'event' || c.kind === 'subagent' || c.kind === 'notification',
    );
    if (evs.length === 0) continue; // orphan 直挂 dispatch 维持放射
    const evKeys = new Set(evs.map((c) => c.key));
    for (let i = edges.length - 1; i >= 0; i--) {
      const e = edges[i]!;
      if (e.source === r.key && evKeys.has(e.target)) edges.splice(i, 1);
    }
    edges.push({ id: `${r.key}->${evs[0]!.key}`, source: r.key, target: evs[0]!.key });
    for (let i = 0; i + 1 < evs.length; i++) {
      // 同列时序链：底出顶入直连（vertical），不走跨列锚点绕行
      edges.push({
        id: `${evs[i]!.key}->${evs[i + 1]!.key}`,
        source: evs[i]!.key,
        target: evs[i + 1]!.key,
        vertical: true,
      });
    }
    // 闭环回根 = 该 prompt 已等到自己的 Stop（正常结束）；进行中/中断
    //（open，没有 Stop 这一闭环事件）不画回边。
    if (!r.group?.open) {
      edges.push({
        id: `${evs[evs.length - 1]!.key}->${r.key}`,
        source: evs[evs.length - 1]!.key,
        target: r.key,
        closure: true,
      });
    }
  }

  // 派发环：删 walk 给环成员生成的 锚→成员 放射边，改 锚→SubagentStop?→
  // task-notification 链；**收到返回通知才补 环→锚 闭环回边**——执行中的
  // 子代理（未返回）保持开环。
  for (const { anchor, members, closed } of rings) {
    const memberKeys = new Set(members.map((m) => m.key));
    for (let i = edges.length - 1; i >= 0; i--) {
      const e = edges[i]!;
      if (e.source === anchor.key && memberKeys.has(e.target)) edges.splice(i, 1);
    }
    let prev = anchor.key;
    for (const m of members) {
      edges.push({ id: `${prev}->${m.key}`, source: prev, target: m.key, vertical: prev !== anchor.key });
      prev = m.key;
    }
    if (closed) {
      edges.push({ id: `${prev}->${anchor.key}`, source: prev, target: anchor.key, closure: true });
    }
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// 节点渲染
// ---------------------------------------------------------------------------

type MindmapData = {
  node: LaidNode;
  flash: boolean;
  /** dispatch 节点的规则显示名（规则名映射由组件算好传入）。 */
  ruleName?: string;
  onToggle: (key: string) => void;
  /** 点击节点 → 右上角独立明细面板。 */
  onOpenDetail: (node: LaidNode) => void;
};
type MindmapFlowNode = Node<MindmapData, 'mindmap'>;

function tagCls(base: string): string {
  return `${base} rounded px-1 py-px text-[10px] leading-tight`;
}

/** 当前使用的 model 显著 tag（会话 SessionStart / 子代理 resolvedModel）。 */
function ModelTag({ model }: { model: string }) {
  const short = model.replace(/\[.*$/, '');
  return (
    <span
      className="rounded border border-indigo-500/40 bg-indigo-500/15 px-1 py-px text-[10px] font-medium leading-tight text-indigo-200"
      title={model}
    >
      {short}
    </span>
  );
}

function MindmapNode({ data }: NodeProps<MindmapFlowNode>) {
  const t = useT();
  const { node, flash, onToggle, onOpenDetail } = data;
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
    const head = g.preSession ? t('hooks.mindmap.preSession') : (g.prompt ?? '');
    const startedAt = g.events[0]?.createdAt;
    body = (
      <>
        <span className="block truncate text-xs text-neutral-100" title={g.prompt ?? head}>
          {head}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1">
          {g.preSession ? (
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
          {g.agentsDispatched > 0 && (
            <span className={tagCls('bg-fuchsia-900/40 text-fuchsia-300')}>
              {t('hooks.mindmap.agentDispatched', { n: g.agentsDispatched })}
            </span>
          )}
          {g.dispatches.length > 0 && (
            <span className={tagCls('bg-emerald-900/40 text-emerald-300')}>
              {t('hooks.mindmap.dispatchCount', { n: g.dispatches.length })}
            </span>
          )}
          {node.model && <ModelTag model={node.model} />}
          <span className="text-[10px] text-neutral-500">
            {t('catbar.items', { n: g.events.length })}
            {startedAt ? ` · ${formatTime(startedAt)}` : ''}
          </span>
        </span>
      </>
    );
  } else if (
    (node.kind === 'event' || node.kind === 'subagent' || node.kind === 'notification') &&
    node.event
  ) {
    const e = node.event;
    const isSub = node.kind === 'subagent';
    const summary = summarizeEvent(e);
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
          {node.kind === 'notification' && (
            <span className={tagCls('border border-teal-700/50 bg-teal-950/60 text-teal-300')}>
              {t('hooks.mindmap.notifyTag')}
            </span>
          )}
          {node.agentId && (
            <span className="text-[10px] text-neutral-500">agent …{node.agentId.slice(-8)}</span>
          )}
          {node.model && <ModelTag model={node.model} />}
          {node.agentRunning && (
            <span className={tagCls('bg-amber-900/50 text-amber-300')}>
              {t('hooks.mindmap.agentRunning')}
            </span>
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
  } else if (node.kind === 'rule') {
    body = (
      <span className="flex items-center gap-1">
        <span className={tagCls('bg-blue-900/40 text-blue-300')}>rule</span>
        <span
          className="truncate text-xs text-blue-200"
          title={node.ruleName ?? node.ruleId ?? ''}
        >
          {node.ruleName ?? (node.ruleId ? `#${node.ruleId.slice(0, 12)}` : '')}
        </span>
      </span>
    );
  } else if (node.kind === 'handler') {
    body = (
      <span className="flex items-center gap-1">
        <span className={tagCls('bg-purple-900/40 text-purple-300')}>handler</span>
        <span className="truncate text-xs text-purple-200">{node.handlerType}</span>
      </span>
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
  }

  return (
    <div
      className={cn(
        'flex w-[280px] cursor-pointer items-start gap-1 rounded-lg border border-white/[0.08] bg-neutral-900/95 px-2 py-1.5 shadow-mac transition-colors hover:border-white/[0.18]',
        node.highlight && 'ring-1 ring-amber-400/70',
        flash && 'weave-node-flash',
      )}
      title={node.highlight ? t('hooks.mindmap.pendingTip') : undefined}
      onClick={(e) => {
        e.stopPropagation(); // 阻止冒泡到画布的「关闭明细」
        onOpenDetail(node);
      }}
    >
      {/* 锚点分向（隐藏仅作连线锚定）：跨列层级右出左入；同列时序链底出顶入
          （防 U 型绕行大交叉）；闭环回边左侧出 → 根左侧入（走外侧通道） */}
      <Handle type="target" id="l" position={Position.Left} style={{ visibility: 'hidden' }} />
      <Handle type="target" id="t" position={Position.Top} style={{ visibility: 'hidden' }} />
      <Handle type="source" id="r" position={Position.Right} style={{ visibility: 'hidden' }} />
      <Handle type="source" id="b" position={Position.Bottom} style={{ visibility: 'hidden' }} />
      <Handle type="source" id="c" position={Position.Left} style={{ visibility: 'hidden' }} />
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
  focusGroupId,
}: {
  projectId: number;
  sessionId: string;
  sessions?: SessionRow[];
  onSelect?: (sessionId: string) => void;
  /**
   * 单组模式（任务视图组展开）：只渲染该 prompt 组、根默认展开，隐藏会话下拉
   * ——「思维导图与事件链的一个 prompt 放在一起」的合体形态。
   */
  focusGroupId?: string;
}) {
  const t = useT();
  const [events, setEvents] = useState<HookEventRow[] | null>(null);
  const [dispatches, setDispatches] = useState<HookDispatch[] | null>(null);
  const [ruleInfo, setRuleInfo] = useState<Map<string, RuleInfo>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  /** 新建指令入场闪烁的节点 key（900ms 摘除）。 */
  const [flashKey, setFlashKey] = useState<string | null>(null);
  /** 点击节点打开的右上角明细面板（点面板外关闭）。 */
  const [detailNode, setDetailNode] = useState<LaidNode | null>(null);
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
      setRuleInfo(
        new Map(rs.map((r) => [r.id, { name: r.name, handlerType: r.handler.type }])),
      );
    } catch {
      // daemon 未连：保持上次数据
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    setEvents(null);
    setDispatches(null);
    // 单组模式根默认展开（进入即见该 prompt 的事件序）；会话模式全折叠。
    setExpanded(focusGroupId ? new Set([`g:${focusGroupId}`]) : new Set());
    setDetailNode(null);
    void load();
  }, [load, focusGroupId]);

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
    // 游离指令组不进视图（无生命周期从属、扰乱顺序——由任务「待派发」区承载）；
    // 头部满一整批（≥300）说明窗口从半截 turn 切开——此时的 preSession 组是
    // 上一 turn 尾巴的伪影，隐藏（翻到底才是真会话引导）。
    const headTruncated = events.length >= 300;
    const all = buildLifecycleGroups(events, mine, HARNESS_LIFECYCLE.claude).filter(
      (g) => g.id !== ORPHAN_GROUP_ID && !(g.preSession && headTruncated),
    );
    return focusGroupId ? all.filter((g) => g.id === focusGroupId) : all;
  }, [events, dispatches, sessionId, focusGroupId]);

  // 会话当前 model：最新一条 SessionStart.raw.model（无则不显示 tag）。
  const sessionModel = useMemo(() => {
    if (!events) return undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const m = sessionModelOf(events[i]!);
      if (m) return m;
    }
    return undefined;
  }, [events]);

  const laid = useMemo(
    () => layoutMindmap(groups, expanded, ruleInfo, sessionModel),
    [groups, expanded, ruleInfo, sessionModel],
  );

  const onToggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
    // 用户每次展开/折叠 → 重挂画布并重新 fit（位置与缩放重算）
    setFitEpoch((n) => n + 1);
  }, []);

  const openDetail = useCallback((n: LaidNode) => setDetailNode(n), []);

  // 展开/折叠后重新计算位置与缩放：epoch++ → ReactFlow 重挂并 fitView
  // （maxZoom 1 防长列压糊）；初始 epoch=0 不 fit——保持顶部 0.75 可读视口。
  const [fitEpoch, setFitEpoch] = useState(0);

  const flowNodes: MindmapFlowNode[] = useMemo(
    () =>
      laid.nodes.map((n) => ({
        id: n.key,
        type: 'mindmap',
        position: { x: n.depth * COL_W, y: n.y },
        data: {
          node: n,
          flash: flashKey === n.key,
          ruleName: n.dispatch ? (ruleInfo.get(n.dispatch.ruleId)?.name ?? undefined) : undefined,
          onToggle,
          onOpenDetail: openDetail,
        },
        draggable: true,
      })),
    [laid.nodes, flashKey, ruleInfo, onToggle, openDetail],
  );
  // 箭头 + 流动动效 + 亮蓝加粗：显著表达调用方向；闭环回边（closure）虚线。
  // 锚点三分：同列时序链底出顶入（纵向直连）；跨列层级右出左入；闭环左侧回环。
  const flowEdges: Edge[] = useMemo(
    () =>
      laid.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.closure ? 'c' : e.vertical ? 'b' : 'r',
        targetHandle: e.closure ? 'l' : e.vertical ? 't' : 'l',
        type: 'smoothstep',
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        style: e.closure
          ? {
              stroke: 'rgba(96,165,250,0.55)',
              strokeWidth: 1.5,
              strokeDasharray: '7 5',
            }
          : { stroke: 'rgba(96,165,250,0.8)', strokeWidth: 2 },
      })),
    [laid.edges],
  );

  /** 右上角明细面板内容：按节点 kind 渲染该节点的完整信息。 */
  const renderDetail = (n: LaidNode): React.ReactNode => {
    const row = (label: string, value: React.ReactNode): React.ReactNode => (
      <p className="flex gap-2">
        <span className="shrink-0 text-neutral-500">{label}</span>
        <span className="min-w-0 break-all text-neutral-300">{value}</span>
      </p>
    );
    const json = (value: unknown): string =>
      value == null ? '—' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (n.kind === 'group' && n.group) {
      const g = n.group;
      return (
        <>
          <p className="whitespace-pre-wrap break-all text-neutral-100">
            {g.prompt ?? t('hooks.mindmap.preSession')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {g.open && (
              <span className="rounded bg-red-900/40 px-1 text-[10px] text-red-300">
                {t('hooks.mindmap.openTag')}
              </span>
            )}
            {g.subagentStops > 0 && (
              <span className="rounded bg-orange-900/40 px-1 text-[10px] text-orange-300">
                {t('hooks.mindmap.subagentCount', { n: g.subagentStops })}
              </span>
            )}
            {g.agentsDispatched > 0 && (
              <span className="rounded bg-fuchsia-900/40 px-1 text-[10px] text-fuchsia-300">
                {t('hooks.mindmap.agentDispatched', { n: g.agentsDispatched })}
              </span>
            )}
            {n.model && <ModelTag model={n.model} />}
          </div>
          {row(t('tasks.events', { n: g.events.length }), '')}
          {row(t('tasks.groupDispatches', { n: g.dispatches.length }), '')}
        </>
      );
    }
    if (
      (n.kind === 'event' || n.kind === 'subagent' || n.kind === 'notification') &&
      n.event
    ) {
      const e = n.event;
      const d = parseDetail(e.payload);
      return (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={tagCls(EVENT_TYPE_STYLES[e.eventType] ?? 'bg-neutral-800 text-neutral-300')}
            >
              {e.eventType}
            </span>
            {n.agentId && (
              <span className={tagCls('border border-orange-700/50 bg-orange-950/60 text-orange-300')}>
                agent …{n.agentId.slice(-8)}
              </span>
            )}
            {n.model && <ModelTag model={n.model} />}
            {n.agentRunning && (
              <span className={tagCls('bg-amber-900/50 text-amber-300')}>
                {t('hooks.mindmap.agentRunning')}
              </span>
            )}
            <span className="text-neutral-500">{formatTime(e.createdAt)}</span>
          </div>
          {/* 只给语义信息（prompt/tool/结束消息…），不展示 cwd/transcript 日志路径 */}
          <p className="whitespace-pre-wrap break-all text-neutral-100">{summarizeEvent(e)}</p>
          {d.toolInput != null && (
            <div>
              <p className="text-[9px] uppercase tracking-wide text-neutral-600">input</p>
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-all text-neutral-400">
                {json(d.toolInput)}
              </pre>
            </div>
          )}
          {d.toolResponse != null && (
            <div>
              <p className="text-[9px] uppercase tracking-wide text-neutral-600">response</p>
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-all text-neutral-400">
                {json(d.toolResponse)}
              </pre>
            </div>
          )}
        </>
      );
    }
    if (n.kind === 'dispatch' && n.dispatch) {
      const d = n.dispatch;
      return (
        <>
          <div className="flex items-center gap-2">
            <StatusDot status={d.status} />
            <span className="text-neutral-500">{formatTime(d.startedAt)}</span>
            {d.finishedAt && (
              <span className="text-neutral-600">→ {formatTime(d.finishedAt)}</span>
            )}
          </div>
          {row('rule', n.ruleName ?? d.ruleId)}
          <p className="whitespace-pre-wrap break-all text-neutral-100">{d.prompt}</p>
          {d.output && (
            <div>
              <p className="text-[9px] uppercase tracking-wide text-neutral-600">output</p>
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-all text-neutral-500">
                {d.output}
              </pre>
            </div>
          )}
          {d.error && <p className="whitespace-pre-wrap break-all text-red-400/80">{d.error}</p>}
        </>
      );
    }
    if (n.kind === 'rule') return row('rule', n.ruleName ?? n.ruleId ?? '—');
    if (n.kind === 'handler') return row('handler', n.handlerType ?? '—');
    return null;
  };

  return (
    <div className={cn('space-y-2', focusGroupId && 'h-full')}>
      {!focusGroupId && (
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-neutral-500">{t('hooks.mindmap.pickSession')}</label>
          <select
            value={sessionId}
            onChange={(e) => onSelect?.(e.target.value)}
            className="rounded-md border border-white/[0.08] bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
          >
            {(sessions ?? []).map((s) => (
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
      )}

      <div
        className={cn(
          'relative rounded-lg bg-neutral-950/40',
          focusGroupId ? 'h-full border-0' : 'h-96 border border-white/[0.06]',
        )}
        onClick={() => setDetailNode(null)}
      >
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
            key={fitEpoch}
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            // 单组动辄上百事件：初始停在顶部 0.75 倍（节点可读、连线可见）；
            // 展开/折叠（epoch>0）重挂后 fitView 全图（maxZoom 1 防糊）。
            fitView={!focusGroupId || fitEpoch > 0}
            fitViewOptions={{ maxZoom: 1, padding: 0.12 }}
            {...(focusGroupId && fitEpoch === 0
              ? { defaultViewport: { x: 24, y: 12, zoom: 0.75 } }
              : {})}
            minZoom={0.15}
            maxZoom={1.5}
            nodesDraggable
            nodesConnectable={false}
            deleteKeyCode={null}
            defaultEdgeOptions={{
              type: 'smoothstep',
              animated: true,
              markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
              style: { stroke: 'rgba(96,165,250,0.8)', strokeWidth: 2 },
            }}
          >
            <Background gap={14} size={1} color="rgba(255,255,255,0.06)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}

        {/* 右上角独立明细区：点节点打开；点面板外（画布空白/其它区域）关闭 */}
        {detailNode && (
          <div
            className="absolute right-2 top-2 z-20 flex max-h-[78%] w-80 flex-col overflow-hidden rounded-lg border border-white/[0.14] bg-neutral-900/95 shadow-mac"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-white/[0.08] px-3 py-2">
              <span className="text-xs font-semibold text-neutral-200">
                {t('hooks.mindmap.detailTitle')}
              </span>
              <button
                type="button"
                onClick={() => setDetailNode(null)}
                title={t('hooks.mindmap.closeDetail')}
                aria-label={t('hooks.mindmap.closeDetail')}
                className="ml-auto rounded p-0.5 text-neutral-500 transition-colors hover:text-neutral-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="space-y-2 overflow-y-auto px-3 py-2 text-[11px]">
              {renderDetail(detailNode)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
