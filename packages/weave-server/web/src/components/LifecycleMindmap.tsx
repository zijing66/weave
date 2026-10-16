import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, type HookDispatch, type HookEventRow, type SessionRow } from '@/lib/api';
import {
  EVENT_TYPE_STYLES,
  agentDispatchOf,
  formatTime,
  parseDetail,
  rawOf,
  sessionLabel,
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
import { HARNESS_LIFECYCLE, isCompactionEnd } from '@/components/tasks/lifecycle';
import { HARNESS_ORDER } from '@/lib/harness-meta';
import type { Harness, HarnessLifecycle } from '@weavecode/core/harness';
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
  | 'cluster'
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
  /** kind=cluster：簇内工具事件（收起态摘要与明细面板用）。 */
  clusterEvents?: HookEventRow[];
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

const COL_W = 400;
/** 渲染节点宽（与 MindmapNode 的 w-[280px] 对齐）——列间空隙 = COL_W - NODE_W。 */
const NODE_W = 280;
/** 节点估高（单 tag 行 + 摘要行 + padding）——视口居中坐标用，非布局值。 */
const NODE_H = 56;
/** 行距大于节点高度：父子边的 smoothstep 折线才有可见竖直段（DAG 连线）。 */
const ROW_H = 128;

/**
 * 簇内还有工具调用没返回（PreToolUse 未等到同 tool_use_id 的 PostToolUse）——
 * 未完成的簇不画尾回环（同派发环「未收到返回不闭环」口径）。缺 tool_use_id 的
 * 事件（非 claude 来源）退化按 Pre 计数多于 Post 判。
 */
function toolClusterRunning(events: readonly HookEventRow[]): boolean {
  const open = new Set<string>();
  let idless = 0;
  for (const e of events) {
    const id = rawOf(e).tool_use_id;
    if (typeof id !== 'string' || !id) {
      idless += e.eventType === 'PreToolUse' ? 1 : -1;
      continue;
    }
    if (e.eventType === 'PostToolUse') open.delete(id);
    else open.add(id);
  }
  return open.size > 0 || idless > 0;
}

/** SessionStart 携带的会话 model（其余事件类型无 model 字段）。 */
function sessionModelOf(event: HookEventRow): string | undefined {
  if (event.eventType !== 'SessionStart') return undefined;
  const m = rawOf(event).model;
  return typeof m === 'string' && m ? m : undefined;
}

/** 边：closure=true 是闭环回边（末事件 → prompt 根，成环，左出左入走外侧
 *  通道，实线）；vertical=true 是同列时序链（底出顶入，防跨列锚点绕行交叉）；
 *  dashed=true 是弱化从属连线（虚线，展开簇的首边）；clusterLoop / ringLoop
 *  是「子回父」环（簇尾回环虚线、派发环回锚实线）：子端左连接点出（与父
 *  节点邻近）、列间空隙手算折点、父端右 78% 入点（与父的出点错开防交叉）
 *  ——内置 smoothstep 会横穿成员列，waypoints 绕行才成环。静态描边。 */
export interface LaidEdge {
  id: string;
  source: string;
  target: string;
  closure?: boolean;
  vertical?: boolean;
  dashed?: boolean;
  clusterLoop?: boolean;
  ringLoop?: boolean;
  waypoints?: { x: number; y: number }[];
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
  lifecycle: HarnessLifecycle = HARNESS_LIFECYCLE[HARNESS_ORDER[0] ?? 'claude'],
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
    clusterEvents?: HookEventRow[];
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
        const emit = (e: HookEventRow): void => {
          const eKey = `e:${e.id}`;
          const hits = g.dispatches.filter((d) => d.eventId === e.id);
          const kids = expanded.has(eKey) ? hitChain(e.id, hits) : [];
          const isSub = e.eventType === lifecycle.subagentStop;
          const ad = agentDispatchOf(e);
          const notif = taskNotificationOf(e);

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
              return;
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
              return;
            }
            // 首事件即 SubagentStop（无前驱）：退化并入主链
          }
          chain.push(node);
          nodesByRow.set(e.id, node);
          prevRow = e;
        };
        // 连续 Pre/PostToolUse（无派发证据、无命中指令）折成簇默认收起——
        // 工具调用是事件链噪音主体，点簇展开还原为成员事件（时序竖链）。
        let buf: HookEventRow[] = [];
        const flushBuf = (): void => {
          if (buf.length === 0) return;
          if (buf.length >= 2) {
            const cKey = `c:${buf[0]!.id}`;
            chain.push({
              key: cKey,
              kind: 'cluster',
              children: expanded.has(cKey)
                ? buf.map((ev) => ({
                    key: `e:${ev.id}`,
                    kind: 'event' as const,
                    event: ev,
                    children: [],
                    hasPotential: false,
                    highlight: false,
                  }))
                : [],
              hasPotential: true,
              highlight: false,
              clusterEvents: buf,
            });
            prevRow = null; // 簇是主链断点：其后 SubagentStop 前驱不可见 → 退化进主链
          } else {
            emit(buf[0]!); // 孤立工具事件不折（与散事件同形）
          }
          buf = [];
        };
        for (const e of g.events) {
          const isToolNoise =
            (e.eventType === 'PreToolUse' || e.eventType === 'PostToolUse') &&
            !agentDispatchOf(e) &&
            !g.dispatches.some((d) => d.eventId === e.id);
          if (isToolNoise) {
            buf.push(e);
            continue;
          }
          flushBuf();
          emit(e);
        }
        flushBuf();
        // 环成员挂锚前部（分叉语义，先于命中链子树展示）。
        // 派发即生子节点：锚下尚无成员且子代理执行中 → 先生成占位子节点
        //（SubagentStop/task-notification 到达后由真实事件节点替换）。
        for (const [anchor, members] of ringMembers) {
          if (members.length === 0 && anchor.agentRunning) {
            members.push({
              key: `${anchor.key}:agent`,
              kind: 'subagent',
              children: [],
              hasPotential: false,
              highlight: false,
              agentId: anchor.agentId,
              model: anchor.model,
              agentRunning: true,
            });
          }
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
      clusterEvents: n.clusterEvents,
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
      (c) =>
        c.kind === 'event' ||
        c.kind === 'cluster' ||
        c.kind === 'subagent' ||
        c.kind === 'notification',
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
  // 簇展开：簇→成员的放射边改竖链（成员同列时序，底出顶入，防绕行）。
  const collectClusters = (n: TNode): TNode[] => [
    ...(n.kind === 'cluster' ? [n] : []),
    ...n.children.flatMap(collectClusters),
  ];
  const yOf = new Map(nodes.map((n) => [n.key, n.y]));
  const depthOf = new Map(nodes.map((n) => [n.key, n.depth]));
  for (const c of roots.flatMap(collectClusters)) {
    if (c.children.length === 0) continue;
    const kidKeys = new Set(c.children.map((k) => k.key));
    for (let i = edges.length - 1; i >= 0; i--) {
      const e = edges[i]!;
      if (e.source === c.key && kidKeys.has(e.target)) edges.splice(i, 1);
    }
    // 首尾虚线（簇↔子节点的从属连线弱化）+ 成员间实线时序链，成下探闭环。
    edges.push({
      id: `${c.key}->${c.children[0]!.key}`,
      source: c.key,
      target: c.children[0]!.key,
      dashed: true,
    });
    for (let i = 0; i + 1 < c.children.length; i++) {
      edges.push({
        id: `${c.children[i]!.key}->${c.children[i + 1]!.key}`,
        source: c.children[i]!.key,
        target: c.children[i + 1]!.key,
        vertical: true,
      });
    }
    // 尾回环手算折点：末成员**左出**（与父节点邻近的连接点——左缘直对
    // 簇列，进空隙即朝父方向）→ 空隙内上行至簇入点高 → 左入簇右 78%。
    // 内置 smoothstep 会横穿成员列（水平段固定在 target 高度），手算绕行
    // 才成环。y 对齐 handle 实际锚点：源=节点中线（'c' 左出中点），
    // 目标=右缘 78%（'rt'），首尾段才水平不斜。
    // 簇内还有在飞的工具调用 → 不画回环（回路虚线得等真返回）。
    if (toolClusterRunning(c.clusterEvents ?? [])) continue;
    const lastKid = c.children[c.children.length - 1]!;
    const ys = (yOf.get(lastKid.key) ?? 0) + NODE_H / 2;
    const yt = (yOf.get(c.key) ?? 0) + NODE_H * 0.78;
    const cDepth = depthOf.get(c.key) ?? 0;
    const gapX = cDepth * COL_W + NODE_W + (COL_W - NODE_W) / 2;
    edges.push({
      id: `${lastKid.key}->${c.key}`,
      source: lastKid.key,
      target: c.key,
      clusterLoop: true,
      waypoints: [
        { x: gapX, y: ys },
        { x: gapX, y: yt },
      ],
    });
  }

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
      // 回锚与工具调用簇环同构：尾成员左出（与锚邻近）→ 空隙上行/下行 →
      // 锚右 78% 入（与锚的出点错开）；实线（clusterLoop 才虚线）。
      const aDepth = depthOf.get(anchor.key) ?? 0;
      const ys = (yOf.get(prev) ?? 0) + NODE_H / 2;
      const yt = (yOf.get(anchor.key) ?? 0) + NODE_H * 0.78;
      const gapX = aDepth * COL_W + NODE_W + (COL_W - NODE_W) / 2;
      edges.push({
        id: `${prev}->${anchor.key}`,
        source: prev,
        target: anchor.key,
        ringLoop: true,
        waypoints: [
          { x: gapX, y: ys },
          { x: gapX, y: yt },
        ],
      });
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
  /** 组根节点挂「待答」tag（会话被阻塞问题挂起，调用方判定）→ 点击远程作答。 */
  answerable?: boolean;
  onOpenAnswer?: () => void;
};
type MindmapFlowNode = Node<MindmapData, 'mindmap'>;

/** 执行中的组 id 集合（会话状态机是调用方的权威，本组件不自拉推断）。 */
const RunningGroupsCtx = createContext<ReadonlySet<string>>(new Set());

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
  const runningGroups = useContext(RunningGroupsCtx);
  const { node, flash, onToggle, onOpenDetail, answerable, onOpenAnswer } = data;
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
          {g.open &&
            (runningGroups.has(g.id) ? (
              <span className={tagCls('bg-emerald-900/40 text-emerald-300')}>
                {t('hooks.mindmap.runningTag')}
              </span>
            ) : (
              <span className={tagCls('bg-red-900/40 text-red-300')}>
                {t('hooks.mindmap.openTag')}
              </span>
            ))}
          {answerable && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenAnswer?.();
              }}
              className={tagCls(
                'bg-amber-900/50 font-medium text-amber-300 transition-colors hover:bg-amber-800/60 hover:text-amber-200',
              )}
            >
              {t('tasks.answerPendingTag')}
            </button>
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
    const compacted = isCompactionEnd(e.source, e.eventType, rawOf(e).source);
    body = (
      <>
        <span className="flex flex-wrap items-center gap-1">
          <span
            className={tagCls(EVENT_TYPE_STYLES[e.eventType] ?? 'bg-neutral-800 text-neutral-300')}
          >
            {e.eventType}
          </span>
          {compacted && (
            <span className={tagCls('bg-amber-900/40 text-amber-300')}>
              {t('hooks.mindmap.compactTag')}
            </span>
          )}
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
  } else if (node.kind === 'cluster' && node.clusterEvents) {
    const evs = node.clusterEvents;
    const counts = new Map<string, number>();
    for (const e of evs) {
      const name = parseDetail(e.payload).toolName ?? e.eventType;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const all = ranked.map(([n, c]) => `${n} ×${c}`).join(' · ');
    const top = ranked
      .slice(0, 3)
      .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
      .join(' · ');
    body = (
      <>
        <span className="flex flex-wrap items-center gap-1">
          <span className={tagCls('bg-amber-900/40 text-amber-300')}>
            {t('hooks.mindmap.toolCluster')}
          </span>
          <span className="text-[10px] text-neutral-400">×{evs.length}</span>
          <span className="text-[10px] text-neutral-500">{formatTime(evs[0]!.createdAt)}</span>
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-neutral-400" title={all}>
          {top}
          {ranked.length > 3 ? ` · +${ranked.length - 3}` : ''}
        </span>
      </>
    );
  } else if (node.kind === 'subagent' && !node.event) {
    // 占位子节点：派发已发出、子代理事件（SubagentStop/返回通知）未到——
    // 派发即在锚下生出子节点，真实事件到达后替换，收到通知才闭环
    body = (
      <>
        <span className="flex flex-wrap items-center gap-1">
          <span className={tagCls('border border-orange-700/50 bg-orange-950/60 text-orange-300')}>
            subagent
          </span>
          {node.agentId && (
            <span className="text-[10px] text-neutral-500">agent …{node.agentId.slice(-8)}</span>
          )}
          {node.model && <ModelTag model={node.model} />}
          {node.agentRunning && (
            <span className={tagCls('bg-amber-900/50 text-amber-300')}>
              {t('hooks.mindmap.agentRunning')}
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-[11px] text-neutral-400">
          {t('hooks.mindmap.agentPending')}
        </span>
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
          （防 U 型绕行大交叉）；closure 回边左侧出 → 根左侧入（走外侧通道）；
          簇右缘出在中点、回环入在 78%（同侧出进错开成 2 个连接点，防交叉） */}
      <Handle type="target" id="l" position={Position.Left} style={{ visibility: 'hidden' }} />
      <Handle type="target" id="t" position={Position.Top} style={{ visibility: 'hidden' }} />
      <Handle
        type="target"
        id="rt"
        position={Position.Right}
        style={{ visibility: 'hidden', top: '78%' }}
      />
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

/** 折点序列 → 圆角折线 path（拐点用二次贝塞尔，圆角半径受邻段半长约束）。 */
function polylinePath(pts: { x: number; y: number }[], r = 14): string {
  let d = `M${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!;
    const p = pts[i]!;
    const b = pts[i + 1]!;
    const len = (u: { x: number; y: number }, v: { x: number; y: number }): number =>
      Math.hypot(v.x - u.x, v.y - u.y);
    const rr = Math.min(r, len(a, p) / 2, len(p, b) / 2);
    const enter = { x: p.x + (a.x - p.x) * (rr / len(a, p)), y: p.y + (a.y - p.y) * (rr / len(a, p)) };
    const exit = { x: p.x + (b.x - p.x) * (rr / len(p, b)), y: p.y + (b.y - p.y) * (rr / len(p, b)) };
    d += ` L${enter.x} ${enter.y} Q${p.x} ${p.y} ${exit.x} ${exit.y}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d} L${last.x} ${last.y}`;
}

/** 自定义边：按 layout 给出的 waypoints 画折线（簇尾回环——内置 smoothstep
 *  的右→右折线会横穿成员列，手算绕行点才能成环）。 */
function WaypointEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  style,
  data,
}: EdgeProps): React.ReactElement {
  const waypoints = (data?.waypoints as { x: number; y: number }[] | undefined) ?? [];
  const pts = [{ x: sourceX, y: sourceY }, ...waypoints, { x: targetX, y: targetY }];
  return (
    <BaseEdge
      id={id}
      path={polylinePath(pts)}
      markerEnd={markerEnd}
      style={style}
    />
  );
}

const edgeTypes = { waypoint: WaypointEdge };

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

/** `weave:hook` 事件里我们实际读的字段（/events 的信封见 lib/sse.ts 的 SseFrame）。 */
interface HookFrame {
  kind?: string;
  dispatchId?: number;
}

export function LifecycleMindmap({
  projectId,
  sessionId,
  sessions,
  harness,
  onSelect,
  focusGroupId,
  focusGroup,
  running,
  answerable,
  onOpenAnswer,
}: {
  projectId: number;
  sessionId: string;
  sessions?: SessionRow[];
  /** 会话归属 harness——分组/画布生命周期表按它取（D7 表驱动）；缺省回落名表首项。 */
  harness?: Harness | null;
  onSelect?: (sessionId: string) => void;
  /**
   * 单组模式（任务视图组展开）：只渲染该 prompt 组、根默认展开，隐藏会话下拉
   * ——「思维导图与事件链的一个 prompt 放在一起」的合体形态。
   */
  focusGroupId?: string;
  /**
   * 单组模式的权威组切片（调用方分组结果直传）：组内事件可能整段早于本组件
   * 自拉的最新 300 窗口（历史 turn / 会话引导组），按 id 过滤会落空误报空态。
   */
  focusGroup?: LifecycleGroup;
  /** 会话正在干活（最新 turn 未 Stop = 执行中）：组头 tag 显「执行中」而非「未正常结束」。 */
  running?: boolean;
  /** 该组根节点是否挂「待答」tag（调用方按会话待答态 + 该组是否被阻塞的
   *  当前组判定；点击 tag 打开调用方的作答弹窗——组件不自持问答面）。 */
  answerable?: boolean;
  /** 点根节点待答 tag 的回调（打开远程作答弹窗）。 */
  onOpenAnswer?: () => void;
}) {
  const t = useT();
  /** 生命周期表按会话 harness 取（D7——分组差异是 harness 知识，不写死 claude）。 */
  const lifecycle = HARNESS_LIFECYCLE[harness ?? HARNESS_ORDER[0] ?? 'claude'];
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
      const frame = (ev as CustomEvent<HookFrame>).detail;
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
    // 单组直传：调用方的组就是权威切片（含翻页加载的更早事件），
    // 不再按本组件自拉的最新 300 窗口重建——历史组 id 不在窗口内会过滤落空。
    if (focusGroupId && focusGroup) return [focusGroup];
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
    const all = buildLifecycleGroups(events, mine, lifecycle).filter(
      (g) => g.id !== ORPHAN_GROUP_ID && !(g.preSession && headTruncated),
    );
    return focusGroupId ? all.filter((g) => g.id === focusGroupId) : all;
  }, [events, dispatches, sessionId, focusGroupId, focusGroup, lifecycle]);

  /** 执行中的组（仅最新组——历史 open 组是中断落库，不是进行中）。 */
  const runningGroups = useMemo<ReadonlySet<string>>(() => {
    const latest = groups[groups.length - 1];
    return running && latest ? new Set([latest.id]) : new Set<string>();
  }, [groups, running]);

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
    () => layoutMindmap(groups, expanded, ruleInfo, sessionModel, lifecycle),
    [groups, expanded, ruleInfo, sessionModel, lifecycle],
  );

  const instRef = useRef<ReactFlowInstance<MindmapFlowNode, Edge> | null>(null);
  /** 最近一次 toggle 的节点 key——布局重算后把该节点平移至视口中心。 */
  const centerKeyRef = useRef<string | null>(null);

  const onToggle = useCallback((key: string) => {
    centerKeyRef.current = key;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const openDetail = useCallback((n: LaidNode) => setDetailNode(n), []);

  // 展开/折叠重布局后：把被操作的节点置于视口中心（替代全图 fitView——
  // 缩到全图会把刚展开的细节压到边角）。保持当前 zoom 只平移（setCenter
  // 缺省 zoom 会跳 maxZoom，必须显式传）；key 一次性消费，SSE 重拉不重复居中。
  useEffect(() => {
    const key = centerKeyRef.current;
    if (!key) return;
    centerKeyRef.current = null;
    const n = laid.nodes.find((x) => x.key === key);
    const inst = instRef.current;
    if (!n || !inst) return;
    inst.setCenter(n.depth * COL_W + NODE_W / 2, n.y + NODE_H / 2, {
      zoom: inst.getZoom(),
      duration: 250,
    });
  }, [laid]);

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
          answerable: n.kind === 'group' && (answerable ?? false),
          onOpenAnswer,
        },
        draggable: true,
      })),
    [laid.nodes, flashKey, ruleInfo, onToggle, openDetail, answerable, onOpenAnswer],
  );
  // 箭头 + 亮蓝加粗：显著表达调用方向。锚点四分：同列时序链底出顶入；
  // 跨列层级右出左入；closure（组闭环）左出左入走外侧通道、实线成环；
  // 簇/派发「子回父」环（clusterLoop 虚线 / ringLoop 实线）子端左出、
  // waypoints 走列间空隙、父端右 78% 入点错开。静态描边（无流光）。
  const flowEdges: Edge[] = useMemo(
    () =>
      laid.edges.map((e) => ({
        id: e.id,
        ...(e.waypoints ? { data: { waypoints: e.waypoints } } : {}),
        source: e.source,
        target: e.target,
        sourceHandle: e.closure || e.clusterLoop || e.ringLoop ? 'c' : e.vertical ? 'b' : 'r',
        targetHandle: e.closure ? 'l' : e.clusterLoop || e.ringLoop ? 'rt' : e.vertical ? 't' : 'l',
        type: e.waypoints ? 'waypoint' : 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        style: e.dashed || e.clusterLoop
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
            {g.open &&
              (runningGroups.has(g.id) ? (
                <span className="rounded bg-emerald-900/40 px-1 text-[10px] text-emerald-300">
                  {t('hooks.mindmap.runningTag')}
                </span>
              ) : (
                <span className="rounded bg-red-900/40 px-1 text-[10px] text-red-300">
                  {t('hooks.mindmap.openTag')}
                </span>
              ))}
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
    if (n.kind === 'subagent' && !n.event) {
      // 占位子节点明细：派发证据（agentId/model）+ 执行状态
      return (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={tagCls('border border-orange-700/50 bg-orange-950/60 text-orange-300')}
            >
              subagent
            </span>
            {n.agentId && (
              <span className="text-neutral-500">agent …{n.agentId.slice(-8)}</span>
            )}
            {n.model && <ModelTag model={n.model} />}
            {n.agentRunning && (
              <span className={tagCls('bg-amber-900/50 text-amber-300')}>
                {t('hooks.mindmap.agentRunning')}
              </span>
            )}
          </div>
          <p className="text-neutral-400">{t('hooks.mindmap.agentPending')}</p>
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
            {isCompactionEnd(e.source, e.eventType, rawOf(e).source) && (
              <span className={tagCls('bg-amber-900/40 text-amber-300')}>
                {t('hooks.mindmap.compactTag')}
              </span>
            )}
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
    if (n.kind === 'cluster' && n.clusterEvents) {
      const evs = n.clusterEvents;
      const counts = new Map<string, number>();
      for (const e of evs) {
        const name = parseDetail(e.payload).toolName ?? e.eventType;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      return (
        <>
          <div className="flex flex-wrap gap-1.5">
            {[...counts.entries()].map(([name, c]) => (
              <span key={name} className="rounded bg-amber-900/40 px-1 text-[10px] text-amber-300">
                {name} ×{c}
              </span>
            ))}
          </div>
          <p className="text-neutral-500">
            {formatTime(evs[0]!.createdAt)} → {formatTime(evs[evs.length - 1]!.createdAt)}
          </p>
          <ul className="space-y-1">
            {evs.map((e) => (
              <li key={e.id} className="truncate text-neutral-300" title={summarizeEvent(e)}>
                <span className="text-neutral-600">{formatTime(e.createdAt)}</span>{' '}
                {summarizeEvent(e) || e.eventType}
              </li>
            ))}
          </ul>
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
    <RunningGroupsCtx.Provider value={runningGroups}>
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
                {sessionLabel(s.title, s.sessionId)}
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
        {events === null && !focusGroup ? (
          <div className="flex h-full items-center justify-center text-xs text-neutral-500">
            {t('hooks.loading')}
          </div>
        ) : flowNodes.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-neutral-500">
            {t('hooks.mindmap.empty')}
          </div>
        ) : (
          <ReactFlow
            onInit={(inst) => {
              instRef.current = inst as ReactFlowInstance<MindmapFlowNode, Edge>;
            }}
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            // 单组动辄上百事件：首帧停在顶部 0.75 倍（节点可读、连线可见）；
            // 会话模式首帧 fitView 全图。之后的展开/折叠由 setCenter 把被
            // 操作节点平移到视口中心（保持 zoom），不重挂不全图缩放。
            fitView={!focusGroupId}
            fitViewOptions={{ maxZoom: 1, padding: 0.12 }}
            {...(focusGroupId ? { defaultViewport: { x: 24, y: 12, zoom: 0.75 } } : {})}
            minZoom={0.15}
            maxZoom={1.5}
            nodesDraggable
            nodesConnectable={false}
            deleteKeyCode={null}
            defaultEdgeOptions={{
              type: 'smoothstep',
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
    </RunningGroupsCtx.Provider>
  );
}
