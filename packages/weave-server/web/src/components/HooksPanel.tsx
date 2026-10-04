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
  type HookRule,
  type HookRuleFilter,
  type HookRuleInput,
  type HookRuleSource,
  type ProjectRow,
} from '@/lib/api';
import type { Harness } from '@weave/core/harness';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { HooksPluginsSection } from '@/components/HooksPluginsSection';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';
import {
  Bot,
  FileText,
  GitBranch,
  Hand,
  Pencil,
  Plus,
  Puzzle,
  ScrollText,
  Trash2,
  Webhook,
  Wrench,
  Workflow,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Weave 分类卡 = 纯配置状态视图：插件区 + 规则表单/列表 + 静态拓扑画布
 * （事件源 → 规则 → 处理器）。运行时内容（指令投送、会话、生命周期视图、
 * 执行确认与 SSE 高亮）归任务视图。
 * 双形态：全局 = 插件管理（安装/卸载 + 默认启用开关）；项目 = 项目启用列表（effective）。
 */

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

type SourceFlowNode = Node<SourceData, 'source'>;
type RuleFlowNode = Node<RuleData, 'rule'>;
type HandlerFlowNode = Node<HandlerData, 'handler'>;
type FlowNode = SourceFlowNode | RuleFlowNode | HandlerFlowNode;
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

const nodeTypes = {
  source: SourceNode,
  rule: RuleNode,
  handler: HandlerNode,
};

// macOS 风格迷你开关已提炼到 ui/switch.tsx（与插件区段共用）。

// ---------------------------------------------------------------------------
// 链路图布局（静态：列 x = 0/320/640，行 y 递增 100）
// ---------------------------------------------------------------------------

const COL_X = { source: 0, rule: 320, handler: 640 };
const ROW_Y = 100;

interface GraphCallbacks {
  onToggle: (id: string, enabled: boolean) => void;
}

function buildGraph(
  rules: HookRule[],
  projectById: Map<number, string>,
  t: ReturnType<typeof useT>,
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
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<OpenForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

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

  useEffect(() => {
    void refreshRules();
    api
      .listProjects()
      .then(setProjects)
      .catch(() => {});
  }, [refreshRules]);

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

  // ---- 链路图 ----
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);

  useEffect(() => {
    if (!rules) return;
    const built = buildGraph(rules, projectById, t, { onToggle: toggleRule });
    // 保留用户拖出来的节点位置，只更新数据 / 集合。
    setNodes((prev) => {
      const pos = new Map(prev.map((n) => [n.id, n.position]));
      return built.nodes.map((n) => {
        const p = pos.get(n.id);
        return p ? ({ ...n, position: p } as FlowNode) : n;
      });
    });
    setEdges(built.edges);
  }, [rules, projectById, t, toggleRule, setNodes]);

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

      {/* 链路图：事件源 → 规则 → 处理器 */}
      <Card>
        <CardHeader className="flex-col gap-1.5">
          <div className="flex w-full items-center gap-2">
            <CardTitle>{t('hooks.flowTitle')}</CardTitle>
            {rules && rules.length === 0 && (
              <span className="text-[11px] text-neutral-500">{t('hooks.emptyFlow')}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-500">
            <LegendChip icon={Zap} tone="text-amber-400" label={t('hooks.colSource')} />
            <LegendChip icon={Workflow} tone="text-blue-400" label={t('hooks.colRule')} />
            <LegendChip icon={ScrollText} tone="text-purple-300" label={t('hooks.colHandler')} />
          </div>
        </CardHeader>
        <CardContent className="p-2">
          <div className="h-80 rounded-lg border border-white/[0.06] bg-neutral-950/40">
            {/* 数据到位后才挂 ReactFlow — fitView 首帧就能对上铺满的图。 */}
            {nodes.length > 0 ? (
              <ReactFlow
                nodes={nodes}
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

      {/* 规则列表 */}
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
