import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  api,
  CLAUDE_HOOK_EVENTS,
  INJECTABLE_HOOK_EVENTS,
  hookSourceHarness,
  normalizeHookRuleSource,
  type HandlerConfig,
  type HookDispatch,
  type HookDispatchStatus,
  type HookRule,
  type HookRuleFilter,
  type HookRuleInput,
  type HookRuleSource,
  type ProjectRow,
  type SessionRow,
} from '@/lib/api';
import type { Harness } from '@weave/core/harness';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { HooksPluginsSection } from '@/components/HooksPluginsSection';
import { LifecycleMindmap } from '@/components/LifecycleMindmap';
import { getDispatchDrag, setDispatchDrag } from '@/lib/dnd';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';
import {
  Bot,
  Check,
  Copy,
  FileText,
  GitBranch,
  Hand,
  Inbox,
  Loader2,
  Pencil,
  Play,
  Plus,
  Puzzle,
  ScrollText,
  Send,
  Trash2,
  Webhook,
  Wrench,
  Workflow,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Weave 规则面板：链路图（事件源 → 规则 → 处理器 + 指令管理列）+ 规则列表。
 * 全局形态 = 纯拓扑（源→规则→处理器）+ 指令管理，不画会话；项目形态额外带
 * 本项目会话列（指令投送目标，拖拽/节点选择会话执行）。指令不与会话连线——
 * 会话关联的可视化最终体现在任务视图的图中。实时高亮与指令刷新挂在 App
 * 转发的 `weave:hook` window 事件上。
 * 双形态：全局 = 插件管理（安装/卸载 + 默认启用开关）；项目 = 项目启用列表（effective）。
 */

/** SSE hook 帧（App 的 onmessage 解析后转发）。 */
interface HookFrame {
  type?: string;
  kind?: string;
  ruleId?: string;
  dispatchId?: number;
}

type FlowMode = 'project' | 'global';

const HANDLER_TYPES: HandlerConfig['type'][] = ['log', 'webhook', 'inject', 'manual', 'plugin'];

const HANDLER_LABEL_KEYS: Record<HandlerConfig['type'], MessageKey> = {
  log: 'hooks.handler.log',
  webhook: 'hooks.handler.webhook',
  inject: 'hooks.handler.inject',
  manual: 'hooks.handler.manual',
  plugin: 'hooks.handler.plugin',
};

const HANDLER_TIP_KEYS: Record<HandlerConfig['type'], MessageKey> = {
  log: 'hooks.handlerLogTip',
  webhook: 'hooks.handlerWebhookTip',
  inject: 'hooks.handlerInjectTip',
  manual: 'hooks.handlerManualTip',
  plugin: 'hooks.handlerPluginTip',
};

const HANDLER_ICONS: Record<HandlerConfig['type'], LucideIcon> = {
  log: ScrollText,
  webhook: Webhook,
  inject: Bot,
  manual: Hand,
  plugin: Puzzle,
};

/** 规则来源的两种可编辑形（webhook 形一期不开放编辑）。 */
const SOURCE_KINDS: Array<HookRuleSource['kind']> = ['hook-event', 'claude-event'];

const HARNESS_OPTIONS: Array<Harness | 'any'> = ['claude', 'codex', 'any'];

const STATUS_KEY: Record<HookDispatchStatus, MessageKey> = {
  pending: 'hooks.status.pending',
  injected: 'hooks.status.injected',
  running: 'hooks.status.running',
  succeeded: 'hooks.status.succeeded',
  failed: 'hooks.status.failed',
  timeout: 'hooks.status.timeout',
};

const STATUS_CLASS: Record<HookDispatchStatus, string> = {
  pending: 'bg-neutral-800 text-neutral-400',
  injected: 'bg-blue-900/40 text-blue-300',
  running: 'bg-cyan-900/40 text-cyan-300',
  succeeded: 'bg-emerald-900/40 text-emerald-300',
  failed: 'bg-red-900/40 text-red-300',
  timeout: 'bg-orange-900/40 text-orange-300',
};

/** 面板内所有用户操作的成功/失败提示统一走这里。 */
function errMsg(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // apiFetch 抛出 `400 {"error":"…"}` — 服务端 message 优先展示。
  const brace = raw.indexOf('{');
  if (brace >= 0 && raw.trimEnd().endsWith('}')) {
    try {
      const parsed = JSON.parse(raw.slice(brace)) as { error?: string; message?: string };
      if (parsed.error) return parsed.error;
      if (parsed.message) return parsed.message;
    } catch {
      // not JSON — fall through to the raw text
    }
  }
  return raw;
}

function splitList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 与现有面板一致的时间格式（TaskView 的 formatTime）。 */
function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

/** 指令列排序：pending/injected（可执行的）优先，其次按 id 倒序。 */
function sortPool(list: HookDispatch[]): HookDispatch[] {
  const rank = (d: HookDispatch) => (d.status === 'pending' || d.status === 'injected' ? 0 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || b.id - a.id);
}

function sessionLabel(s: SessionRow): string {
  return s.title ?? s.sessionId.slice(0, 8);
}

/** App 在规则增删改后收到此事件 → 刷新分类卡计数。 */
function notifyRulesChanged(): void {
  window.dispatchEvent(new Event('weave:rules-changed'));
}

// ---------------------------------------------------------------------------
// 链路图节点
// ---------------------------------------------------------------------------

type SourceData = { event: string };
type RuleData = {
  rule: HookRule;
  scopeLabel: string;
  onToggle: (id: string, enabled: boolean) => void;
};
type HandlerData = { handlerType: HandlerConfig['type']; count: number };
type SessionData = {
  sessionId: string;
  label: string;
  /** 改名输入的初值（null 标题 → 空串）。 */
  titleValue: string;
  pendingTitle: string | null;
  projectLabel: string | null;
  onRename: (sessionId: string, title: string) => void;
  onDropPrompt: (dispatchId: number, sessionId: string, label: string) => void;
};
type PlaceholderData = { label: string };
type DispatchData = {
  dispatch: HookDispatch;
  ruleName: string;
  /** 节点「选择会话 ▶」下拉的候选项（画布内会话列前 30 条）。 */
  sessions: Array<{ sessionId: string; label: string }>;
  /** dispatch.created 入场波纹（900ms）。 */
  ripple: boolean;
  onRun: (dispatchId: number, sessionId: string, label: string) => void;
};

type SourceFlowNode = Node<SourceData, 'source'>;
type RuleFlowNode = Node<RuleData, 'rule'>;
type HandlerFlowNode = Node<HandlerData, 'handler'>;
type SessionFlowNode = Node<SessionData, 'session'>;
type PlaceholderFlowNode = Node<PlaceholderData, 'ph'>;
type DispatchFlowNode = Node<DispatchData, 'dispatch'>;
type FlowNode =
  | SourceFlowNode
  | RuleFlowNode
  | HandlerFlowNode
  | SessionFlowNode
  | PlaceholderFlowNode
  | DispatchFlowNode;
type FlowEdge = Edge<{ ruleId: string }>;

function SourceNode({ data }: NodeProps<SourceFlowNode>) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-neutral-900/90 px-2.5 py-1.5 shadow-mac-sm">
      <Zap className="h-3 w-3 shrink-0 text-amber-400" />
      <span className="text-[11px] font-medium text-neutral-200">{data.event}</span>
      <Handle type="source" position={Position.Right} className="!bg-amber-400/80" />
    </div>
  );
}

function RuleNode({ data }: NodeProps<RuleFlowNode>) {
  const t = useT();
  const rule = data.rule;
  const HandlerIcon = HANDLER_ICONS[rule.handler.type];
  const src = normalizeHookRuleSource(rule.source);
  const eventLabel = src.kind === 'webhook' ? src.routeId : src.event;
  return (
    <div
      className={cn(
        'w-[220px] rounded-lg border bg-neutral-900/90 px-3 py-2 shadow-mac-sm transition-opacity',
        rule.enabled ? 'border-blue-500/40' : 'border-white/[0.08] opacity-60',
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-blue-400/80" />
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-100">
          {rule.name}
        </span>
        <Switch
          checked={rule.enabled}
          title={t('hooks.toggleTip', { name: rule.name })}
          onChange={(v) => data.onToggle(rule.id, v)}
        />
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <Badge variant="command" className="gap-1">
          <HandlerIcon className="h-3 w-3" />
          {t(HANDLER_LABEL_KEYS[rule.handler.type])}
        </Badge>
        <span className="truncate text-[10px] text-neutral-500" title={data.scopeLabel}>
          {eventLabel} · {data.scopeLabel}
        </span>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-blue-400/80" />
    </div>
  );
}

function HandlerNode({ data }: NodeProps<HandlerFlowNode>) {
  const t = useT();
  const Icon = HANDLER_ICONS[data.handlerType];
  return (
    <div className="flex w-[170px] items-center gap-2 rounded-lg border border-white/[0.08] bg-neutral-900/90 px-3 py-2 shadow-mac-sm">
      <Handle type="target" position={Position.Left} className="!bg-blue-400/80" />
      <Icon className="h-3.5 w-3.5 shrink-0 text-purple-300" />
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-neutral-200">
        {t(HANDLER_LABEL_KEYS[data.handlerType])}
      </span>
      <span className="text-[10px] text-neutral-500">{data.count}</span>
      <Handle type="source" position={Position.Right} className="!bg-blue-400/80" />
    </div>
  );
}

function SessionNode({ data }: NodeProps<SessionFlowNode>) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [dropping, setDropping] = useState(false);

  const startEdit = (): void => {
    setDraft(data.titleValue);
    setEditing(true);
  };
  const commit = (): void => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== data.titleValue) data.onRename(data.sessionId, next);
  };

  return (
    <div
      className={cn(
        'w-[210px] rounded-lg border bg-neutral-900/90 px-3 py-2 shadow-mac-sm transition-colors',
        dropping ? 'border-blue-400 ring-2 ring-blue-400/60' : 'border-white/[0.08]',
      )}
      onDragEnter={() => setDropping(true)}
      onDragLeave={() => setDropping(false)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        const id = getDispatchDrag(e.dataTransfer);
        if (id !== null) data.onDropPrompt(id, data.sessionId, data.label);
      }}
    >
      <Handle type="target" position={Position.Left} className="!bg-blue-400/80" />
      <div className="flex items-center gap-2">
        {editing ? (
          <input
            autoFocus
            className="nodrag min-w-0 flex-1 rounded bg-neutral-800 px-1 py-0.5 text-[11px] text-neutral-100 outline-none ring-1 ring-blue-500"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setEditing(false);
            }}
            placeholder={t('hooks.renamePlaceholder')}
          />
        ) : (
          <span
            className="min-w-0 flex-1 cursor-text truncate text-[11px] font-medium text-neutral-200"
            title={t('hooks.renameTip')}
            onDoubleClick={startEdit}
          >
            {data.label}
          </span>
        )}
        <button
          type="button"
          className="nodrag shrink-0 rounded p-0.5 text-neutral-500 transition-colors hover:text-neutral-200"
          title={t('hooks.renameTip')}
          onClick={startEdit}
        >
          <Pencil className="h-3 w-3" />
        </button>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {data.projectLabel && <Badge variant="default">{data.projectLabel}</Badge>}
        {data.pendingTitle && <Badge variant="warning">{t('hooks.pendingTitle')}</Badge>}
      </div>
    </div>
  );
}

function PlaceholderNode({ data }: NodeProps<PlaceholderFlowNode>) {
  return (
    <div className="rounded-lg border border-dashed border-white/[0.12] bg-neutral-900/60 px-3 py-2 text-[11px] text-neutral-500">
      {data.label}
    </div>
  );
}

/**
 * 指令节点（画布第 5 列）：状态徽标 + 规则名 + 时间 + prompt 两行 clamp。
 * 整卡 HTML5 draggable（拖到会话节点执行）；悬停出「选择会话 ▾ + ▶」，走既有
 * pendingRun 确认条；复制为节点本地状态。
 */
function DispatchNode({ data }: NodeProps<DispatchFlowNode>) {
  const t = useT();
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);
  const d = data.dispatch;

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(d.prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (permissions / non-secure context)
    }
  };

  const run = (): void => {
    const s = data.sessions.find((x) => x.sessionId === draft);
    if (s) data.onRun(d.id, s.sessionId, s.label);
  };

  return (
    <div
      draggable
      onDragStart={(e) => setDispatchDrag(e.dataTransfer, d.id)}
      className={cn(
        'group nodrag w-[230px] cursor-grab rounded-lg border border-white/[0.08] bg-neutral-900/90 px-2.5 py-2 shadow-mac-sm active:cursor-grabbing',
        data.ripple && 'weave-ripple',
      )}
    >
      <Handle type="source" position={Position.Left} className="!bg-emerald-400/80" />
      <div className="flex items-center gap-1.5 text-[11px]">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
            STATUS_CLASS[d.status],
          )}
        >
          {d.status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
          {t(STATUS_KEY[d.status])}
        </span>
        <span className="min-w-0 flex-1 truncate text-neutral-500">
          {t('hooks.byRule', { name: data.ruleName })}
        </span>
        <span className="shrink-0 text-neutral-600">{formatTime(d.startedAt)}</span>
      </div>
      <p className="mt-1 line-clamp-2 text-xs text-neutral-300" title={d.prompt}>
        {d.prompt}
      </p>
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => void copy()}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-md border border-white/[0.08] px-1.5 py-0.5 text-[10px] transition-colors',
            copied ? 'text-emerald-300' : 'text-neutral-400 hover:text-neutral-200',
          )}
        >
          {copied ? (
            <>
              <Check className="h-3 w-3" />
              {t('hooks.copied')}
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              {t('hooks.copy')}
            </>
          )}
        </button>
        <span className="ml-auto flex min-w-0 items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <select
            className="min-w-0 flex-1 rounded-md border border-white/[0.08] bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300 focus:outline-none"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          >
            <option value="">
              {data.sessions.length > 0 ? t('hooks.selectSession') : t('hooks.noSessions')}
            </option>
            {data.sessions.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {s.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            title={t('hooks.run')}
            disabled={!draft}
            onClick={run}
            className="shrink-0 rounded-md border border-white/[0.08] px-1.5 py-0.5 text-[10px] text-blue-300 transition-colors enabled:hover:bg-blue-900/40 disabled:opacity-40"
          >
            <Play className="h-3 w-3" />
          </button>
        </span>
      </div>
    </div>
  );
}

const nodeTypes = {
  source: SourceNode,
  rule: RuleNode,
  handler: HandlerNode,
  session: SessionNode,
  ph: PlaceholderNode,
  dispatch: DispatchNode,
};

// macOS 风格迷你开关已提炼到 ui/switch.tsx（与插件区段共用）。

// ---------------------------------------------------------------------------
// 链路图布局（静态：列 x = 0/320/640/960/1280，行 y 递增 100）
// ---------------------------------------------------------------------------

const COL_X = { source: 0, rule: 320, handler: 640, session: 960, dispatch: 1280 };
const ROW_Y = 100;
/** 会话列最多画这么多行 — fitView 后仍可读。 */
const MAX_SESSION_NODES = 30;

interface GraphCallbacks {
  onToggle: (id: string, enabled: boolean) => void;
  onRename: (sessionId: string, title: string) => void;
  onDropPrompt: (dispatchId: number, sessionId: string, label: string) => void;
}

function buildGraph(
  rules: HookRule[],
  sessions: SessionRow[],
  dispatches: HookDispatch[],
  projectById: Map<number, string>,
  t: ReturnType<typeof useT>,
  /** 全局形态不画会话列（纯拓扑）；项目形态画本项目会话作投送目标。 */
  showSessions: boolean,
  cb: GraphCallbacks,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  // 事件源列：CLAUDE_HOOK_EVENTS 顺序，只画被规则引用的事件。
  const used = new Set<string>();
  for (const r of rules) {
    const src = normalizeHookRuleSource(r.source);
    if (src.kind === 'hook-event') used.add(src.event);
  }
  CLAUDE_HOOK_EVENTS.filter((e) => used.has(e)).forEach((event, i) => {
    nodes.push({
      id: `src:${event}`,
      type: 'source',
      position: { x: COL_X.source, y: i * ROW_Y },
      data: { event },
    });
  });

  // 规则列 + 源→规则、规则→处理器 两条边。
  rules.forEach((rule, i) => {
    const scopeLabel =
      rule.projectId === null
        ? t('hooks.scopeGlobal')
        : (projectById.get(rule.projectId) ?? t('hooks.scopeProjectId', { id: rule.projectId }));
    nodes.push({
      id: `rule:${rule.id}`,
      type: 'rule',
      position: { x: COL_X.rule, y: i * ROW_Y },
      data: { rule, scopeLabel, onToggle: cb.onToggle },
    });
    const src = normalizeHookRuleSource(rule.source);
    if (src.kind === 'hook-event') {
      edges.push({
        id: `e:${src.event}->${rule.id}`,
        source: `src:${src.event}`,
        target: `rule:${rule.id}`,
        data: { ruleId: rule.id },
      });
    }
    edges.push({
      id: `e:${rule.id}->${rule.handler.type}`,
      source: `rule:${rule.id}`,
      target: `h:${rule.handler.type}`,
      data: { ruleId: rule.id },
    });
  });

  // 处理器列：按 handler.type 去重。
  HANDLER_TYPES.filter((type) => rules.some((r) => r.handler.type === type)).forEach(
    (type, i) => {
      nodes.push({
        id: `h:${type}`,
        type: 'handler',
        position: { x: COL_X.handler, y: i * ROW_Y },
        data: {
          handlerType: type,
          count: rules.filter((r) => r.handler.type === type).length,
        },
      });
    },
  );

  // 会话列：仅项目形态，独立展示（指令投送目标，不连边）。
  const drawnSessions = showSessions ? sessions.slice(0, MAX_SESSION_NODES) : [];
  if (showSessions) {
    if (sessions.length === 0) {
      nodes.push({
        id: 'sessions:empty',
        type: 'ph',
        position: { x: COL_X.session, y: 0 },
        data: { label: t('hooks.sessionsEmpty') },
      });
    } else {
      drawnSessions.forEach((s, i) => {
        nodes.push({
          id: `sess:${s.sessionId}`,
          type: 'session',
          position: { x: COL_X.session, y: i * ROW_Y },
          data: {
            sessionId: s.sessionId,
            label: sessionLabel(s),
            titleValue: s.title ?? '',
            pendingTitle: s.pendingTitle,
            projectLabel:
              s.projectId === null
                ? null
                : (projectById.get(s.projectId) ?? `#${s.projectId}`),
            onRename: cb.onRename,
            onDropPrompt: cb.onDropPrompt,
          },
        });
      });
    }
  }

  // 指令列：按时间序平铺的管理列表——不对齐会话、不连会话边（会话关联的
  // 可视化在任务视图）；执行仍经节点内「选择会话 ▶」或拖拽到会话节点。
  const sessionOptions = drawnSessions.map((s) => ({
    sessionId: s.sessionId,
    label: sessionLabel(s),
  }));
  const ruleNameById = new Map(rules.map((r) => [r.id, r.name]));

  const pushDispatch = (d: HookDispatch, y: number): void => {
    nodes.push({
      id: `dispatch:${d.id}`,
      type: 'dispatch',
      position: { x: COL_X.dispatch, y },
      data: {
        dispatch: d,
        ruleName: ruleNameById.get(d.ruleId) ?? t('hooks.unknownRule'),
        sessions: sessionOptions,
        ripple: false,
        onRun: cb.onDropPrompt,
      },
    });
  };

  if (dispatches.length === 0) {
    nodes.push({
      id: 'dispatch:empty',
      type: 'ph',
      position: { x: COL_X.dispatch, y: 0 },
      data: { label: t('hooks.poolEmpty') },
    });
  } else {
    dispatches.forEach((d, i) => pushDispatch(d, i * ROW_Y));
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// 规则表单
// ---------------------------------------------------------------------------

interface RuleFormState {
  name: string;
  projectId: number | null;
  sourceKind: 'hook-event' | 'claude-event';
  harness: Harness | 'any';
  event: string;
  toolNames: string;
  pathGlobs: string;
  crossProjectOnly: boolean;
  handlerType: HandlerConfig['type'];
  template: string;
  url: string;
  secret: string;
  pluginId: string;
  pluginHandlerType: string;
  record: boolean;
  enabled: boolean;
}

function emptyForm(defaultProjectId: number | null): RuleFormState {
  return {
    name: '',
    projectId: defaultProjectId,
    sourceKind: 'hook-event',
    harness: 'claude',
    event: 'PostToolUse',
    toolNames: '',
    pathGlobs: '',
    crossProjectOnly: false,
    handlerType: 'manual',
    template: '',
    url: '',
    secret: '',
    pluginId: '',
    pluginHandlerType: '',
    record: true,
    enabled: true,
  };
}

function formFromRule(rule: HookRule): RuleFormState {
  const handler = rule.handler;
  const src = normalizeHookRuleSource(rule.source);
  return {
    name: rule.name,
    projectId: rule.projectId,
    sourceKind: rule.source.kind === 'claude-event' ? 'claude-event' : 'hook-event',
    harness: hookSourceHarness(rule.source) ?? 'claude',
    event: src.kind === 'hook-event' ? src.event : 'PostToolUse',
    toolNames: (rule.filter.toolNames ?? []).join(', '),
    pathGlobs: (rule.filter.pathGlobs ?? []).join(', '),
    crossProjectOnly: rule.filter.crossProjectOnly ?? false,
    handlerType: handler.type,
    template: handler.type === 'inject' || handler.type === 'manual' ? handler.template : '',
    url: handler.type === 'webhook' ? handler.url : '',
    secret: handler.type === 'webhook' ? (handler.secret ?? '') : '',
    pluginId: handler.type === 'plugin' ? handler.pluginId : '',
    pluginHandlerType: handler.type === 'plugin' ? handler.handlerType : '',
    record: rule.record,
    enabled: rule.enabled,
  };
}

interface OpenForm {
  editingId: string | null;
  state: RuleFormState;
}

// ---------------------------------------------------------------------------
// 面板主体
// ---------------------------------------------------------------------------

export function HooksPanel({
  projectId,
  mode,
}: {
  /** Anchor project id（项目模式下用于规则过滤与表单默认值）。 */
  projectId: number;
  mode: FlowMode;
}) {
  const t = useT();

  const [rules, setRules] = useState<HookRule[] | null>(null);
  const [dispatches, setDispatches] = useState<HookDispatch[] | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<OpenForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [pulseRuleId, setPulseRuleId] = useState<string | null>(null);
  /** dispatch.created 入场波纹的 dispatch id（900ms 后摘除）。 */
  const [rippleId, setRippleId] = useState<number | null>(null);
  /** 拖拽 / 节点下拉选择后的执行确认目标。 */
  const [pendingRun, setPendingRun] = useState<{
    dispatchId: number;
    sessionId: string;
    sessionLabel: string;
  } | null>(null);

  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p.name])),
    [projects],
  );

  // ---- 数据拉取 ----
  const refreshRules = useCallback(async () => {
    try {
      setRules(await api.listHooksRules(mode === 'project' ? projectId : undefined));
    } catch (e) {
      setError(errMsg(e));
    }
  }, [mode, projectId]);

  const refreshDispatches = useCallback(async () => {
    try {
      setDispatches(sortPool(await api.listHookDispatches({ limit: 50 })));
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    // 全局形态画布没有会话列，不必拉取；项目形态只拉本项目会话，
    // 其他项目的会话不得混入。
    if (mode !== 'project') {
      setSessions([]);
      return;
    }
    try {
      setSessions(await api.listSessions(projectId));
    } catch (e) {
      setError(errMsg(e));
    }
  }, [mode, projectId]);

  useEffect(() => {
    void refreshRules();
    void refreshDispatches();
    void refreshSessions();
    api
      .listProjects()
      .then(setProjects)
      .catch(() => {});
  }, [refreshRules, refreshDispatches, refreshSessions]);

  // ---- 规则操作 ----
  const toggleRule = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await api.toggleHookRule(id, enabled);
        await refreshRules();
        notifyRulesChanged();
      } catch (e) {
        setError(errMsg(e));
      }
    },
    [refreshRules],
  );

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      try {
        await api.renameSession(sessionId, title);
        await refreshSessions();
      } catch (e) {
        setError(errMsg(e));
      }
    },
    [refreshSessions],
  );

  const askRun = useCallback(
    (dispatchId: number, sessionId: string, label: string) => {
      setPendingRun({ dispatchId, sessionId, sessionLabel: label });
    },
    [],
  );

  const confirmRun = useCallback(async () => {
    if (!pendingRun) return;
    try {
      await api.runHookDispatch(pendingRun.dispatchId, pendingRun.sessionId);
      setPendingRun(null);
      await refreshDispatches();
    } catch (e) {
      setPendingRun(null);
      setError(t('hooks.runFailed', { error: errMsg(e) }));
    }
  }, [pendingRun, refreshDispatches, t]);

  const deleteRule = useCallback(
    async (id: string) => {
      // 两段式确认：第一次点击进入确认态，再次点击才删除。
      if (confirmDeleteId !== id) {
        setConfirmDeleteId(id);
        return;
      }
      try {
        await api.deleteHookRule(id);
        setConfirmDeleteId(null);
        if (form?.editingId === id) setForm(null);
        await refreshRules();
        notifyRulesChanged();
      } catch (e) {
        setError(errMsg(e));
      }
    },
    [confirmDeleteId, form, refreshRules],
  );

  // ---- 实时高亮 + 指令刷新 ----
  const refreshTimer = useRef<number | null>(null);
  const pulseTimer = useRef<number | null>(null);
  const rippleTimer = useRef<number | null>(null);

  useEffect(() => {
    const onHook = (ev: Event): void => {
      const frame = (ev as CustomEvent<HookFrame>).detail;
      if (frame.kind === 'dispatch.created' || frame.kind === 'dispatch.started') {
        setPulseRuleId(frame.ruleId ?? null);
        if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
        pulseTimer.current = window.setTimeout(() => setPulseRuleId(null), 500);
      }
      if (frame.kind === 'dispatch.created' && frame.dispatchId != null) {
        setRippleId(frame.dispatchId);
        if (rippleTimer.current) window.clearTimeout(rippleTimer.current);
        rippleTimer.current = window.setTimeout(() => setRippleId(null), 900);
      }
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        void refreshDispatches();
      }, 500);
    };
    window.addEventListener('weave:hook', onHook);
    return () => {
      window.removeEventListener('weave:hook', onHook);
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
      if (rippleTimer.current) window.clearTimeout(rippleTimer.current);
    };
  }, [refreshDispatches]);

  // ---- 链路图 ----
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [baseEdges, setBaseEdges] = useState<FlowEdge[]>([]);
  /** 项目形态画布双视图：拓扑（静态链路）| 生命周期（prompt 思维导图）。 */
  const [flowView, setFlowView] = useState<'topology' | 'lifecycle'>('topology');
  /** 思维导图当前会话（默认最近活跃）。 */
  const [mindmapSessionId, setMindmapSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'project') return;
    if (!sessions?.length) {
      setMindmapSessionId(null);
      return;
    }
    setMindmapSessionId((prev) =>
      prev && sessions.some((s) => s.sessionId === prev) ? prev : sessions[0].sessionId,
    );
  }, [mode, sessions]);

  useEffect(() => {
    if (!rules || !sessions || !dispatches) return;
    // 项目画布只展示作用于本项目的指令：dispatch 按当前规则集（本项目 +
    // 全局规则）过滤，其他项目的指令不混入。
    const ruleIds = new Set(rules.map((r) => r.id));
    const scoped = dispatches.filter((d) => ruleIds.has(d.ruleId));
    const built = buildGraph(rules, sessions, scoped, projectById, t, mode === 'project', {
      onToggle: toggleRule,
      onRename: renameSession,
      onDropPrompt: askRun,
    });
    // 保留用户拖出来的节点位置，只更新数据 / 集合。
    setNodes((prev) => {
      const pos = new Map(prev.map((n) => [n.id, n.position]));
      return built.nodes.map((n) => {
        const p = pos.get(n.id);
        return p ? ({ ...n, position: p } as FlowNode) : n;
      });
    });
    setBaseEdges(built.edges);
  }, [rules, sessions, dispatches, projectById, t, mode, toggleRule, renameSession, askRun, setNodes]);

  // SSE 高亮覆盖在静态图之上：触发规则节点边框闪烁 500ms、新指令节点入场波纹 900ms。
  const { viewNodes, edges } = useMemo<{ viewNodes: FlowNode[]; edges: FlowEdge[] }>(() => {
    const flashId = pulseRuleId ? `rule:${pulseRuleId}` : null;
    return {
      viewNodes: nodes.map((n) => {
        if (n.type === 'dispatch' && n.data.dispatch.id === rippleId) {
          return { ...n, data: { ...n.data, ripple: true } };
        }
        if (flashId && n.id === flashId) {
          return { ...n, className: 'weave-node-flash' };
        }
        return n;
      }),
      edges: pulseRuleId
        ? baseEdges.map((e) =>
            e.data?.ruleId === pulseRuleId
              ? {
                  ...e,
                  className: 'stroke-blue-400! stroke-2! animate-pulse',
                }
              : e,
          )
        : baseEdges,
    };
  }, [nodes, baseEdges, pulseRuleId, rippleId]);

  // ---- 表单 ----
  const formRef = useRef<HTMLDivElement>(null);
  /** 仅在打开表单时递增 — 表单内容变化不重触滚动。 */
  const [formOpenTick, setFormOpenTick] = useState(0);

  const openCreate = (): void => {
    setFormError(null);
    setForm({ editingId: null, state: emptyForm(mode === 'project' ? projectId : null) });
    setFormOpenTick((n) => n + 1);
  };
  const openEdit = (rule: HookRule): void => {
    setFormError(null);
    setForm({ editingId: rule.id, state: formFromRule(rule) });
    setFormOpenTick((n) => n + 1);
  };

  // 表单挂在区块最底部，打开后滚进视口；关闭时不回滚滚动位置。
  useEffect(() => {
    if (formOpenTick === 0) return;
    const el = formRef.current;
    if (!el) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  }, [formOpenTick]);

  const closeForm = (): void => {
    setForm(null);
    setFormError(null);
  };
  const patchForm = (p: Partial<RuleFormState>): void =>
    setForm((f) => (f ? { ...f, state: { ...f.state, ...p } } : f));

  const setHandlerType = (type: HandlerConfig['type']): void =>
    setForm((f) => {
      if (!f) return f;
      let event = f.state.event;
      // inject 只允许白名单事件 — 切过去时把越界事件拉回第一个可注入项。
      if (type === 'inject' && !(INJECTABLE_HOOK_EVENTS as readonly string[]).includes(event)) {
        event = 'PostToolUse';
      }
      return {
        ...f,
        state: {
          ...f.state,
          handlerType: type,
          event,
          // log 处理器不生成指令 → 强制不写池；其余保留用户当前勾选。
          record: type === 'log' ? false : f.state.record,
        },
      };
    });

  const applyQuickTemplate = (): void => {
    if (!form) return;
    setFormError(null);
    setForm({
      ...form,
      state: {
        ...form.state,
        name: t('hooks.quickTemplateName'),
        event: 'PostToolUse',
        toolNames: '',
        pathGlobs: '**/*.md',
        crossProjectOnly: false,
        handlerType: 'inject',
        template: t('hooks.quickTemplatePrompt'),
        url: '',
        secret: '',
        record: true,
        enabled: false,
      },
    });
  };

  const submitForm = async (): Promise<void> => {
    if (!form) return;
    const s = form.state;
    const name = s.name.trim();
    if (!name) {
      setFormError(t('hooks.errNameRequired'));
      return;
    }
    if ((s.handlerType === 'inject' || s.handlerType === 'manual') && !s.template.trim()) {
      setFormError(t('hooks.errTemplateRequired'));
      return;
    }
    if (s.handlerType === 'webhook') {
      try {
        new URL(s.url.trim());
      } catch {
        setFormError(t('hooks.errUrlRequired'));
        return;
      }
    }
    if (s.handlerType === 'plugin' && (!s.pluginId.trim() || !s.pluginHandlerType.trim())) {
      setFormError(t('hooks.errPluginRequired'));
      return;
    }
    const handler: HandlerConfig =
      s.handlerType === 'log'
        ? { type: 'log' }
        : s.handlerType === 'webhook'
          ? {
              type: 'webhook',
              url: s.url.trim(),
              ...(s.secret.trim() ? { secret: s.secret.trim() } : {}),
            }
          : s.handlerType === 'plugin'
            ? {
                type: 'plugin',
                pluginId: s.pluginId.trim(),
                handlerType: s.pluginHandlerType.trim(),
              }
            : { type: s.handlerType, template: s.template.trim() };
    const filter: HookRuleFilter = {};
    const tools = splitList(s.toolNames);
    const globs = splitList(s.pathGlobs);
    if (tools.length) filter.toolNames = tools;
    if (globs.length) filter.pathGlobs = globs;
    if (s.crossProjectOnly) filter.crossProjectOnly = true;
    const source: HookRuleSource =
      s.sourceKind === 'claude-event'
        ? { kind: 'claude-event', event: s.event }
        : { kind: 'hook-event', harness: s.harness, event: s.event };
    const body: HookRuleInput = {
      name,
      enabled: s.enabled,
      projectId: s.projectId,
      source,
      filter,
      handler,
      record: s.record,
    };
    try {
      if (form.editingId) await api.updateHookRule(form.editingId, body);
      else await api.createHookRule(body);
      closeForm();
      setError(null);
      await refreshRules();
      notifyRulesChanged();
    } catch (e) {
      setFormError(errMsg(e));
    }
  };

  // ---- 渲染 ----
  // 待处理计数与画布同一口径：只算作用于当前规则集的指令。
  const scopedDispatches =
    dispatches && rules ? dispatches.filter((d) => rules.some((r) => r.id === d.ruleId)) : dispatches;
  const pendingCount = scopedDispatches?.filter((d) => d.sessionId === null).length ?? 0;
  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold tracking-tight">{t('hooks.title')}</h3>
        <span className="text-[11px] text-neutral-500">
          {rules === null ? t('hooks.loading') : t('catbar.items', { n: rules.length })}
        </span>
        <button
          type="button"
          onClick={() => (form && form.editingId === null ? closeForm() : openCreate())}
          className="ml-auto inline-flex items-center gap-1 rounded-lg bg-blue-600/80 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500"
        >
          {form && form.editingId === null ? (
            <>
              <X className="h-3.5 w-3.5" />
              {t('hooks.cancel')}
            </>
          ) : (
            <>
              <Plus className="h-3.5 w-3.5" />
              {t('hooks.newRule')}
            </>
          )}
        </button>
      </div>

      {/* 插件区段（SPI 扫描：内置预设/全局/项目三根，热重载自动刷新）。
          全局 = 插件管理（安装/卸载 + 默认启用开关）；项目 = effective 启用列表 */}
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <CardTitle className="text-sm">{t('hooks.plugins.title')}</CardTitle>
          <span className="text-[11px] text-neutral-500">
            {mode === 'project' ? t('hooks.plugins.projectHint') : t('hooks.plugins.hint')}
          </span>
        </CardHeader>
        <CardContent className="space-y-1">
          <HooksPluginsSection projectId={mode === 'project' ? projectId : undefined} />
        </CardContent>
      </Card>

      {/* 工具箱归文件资产 ▸ Plugins（批 A 重组：Weave 分类只留 weave 插件） */}

      {/* 链路图：事件源 → 规则 → 处理器 + 指令管理列（项目态另带会话列） */}
      <Card>
        <CardHeader className="flex-col gap-1.5">
          <div className="flex w-full items-center gap-2">
            <CardTitle>{t('hooks.flowTitle')}</CardTitle>
            {rules && rules.length === 0 && (
              <span className="text-[11px] text-neutral-500">{t('hooks.emptyFlow')}</span>
            )}
            <span className="text-[11px] text-neutral-500">
              {dispatches === null
                ? t('hooks.loading')
                : `${t('hooks.poolTitle')} ${t('hooks.poolCount', { n: pendingCount })}`}
            </span>
            <span className="ml-auto flex items-center gap-1">
              {mode === 'project' && (
                <span className="flex overflow-hidden rounded-md border border-white/[0.08]">
                  {(['topology', 'lifecycle'] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setFlowView(v)}
                      className={cn(
                        'px-2 py-0.5 text-[11px] transition-colors',
                        flowView === v
                          ? 'bg-neutral-800 text-neutral-100'
                          : 'text-neutral-500 hover:bg-neutral-800/50',
                      )}
                    >
                      {t(v === 'topology' ? 'hooks.viewTopology' : 'hooks.viewLifecycle')}
                    </button>
                  ))}
                </span>
              )}
              <span className="text-[11px] text-neutral-500">
                {mode === 'project' ? t('hooks.flowHint') : t('hooks.flowHintGlobal')}
              </span>
            </span>
          </div>
          {flowView === 'topology' && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-500">
              <LegendChip icon={Zap} tone="text-amber-400" label={t('hooks.colSource')} />
              <LegendChip icon={Workflow} tone="text-blue-400" label={t('hooks.colRule')} />
              <LegendChip icon={ScrollText} tone="text-purple-300" label={t('hooks.colHandler')} />
              {mode === 'project' && (
                <LegendChip icon={Inbox} tone="text-cyan-400" label={t('hooks.colSession')} />
              )}
              <LegendChip icon={Send} tone="text-emerald-400" label={t('hooks.colDispatch')} />
            </div>
          )}
        </CardHeader>
        <CardContent className="p-2">
          {mode === 'project' && flowView === 'lifecycle' ? (
            <div className="rounded-lg border border-white/[0.06] bg-neutral-950/40 p-2">
              {mindmapSessionId && sessions ? (
                <LifecycleMindmap
                  projectId={projectId}
                  sessionId={mindmapSessionId}
                  sessions={sessions}
                  onSelect={setMindmapSessionId}
                />
              ) : (
                <div className="flex h-96 items-center justify-center text-xs text-neutral-500">
                  {t('hooks.mindmap.empty')}
                </div>
              )}
            </div>
          ) : (
            <div className="h-80 rounded-lg border border-white/[0.06] bg-neutral-950/40">
            {/* 数据到位后才挂 ReactFlow — fitView 首帧就能对上铺满的图。 */}
            {nodes.length > 0 ? (
              <ReactFlow
                nodes={viewNodes}
                onNodesChange={onNodesChange}
                edges={edges}
                nodeTypes={nodeTypes}
                fitView
                minZoom={0.15}
                maxZoom={1.5}
                nodesDraggable
                nodesConnectable={false}
                deleteKeyCode={null}
                defaultEdgeOptions={{
                  type: 'smoothstep',
                  style: { stroke: 'rgba(255,255,255,0.25)', strokeWidth: 1.5 },
                }}
              >
                <Background gap={14} size={1} color="rgba(255,255,255,0.06)" />
                <Controls showInteractive={false} />
              </ReactFlow>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-neutral-500">
                {t('hooks.loading')}
              </div>
            )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 规则表单（新建 / 行内编辑共用） */}
      {form && (
        <Card ref={formRef}>
          <CardHeader className="items-center justify-between">
            <CardTitle>
              {form.editingId ? t('hooks.form.editTitle') : t('hooks.form.createTitle')}
            </CardTitle>
            <div className="flex items-center gap-2">
              {!form.editingId && (
                <button
                  type="button"
                  onClick={applyQuickTemplate}
                  title={t('hooks.quickTemplateTip')}
                  className="rounded-md border border-white/[0.08] px-2 py-1 text-[11px] text-neutral-300 transition-colors hover:bg-neutral-800"
                >
                  {t('hooks.quickTemplate')}
                </button>
              )}
              <button
                type="button"
                onClick={closeForm}
                title={t('hooks.cancel')}
                className="rounded-md p-1 text-neutral-500 transition-colors hover:text-neutral-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {formError && <p className="text-xs text-red-400">{formError}</p>}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-[11px] text-neutral-500">{t('hooks.field.name')}</span>
                <input
                  className="w-full rounded-lg border border-white/[0.08] bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  value={form.state.name}
                  onChange={(e) => patchForm({ name: e.target.value })}
                  placeholder={t('hooks.namePlaceholder')}
                />
              </label>

              <label className="block space-y-1">
                <span className="text-[11px] text-neutral-500">{t('hooks.field.project')}</span>
                <select
                  className="w-full rounded-lg border border-white/[0.08] bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  value={form.state.projectId === null ? '' : String(form.state.projectId)}
                  onChange={(e) =>
                    patchForm({ projectId: e.target.value === '' ? null : Number(e.target.value) })
                  }
                >
                  <option value="">{t('hooks.projectGlobal')}</option>
                  {projects.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1">
                <span className="text-[11px] text-neutral-500">{t('hooks.field.sourceKind')}</span>
                <select
                  className="w-full rounded-lg border border-white/[0.08] bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  value={form.state.sourceKind}
                  onChange={(e) =>
                    patchForm({ sourceKind: e.target.value as RuleFormState['sourceKind'] })
                  }
                >
                  {SOURCE_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind === 'hook-event'
                        ? t('hooks.sourceKind.hookEvent')
                        : t('hooks.sourceKind.legacy')}
                    </option>
                  ))}
                </select>
              </label>

              {form.state.sourceKind === 'hook-event' && (
                <label className="block space-y-1">
                  <span className="text-[11px] text-neutral-500">{t('hooks.field.harness')}</span>
                  <select
                    className="w-full rounded-lg border border-white/[0.08] bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    value={form.state.harness}
                    onChange={(e) =>
                      patchForm({ harness: e.target.value as Harness | 'any' })
                    }
                  >
                    {HARNESS_OPTIONS.map((h) => (
                      <option key={h} value={h}>
                        {t(`hooks.harness.${h}`)}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="block space-y-1">
                <span className="text-[11px] text-neutral-500">{t('hooks.field.event')}</span>
                <select
                  className="w-full rounded-lg border border-white/[0.08] bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  value={form.state.event}
                  onChange={(e) => patchForm({ event: e.target.value })}
                >
                  {(form.state.handlerType === 'inject'
                    ? INJECTABLE_HOOK_EVENTS
                    : CLAUDE_HOOK_EVENTS
                  ).map((ev) => (
                    <option key={ev} value={ev}>
                      {ev}
                    </option>
                  ))}
                </select>
                {form.state.handlerType === 'inject' && (
                  <span className="block text-[10px] text-amber-400/80">
                    {t('hooks.eventInjectHint', { events: INJECTABLE_HOOK_EVENTS.join(', ') })}
                  </span>
                )}
              </label>

              <div className="space-y-1">
                <span className="text-[11px] text-neutral-500">{t('hooks.field.handler')}</span>
                <div className="flex w-fit max-w-full flex-wrap rounded-lg border border-white/[0.06] bg-neutral-900/60 p-0.5">
                  {HANDLER_TYPES.map((type) => (
                    <button
                      key={type}
                      type="button"
                      title={t(HANDLER_TIP_KEYS[type])}
                      onClick={() => setHandlerType(type)}
                      className={cn(
                        'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors duration-150',
                        form.state.handlerType === type
                          ? 'bg-neutral-800 text-neutral-100 shadow-mac-sm'
                          : 'text-neutral-500 hover:text-neutral-300',
                      )}
                    >
                      {t(HANDLER_LABEL_KEYS[type])}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {form.state.handlerType === 'webhook' && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-[11px] text-neutral-500">{t('hooks.field.url')}</span>
                  <input
                    className="w-full rounded-lg border border-white/[0.08] bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    value={form.state.url}
                    onChange={(e) => patchForm({ url: e.target.value })}
                    placeholder={t('hooks.urlPlaceholder')}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[11px] text-neutral-500">{t('hooks.field.secret')}</span>
                  <input
                    className="w-full rounded-lg border border-white/[0.08] bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    value={form.state.secret}
                    onChange={(e) => patchForm({ secret: e.target.value })}
                  />
                </label>
              </div>
            )}

            {form.state.handlerType === 'plugin' && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-[11px] text-neutral-500">{t('hooks.field.pluginId')}</span>
                  <input
                    className="w-full rounded-lg border border-white/[0.08] bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    value={form.state.pluginId}
                    onChange={(e) => patchForm({ pluginId: e.target.value })}
                    placeholder={t('hooks.pluginIdPlaceholder')}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[11px] text-neutral-500">
                    {t('hooks.field.pluginHandlerType')}
                  </span>
                  <input
                    className="w-full rounded-lg border border-white/[0.08] bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    value={form.state.pluginHandlerType}
                    onChange={(e) => patchForm({ pluginHandlerType: e.target.value })}
                    placeholder={t('hooks.pluginHandlerPlaceholder')}
                  />
                </label>
              </div>
            )}

            {(form.state.handlerType === 'inject' || form.state.handlerType === 'manual') && (
              <label className="block space-y-1">
                <span className="text-[11px] text-neutral-500">{t('hooks.field.template')}</span>
                <textarea
                  rows={3}
                  className="w-full rounded-lg border border-white/[0.08] bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  value={form.state.template}
                  onChange={(e) => patchForm({ template: e.target.value })}
                  placeholder={t('hooks.templatePlaceholder')}
                />
              </label>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-[11px] text-neutral-500">{t('hooks.field.toolNames')}</span>
                <input
                  className="w-full rounded-lg border border-white/[0.08] bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  value={form.state.toolNames}
                  onChange={(e) => patchForm({ toolNames: e.target.value })}
                  placeholder={t('hooks.toolNamesPlaceholder')}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] text-neutral-500">{t('hooks.field.pathGlobs')}</span>
                <input
                  className="w-full rounded-lg border border-white/[0.08] bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  value={form.state.pathGlobs}
                  onChange={(e) => patchForm({ pathGlobs: e.target.value })}
                  placeholder={t('hooks.pathGlobsPlaceholder')}
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <CheckField
                label={t('hooks.field.crossProjectOnly')}
                checked={form.state.crossProjectOnly}
                onChange={(v) => patchForm({ crossProjectOnly: v })}
              />
              <CheckField
                label={t('hooks.field.record')}
                checked={form.state.record}
                onChange={(v) => patchForm({ record: v })}
              />
              <CheckField
                label={t('hooks.field.enabled')}
                checked={form.state.enabled}
                onChange={(v) => patchForm({ enabled: v })}
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void submitForm()}
                className="rounded-lg bg-blue-600/80 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500"
              >
                {t('hooks.save')}
              </button>
              <button
                type="button"
                onClick={closeForm}
                className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:bg-neutral-800"
              >
                {t('hooks.cancel')}
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 规则列表（指令执行交互已迁至画布指令节点） */}
      <Card>
        <CardHeader className="items-center justify-between">
          <CardTitle>{t('hooks.rulesTitle')}</CardTitle>
          <span className="text-[11px] text-neutral-500">
            {rules === null ? t('hooks.loading') : t('catbar.items', { n: rules.length })}
          </span>
        </CardHeader>
        <CardContent className="space-y-2">
          {rules === null ? (
            <p className="py-4 text-center text-xs text-neutral-500">{t('hooks.loading')}</p>
          ) : rules.length === 0 ? (
            <p className="py-4 text-center text-xs text-neutral-500">{t('hooks.rulesEmpty')}</p>
          ) : (
            rules.map((rule) => {
              const tools = rule.filter.toolNames ?? [];
              const globs = rule.filter.pathGlobs ?? [];
              const src = normalizeHookRuleSource(rule.source);
              const eventLabel = src.kind === 'webhook' ? src.routeId : src.event;
              const HandlerIcon = HANDLER_ICONS[rule.handler.type];
              return (
                <div
                  key={rule.id}
                  className={cn(
                    'rounded-lg border px-3 py-2 transition-colors',
                    rule.enabled
                      ? 'border-white/[0.08] bg-neutral-900/40'
                      : 'border-white/[0.05] bg-neutral-900/20 opacity-70',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-100">
                      {rule.name}
                    </span>
                    <Badge variant="helper">{eventLabel}</Badge>
                    <Switch
                      checked={rule.enabled}
                      title={t('hooks.toggleTip', { name: rule.name })}
                      onChange={(v) => void toggleRule(rule.id, v)}
                    />
                    <button
                      type="button"
                      title={t('hooks.edit')}
                      onClick={() => openEdit(rule)}
                      className="rounded p-1 text-neutral-500 transition-colors hover:text-neutral-200"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title={confirmDeleteId === rule.id ? t('hooks.confirmDelete') : t('hooks.delete')}
                      onClick={() => void deleteRule(rule.id)}
                      className={cn(
                        'rounded px-1.5 py-1 text-[11px] font-medium transition-colors',
                        confirmDeleteId === rule.id
                          ? 'bg-red-900/60 text-red-300'
                          : 'text-neutral-500 hover:text-red-300',
                      )}
                    >
                      {confirmDeleteId === rule.id ? (
                        t('hooks.confirmDelete')
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-neutral-500">
                    <Badge variant="command" className="gap-1">
                      <HandlerIcon className="h-3 w-3" />
                      {t(HANDLER_LABEL_KEYS[rule.handler.type])}
                    </Badge>
                    <Badge variant="default">
                      {rule.projectId === null
                        ? t('hooks.scopeGlobal')
                        : projectById.has(rule.projectId)
                          ? t('hooks.scopeProjectName', {
                              name: projectById.get(rule.projectId)!,
                            })
                          : t('hooks.scopeProjectId', { id: rule.projectId })}
                    </Badge>
                    {tools.length > 0 && (
                      <span
                        className="inline-flex items-center gap-0.5"
                        title={t('hooks.filterToolTip', { names: tools.join(', ') })}
                      >
                        <Wrench className="h-3 w-3" />
                        {tools.length}
                      </span>
                    )}
                    {globs.length > 0 && (
                      <span
                        className="inline-flex items-center gap-0.5"
                        title={t('hooks.filterPathTip', { paths: globs.join(', ') })}
                      >
                        <FileText className="h-3 w-3" />
                        {globs.length}
                      </span>
                    )}
                    {rule.filter.crossProjectOnly && (
                      <span
                        className="inline-flex items-center gap-0.5"
                        title={t('hooks.filterCrossTip')}
                      >
                        <GitBranch className="h-3 w-3" />
                      </span>
                    )}
                    {tools.length === 0 && globs.length === 0 && !rule.filter.crossProjectOnly && (
                      <span>{t('hooks.filterNone')}</span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* 执行确认条（拖拽 / 节点下拉共用） */}
      {pendingRun && (
        <div className="sticky bottom-0 z-20 flex items-center gap-3 rounded-xl border border-blue-500/40 bg-neutral-900/95 px-4 py-2.5 shadow-mac backdrop-blur">
          <p className="min-w-0 flex-1 text-xs text-neutral-200">
            {t('hooks.runConfirm', {
              id: pendingRun.dispatchId,
              session: pendingRun.sessionLabel,
            })}
          </p>
          <button
            type="button"
            onClick={() => void confirmRun()}
            className="rounded-lg bg-blue-600/80 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500"
          >
            {t('hooks.runConfirmYes')}
          </button>
          <button
            type="button"
            onClick={() => setPendingRun(null)}
            className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:bg-neutral-800"
          >
            {t('hooks.cancel')}
          </button>
        </div>
      )}
    </div>
  );
}

function LegendChip({
  icon: Icon,
  tone,
  label,
}: {
  icon: LucideIcon;
  tone: string;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className={cn('h-3 w-3', tone)} />
      {label}
    </span>
  );
}

function CheckField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-neutral-300">
      <input
        type="checkbox"
        className="h-3.5 w-3.5 accent-blue-500"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
