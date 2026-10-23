import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  HARNESS_SESSION_CONTROL,
  HookRuleFilterSchema,
  HookRuleSourceSchema,
  HandlerConfigSchema,
  HookDispatchStatusSchema,
  isHarness,
  type Harness,
} from '@weavecode/core';
import {
  aliasOfModel,
  modelAliasTargets,
  type CaptureScriptHealth,
  type FileEdit,
  type MessagingSurface,
  type ModelAliasTarget,
  type PathRefSpec,
} from '@weavecode/harness';
import type { WeaveServerDeps } from './server.js';
import type { MessageAttachment, SessionDeliveryDiagnosis } from '../hooks/message-deliverer.js';
import { readBody, readJson, readRawBody, sendJson } from './http.js';
import { nextRunAt, parseCron } from './cron.js';
import { validateOrchestration } from '../hooks/orchestration-graph.js';
import { graphDirections, toRunSummary } from '../repositories/orchestrations.js';
import type {
  OrchestrationEdge,
  OrchestrationNode,
  OrchestrationRow,
  OrchestrationRunStatus,
} from '../repositories/orchestrations.js';
import { installPlugin, uninstallPlugin } from '../hooks/plugin-installer.js';
import { purgeSession } from '../hooks/session-purge.js';
import { composeAnswerAtoms } from '../hooks/answer-keys.js';
import { effective, setProjectEnabled } from '../hooks/plugin-project-state.js';
import { readDaemonSettingsSync, readHooksEnabled } from './settings.js';
import { openSessionTerminal, transcriptState } from './session-open.js';
import { claudeLivenessById, pidAliveOf } from './claude-liveness.js';
import {
  blockingPromptFor,
  captureSurfaces,
  commandsSurfaceFor,
  editSurfaceFor,
  messagingSurfaceFor,
  messagingSurfaces,
} from '../surfaces.js';
import { getDataDir } from '../db/paths.js';
import { maxUploadBytes, type UploadRow } from '../repositories/uploads.js';
import { defaultUploadSessions } from './upload-sessions.js';
import type { HookEventRow } from '../repositories/hook-events.js';
import { WEAVE_VERSION } from '../version.js';
import { DEFAULT_WATCH_ON } from '../repositories/session-watches.js';
import { readSideQuestions } from '../hooks/side-questions.js';
import { listDirOf, matchPaths, projectFileIndex } from './project-files.js';
import { resolveWithinProject } from '../install/reader.js';
import type { ProjectRow } from '../repositories/projects.js';

/**
 * D3 hooks 系统的全部 HTTP 路由（规则 CRUD/toggle、派发查询、会话列表/改名）。
 * 从 server.ts 主路由链中调用；返回 false 表示未命中，主链继续分发。
 */

/** 预览栏的字节上限（比资产读取小：预览只要头几十行，不需要整份大文件）。 */
const PREVIEW_MAX_BYTES = 4 * 1024 * 1024;

/** 文本预览上限：编辑器扛得动更大的，但一次预览不需要整份大文件。 */
const PREVIEW_MAX_TEXT_BYTES = 1024 * 1024;

/** 二进制嗅探窗：前这么多字节里出现 NUL 就当二进制（编辑器渲不出它，别塞乱码）。 */
const BINARY_SNIFF_BYTES = 8192;

/** 列表条数：缺省 100，封顶 200。 */
function clampLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(200, Math.floor(n));
}

/** 预览的图片类型；非图返回 null（调用方回落 text/plain）。 */
function imageTypeOf(relPath: string): string | null {
  const ext = relPath.slice(relPath.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return null;
  }
}

/** 会话 → 项目（路径引用的两条路由共用）：判定不过就写好响应并返回 null。 */
function projectOfSession(
  res: ServerResponse,
  deps: WeaveServerDeps,
  sessionId: string,
): ProjectRow | null {
  if (!deps.hookSessions || !deps.hookEvents) {
    sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
    return null;
  }
  const session = deps.hookSessions.getBySessionId(sessionId);
  if (!session) {
    sendJson(res, 404, { error: 'Session not found' });
    return null;
  }
  if (session.projectId == null) {
    sendJson(res, 400, { error: 'Session is not bound to a project' });
    return null;
  }
  const project = deps.projects.getById(session.projectId);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  return project;
}

/** harness 归属 = 最新事件的 source（与 open-terminal / 投递器同口径）。 */
function latestHarnessOf(deps: WeaveServerDeps, sessionId: string): Harness | null {
  if (!deps.hookEvents) return null;
  const latest = deps.hookEvents.listBySession(sessionId, 1);
  const src = latest[latest.length - 1]?.source;
  return isHarness(src) ? src : null;
}

/** 会话所属 harness 的路径引用面；没有文法时写好 409 并返回 null。 */
function pathRefSpecOf(
  res: ServerResponse,
  deps: WeaveServerDeps,
  sessionId: string,
): PathRefSpec | null {
  const src = latestHarnessOf(deps, sessionId);
  const surface = src ? messagingSurfaceFor(src) : null;
  const spec = surface?.pathRefs ?? null;
  if (spec) return spec;
  sendJson(res, 409, {
    error: src
      ? (surface?.unsupportedReasons?.pathRefs ?? `Harness "${src}" has no path reference syntax`)
      : 'Session has no hook events to determine its harness',
  });
  return null;
}

/** 正整数行号（`Number('')` 是 0，故先挡空串——缺省与非法要分开）。 */
function lineOf(raw: string | null): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 升序数组里二分查一条路径（索引几万到几十万条，Set 化一遍就是白占一份内存）。 */
function hasPath(sorted: readonly string[], target: string): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = sorted[mid]!;
    if (v === target) return true;
    if (v < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** 计划扫描窗口（最近的提交/写盘调用条数；一次计划模式只留最近的一两份）。 */
const PLAN_SCAN = 20;
/** 计划正文上限：超了截断（气泡要能渲染，别把几 MB 的文档塞进响应）。 */
const PLAN_MAX_CHARS = 200_000;

/** 事件 payload 里的工具三元组（坏 JSON → 全 null，交给 spec 判「不是计划」）。 */
function payloadTools(payload: string): [string | null, unknown, unknown] {
  try {
    const p = JSON.parse(payload) as { toolName?: unknown; toolInput?: unknown; toolResponse?: unknown };
    return [typeof p.toolName === 'string' ? p.toolName : null, p.toolInput ?? null, p.toolResponse ?? null];
  } catch {
    return [null, null, null];
  }
}

/** 现读计划文件（批准后宿主已删 = null；读不到不该让整条路由失败）。 */
function readPlanFile(path: string | null): string | null {
  if (!path) return null;
  try {
    const text = readFileSync(path, 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/**
 * 改动汇总的取数上限：一次对话可以改几百处、整份 Write 也不小，全量回给浏览器
 * 只会把面板拖死。超长的单处裁掉尾巴（前端标「已截断」），总额用完就不再取。
 */
const EDIT_MAX_FIELD_CHARS = 200_000;
const EDIT_MAX_TOTAL_CHARS = 4_000_000;

/** 展示路径：项目内的给相对（posix 分隔），项目外的保留绝对路径。 */
function displayEditPath(abs: string, projectPath: string): string {
  const rel = path.relative(projectPath, abs);
  const inside = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  return (inside ? rel : abs).split(path.sep).join('/');
}

interface SessionEditHunk {
  before: string;
  after: string;
  at: string | null;
  /** 单处超长被裁了尾巴（前端标「已截断」，不假装是全份）。 */
  clamped?: true;
}

/**
 * 按轮取数的窗口（`?since=&until=`，语义 **(since, until]**）：since 是上一条回复
 * 的 hook 时刻——它比上一轮最后的转录条目**晚** ~1s（hook 记晚一步），严格大于
 * 才能把上一轮收尾的改动排除在外；until 取闭包保证这一轮一条不漏。`at` 缺失或
 * 解析不了的改动没法归轮，范围视图里不摆（不带参的「全部」照旧全给）。
 */
function parseIsoParam(raw: string | null): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

function editInRange(at: string | null, since: number | null, until: number | null): boolean {
  if (since === null && until === null) return true;
  if (!at) return false;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return false;
  if (since !== null && t <= since) return false;
  if (until !== null && t > until) return false;
  return true;
}

/** 按文件汇总改动（首见序）；diff 还没算——那是 web 的事。 */
function summarizeEdits(
  records: readonly FileEdit[],
  projectPath: string,
): { files: Array<{ path: string; hunks: SessionEditHunk[] }>; hunks: number; truncated: boolean } {
  const files: Array<{ path: string; hunks: SessionEditHunk[] }> = [];
  const byPath = new Map<string, (typeof files)[number]>();
  let budget = EDIT_MAX_TOTAL_CHARS;
  let hunks = 0;
  let truncated = false;

  for (const record of records) {
    const clampedBefore = record.hunk.before.slice(0, EDIT_MAX_FIELD_CHARS);
    const clampedAfter = record.hunk.after.slice(0, EDIT_MAX_FIELD_CHARS);
    const clamped = clampedBefore.length < record.hunk.before.length || clampedAfter.length < record.hunk.after.length;
    if (clamped) truncated = true;
    const cost = clampedBefore.length + clampedAfter.length;
    if (cost > budget) {
      truncated = true;
      continue;
    }
    budget -= cost;
    const shown = displayEditPath(record.path, projectPath);
    let file = byPath.get(shown);
    if (!file) {
      file = { path: shown, hunks: [] };
      byPath.set(shown, file);
      files.push(file);
    }
    file.hunks.push({
      before: clampedBefore,
      after: clampedAfter,
      at: record.at,
      ...(clamped ? { clamped: true as const } : {}),
    });
    hunks++;
  }
  return { files, hunks, truncated };
}

const CreateRuleBody = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  projectId: z.number().int().nullable(),
  source: HookRuleSourceSchema,
  filter: HookRuleFilterSchema.optional(),
  handler: HandlerConfigSchema,
  timeoutMs: z.number().int().positive().optional(),
  record: z.boolean().optional(),
});

const UpdateRuleBody = CreateRuleBody.partial();

const ToggleBody = z.object({ enabled: z.boolean() });

/** 插件级开关：可选 projectId = 项目覆盖（写 meta.plugins.enabled，不动全局）。 */
const PluginToggleBody = z.object({ enabled: z.boolean(), projectId: z.number().int().optional() });

const RenameSessionBody = z.object({ title: z.string().min(1).max(200) });

/** 旁路会话（/btw）提问：形态校验（单行/长度）归 harness 的 SideQuestionSpec。 */
const SideQuestionBody = z.object({ question: z.string().min(1).max(4_000) });

const RunDispatchBody = z.object({ sessionId: z.string().min(1) });

/** 点对点消息投递（消息域重塑）：无模式入参——恒走 prompt 通道三层递送
 * （默认 = 原生 SendMessage 中继 + 未开会话积压队列；降级 = 终端 send-text，
 * 全自动）。inject/headless/auto 只活在编排域（序列步显式选项）。 */
const SendMessageBody = z.object({
  text: z.string().max(20_000),
  fromKind: z.enum(['dashboard', 'session']).optional(),
  fromSessionId: z.string().min(1).nullable().optional(),
  /** 随附文件（上传件 id）；带文件且目标 harness 的 `attach` 面不收该类型即 409。 */
  attachments: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(8).optional(),
  /** 旧名（图片随附）；与 `attachments` 等价，读侧合并。 */
  images: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(8).optional(),
  /** 强制层② 终端 send-text（发送人下拉选的通道；缺省 = 直投优先的自动层序）。 */
  forceTerminal: z.boolean().optional(),
});

/** 一次性上传（base64 JSON；内容寻址落 `data/uploads/<sha256>.<ext>`）。分块上传走
 *  `/uploads/begin` → `PUT /uploads/:id` → `/uploads/:id/finish`。 */
const UploadBody = z.object({
  name: z.string().min(1).max(200),
  mediaType: z.string().min(1).max(100),
  /** base64（无 data: 前缀）；字节数以解码后计。 */
  data: z.string().min(1),
});

/** 分块上传的开场：总长先报（服务端据此拒超限、判收完）。 */
const UploadBeginBody = z.object({
  name: z.string().min(1).max(200),
  mediaType: z.string().min(1).max(100),
  size: z.number().int().positive(),
});

/** 分块上限：一块 16MB，够大（大文件几百块）又不至于把内存顶爆。 */
const UPLOAD_CHUNK_MAX_BYTES = 16 * 1024 * 1024;

/** 上传件出参（不带落盘路径——路径是服务端的事，前端用 `/images/<id>` 取图）。 */
function toUploadDto(row: UploadRow): { id: string; name: string; mediaType: string; size: number } {
  return { id: row.id, name: row.name, mediaType: row.mediaType, size: row.size };
}

/** 阻塞问答作答：整 call 一次提交（含收尾屏的 Submit/Cancel 选项）——每问送选项
 *  下标（多选 = 勾选集，空 = 未作答）、输入行另带文本；键序由 harness 规格拼装，
 *  服务端白名单逐个原子校验后经终端通道打进 pane。 */
const AnswerBody = z.object({
  answers: z
    .array(
      z.object({
        questionKey: z.string().min(1),
        options: z.array(z.number().int().min(0)).max(32),
        /** 宿主自有「自定义输入」行的文本（该行会在终端进文本框）。 */
        text: z.string().max(2000).optional(),
      }),
    )
    .min(1),
});

/** 会话订阅：watcherSessionId 缺省 null = dashboard 订阅（fire 走 toast + 浏览器通知）；
 *  on = 触发类型集（缺省 idle，批 2 语义）。 */
const CreateWatchBody = z.object({
  watcherSessionId: z.string().min(1).nullable().optional(),
  notify: z.string().min(1).max(20_000).nullable().optional(),
  on: z.array(z.enum(['idle', 'turnEnd', 'messageFailed'])).min(1).optional(),
  /** 提醒次数：1..100；null = 持久化（不自动失效）；缺省 1（一次）。 */
  times: z.number().int().min(1).max(100).nullable().optional(),
});

const DeleteWatchBody = z.object({ watchId: z.number().int().positive() });

/** 模型切换：名字用户自填（网关模型 ID 会增删，不做静态映射表），形态由 deliverer 验。 */
const SetModelBody = z.object({ model: z.string().min(1).max(128) });
const SetEffortBody = z.object({ level: z.string().min(1).max(32) });

/** Web Push 订阅注册：endpoint = 浏览器推送服务分配的绝对 URL；keys = 载荷加密密钥对。 */
const SubscribePushBody = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

const UnsubscribePushBody = z.object({ endpoint: z.string().url() });

/** 跨会话编排的定义体：图规模/成环/方向形状由 `validateOrchestration` 判（错误文案归它）。 */
const OrchestrationNodeBody = z.object({
  /** session 节点 = sessionId；webhook = `w:<uuid>`；手动触发 = `t:<uuid>`。 */
  id: z.string().min(1).max(128),
  kind: z.enum(['session', 'webhook', 'trigger']),
  /** webhook 入口的触发 token（省略由仓储补发；回存已有 token 原样保留）。 */
  webhookToken: z.string().min(1).max(200).optional(),
  /** webhook 出口的出站目标与可选 HMAC 密钥。 */
  url: z.string().max(2_000).optional(),
  secret: z.string().max(400).optional(),
  /** session 中间节点也参与自然回合触发（入口恒可；webhook 节点设了无效）。 */
  autoFire: z.boolean().optional(),
});

const OrchestrationBody = z.object({
  name: z.string().min(1).max(200),
  startText: z.string().max(20_000).optional(),
  /** webhook-only 编排的项目归属（有 session 入口时恒从入口派生，给了不一致即拒）。 */
  projectId: z.number().int().optional(),
  nodes: z.array(OrchestrationNodeBody).min(1),
  edges: z.array(
    z.object({
      id: z.string().min(1).max(64),
      from: z.string().min(1),
      to: z.string().min(1),
      /** 空正文只在 webhook 入口的出边或设了提取指令的边上合法（`validateOrchestration` 判）。 */
      text: z.string().max(20_000),
      /** 本边提取指令（对上游会话 fork 无头回合产出 {summary}；空 = 不提取）。 */
      extract: z.string().max(4_000).optional(),
      /** 本边放行条件（对上游会话问 yes/no；no 或判不出都拦下不投）。 */
      condition: z.string().max(4_000).optional(),
      /** 本边文本预筛（{upstream} 命中任一关键词才继续/才 fork）。 */
      when: z.string().max(500).optional(),
    }),
  ),
  cron: z.string().max(200).nullish(),
  /** false = 停用：cron 不触发、入口会话的自然回合不自动启动。 */
  enabled: z.boolean().optional(),
});

const OrchestrationPatchBody = OrchestrationBody.partial();

const InstallBody = z.object({ src: z.string().min(1) });

/** 手动触发可带一条首步消息（缺省用编排自己的起始文本）与入口子集（缺省全部 session 入口）。 */
const TriggerBody = z.object({
  text: z.string().min(1).max(20_000).optional(),
  entries: z.array(z.string().min(1)).optional(),
});

/** 换某枚 webhook 入口节点的 token。 */
const RotateNodeBody = z.object({ nodeId: z.string().min(1).max(128) });

const RUN_STATUSES = new Set<OrchestrationRunStatus>([
  'running',
  'done',
  'failed',
  'cancelled',
  'interrupted',
]);

/** prompt 通道可用性（与投递裁决同口径）：宿主队列 || 层① 原生中继 || 层② 终端 send-text 兜底。 */
function promptChannelOf(surface: MessagingSurface, terminalChannel: boolean): boolean {
  return surface.queuedPrompt !== null || surface.prompt !== null || terminalChannel;
}

/** 中断后等宿主把标记写进转录的时间（实测 0.5s 落地，留一倍余量）。 */
const INTERRUPT_CONFIRM_WAIT_MS = 1_200;

/**
 * 中断标记等一拍再读：出现比打键前更新的标记 = 这一记 ESC 真让宿主停下来了。
 * 标记只会被更新的事件盖过（自愈），故「新标记」就是「刚停的」这一件事。
 */
async function confirmInterrupt(markerOf: () => number | null, before: number): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, INTERRUPT_CONFIRM_WAIT_MS));
  const after = markerOf();
  return after !== null && after > before;
}

function intParam(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** 编排行的对外形状：补一个「下次 cron 触发时刻」（现算，不落库）。 */
function withNextRun(row: OrchestrationRow) {
  const schedule = row.cron ? parseCron(row.cron) : null;
  return { ...row, nextRunAt: schedule ? nextRunAt(schedule) : null };
}

/**
 * 定义落库前的唯一闸（POST/PUT 同一份判据）：图合法（规模/可达/成环/方向形状）、
 * session 节点都还在管、cron 可解析。项目归属 = 入口 session 节点所属项目
 * （入口必须同项目，web 项目视图同判据）；webhook-only 编排由 body 显式给。
 */
function resolveOrchestration(
  deps: WeaveServerDeps,
  input: {
    name: string;
    startText?: string;
    projectId?: number;
    nodes: OrchestrationNode[];
    edges: OrchestrationEdge[];
    cron?: string | null;
  },
):
  | {
      ok: true;
      value: {
        name: string;
        projectId: number;
        startText: string;
        nodes: OrchestrationNode[];
        edges: OrchestrationEdge[];
        cron: string | null;
      };
    }
  | { ok: false; error: string } {
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Name is required' };
  const valid = validateOrchestration(input);
  if (!valid.ok) return { ok: false, error: valid.error };
  const cron = input.cron?.trim() || null;
  if (cron && !parseCron(cron)) return { ok: false, error: `Invalid cron expression: ${cron}` };
  for (const node of input.nodes) {
    if (node.kind !== 'session') continue;
    if (!deps.hookSessions?.getBySessionId(node.id)) {
      return { ok: false, error: `Unknown session: ${node.id}` };
    }
  }
  const { entries } = graphDirections(input.nodes, input.edges);
  const sessionEntries = entries.filter((e) => e.kind === 'session');
  let projectId = input.projectId ?? null;
  if (sessionEntries.length > 0) {
    const first = deps.hookSessions!.getBySessionId(sessionEntries[0]!.id)!;
    if (projectId != null && projectId !== first.projectId) {
      return { ok: false, error: 'projectId must match the entry sessions' };
    }
    projectId = first.projectId;
    if (projectId == null) return { ok: false, error: 'Entry session has no project' };
    for (const entry of sessionEntries) {
      if (deps.hookSessions!.getBySessionId(entry.id)!.projectId !== projectId) {
        return { ok: false, error: 'All entry sessions must belong to the same project' };
      }
    }
  } else {
    // 没有 session 入口（webhook 入口直挂 session / webhook-only）：项目归属
    // 回落到第一个 session 节点，纯 webhook 编排才要求显式给。
    const firstSession = input.nodes.find((n) => n.kind === 'session');
    if (firstSession) {
      projectId = deps.hookSessions!.getBySessionId(firstSession.id)!.projectId ?? projectId;
    }
  }
  if (projectId == null) {
    return { ok: false, error: 'projectId is required for webhook-only orchestrations' };
  }
  return {
    ok: true,
    value: {
      name,
      projectId,
      startText: (input.startText ?? '').trim(),
      nodes: input.nodes,
      edges: input.edges,
      cron,
    },
  };
}

/** 删定义/清日志前先停掉在飞的运行：运行态活着却没有行可写，只会静默失败。 */
function cancelRunsOf(deps: WeaveServerDeps, orchestrationId: number): void {
  for (const run of deps.orchestrationRuns?.listRunning() ?? []) {
    if (run.orchestrationId === orchestrationId) deps.orchestrationEngine?.cancel(run.id);
  }
}

/**
 * 投递诊断的「修法码」：每条 = 一个「消息为什么送不到」的成因（判定条件见
 * `MessageDeliverer.diagnose` 与 `CaptureScriptHealth`）。只出机器码，文案归 CLI/web。
 * 与通道 reason 重叠的不重复报（脚本压根不上报时，「没凭据」不是独立成因）。
 */
function deliveryHints(input: {
  diag: SessionDeliveryDiagnosis | null;
  capture: CaptureScriptHealth | null;
  eventCount: number;
}): string[] {
  const { diag, capture, eventCount } = input;
  const hints: string[] = [];
  if (!capture || capture.source === 'none' || !capture.present) hints.push('no-hook-script');
  else if (!capture.weaveOwned) hints.push('hook-script-not-weave');
  // 只有「该 harness 本来就有会话 inbox 通道」时，脚本不上报凭据才算陈旧——
  // 没有这个通道的 harness（codex）恒不上报，不是成因。
  else if (!capture.reportsInbox && diag?.inbox.reason !== 'no-mechanism') hints.push('hook-script-stale');
  if (eventCount === 0) hints.push('no-events');
  if (!diag) return hints;
  if (diag.alive === false) hints.push('not-running');
  if (diag.inbox.reason === 'no-credentials' && capture?.reportsInbox === true) {
    hints.push('no-inbox-credentials');
  }
  if (diag.inbox.reason === 'auth-token-required') hints.push('inbox-token-required');
  if (diag.relay.reason === 'no-peer-name') hints.push('no-peer-name');
  if (diag.terminal.reason === 'no-backend') hints.push('terminal-no-backend');
  if (diag.terminal.reason === 'no-pane-env') hints.push('terminal-no-pane-env');
  if (diag.pending > 0) hints.push('queued');
  if (diag.stalled) hints.push('stalled');
  return hints;
}

export async function handleHooksRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
  url: URL,
): Promise<boolean> {
  // 本路由器认领的路径前缀：漏一个就整条路由死在门外（2026-10-17 /uploads 与
  // /images 就是这么死的——分支写好了却没进这张表，一律 404 Not found）。
  const isOwnedPath =
    pathname.startsWith('/hooks/') ||
    pathname === '/dashboard/refresh' ||
    pathname === '/sessions' ||
    pathname.startsWith('/sessions/') ||
    pathname.startsWith('/messaging') ||
    pathname.startsWith('/webhooks/orchestrate/') ||
    pathname === '/uploads' ||
    pathname.startsWith('/uploads/') ||
    pathname.startsWith('/images/');
  if (!isOwnedPath) return false;

  // ---- 规则 CRUD ----
  if (pathname === '/hooks/rules') {
    if (!deps.hookRegistry) {
      sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    if (req.method === 'GET') {
      const projectIdRaw = url.searchParams.get('projectId');
      const projectId = projectIdRaw != null && projectIdRaw !== '' ? Number(projectIdRaw) : undefined;
      sendJson(res, 200, { rules: deps.hookRegistry.list(projectId) });
      return true;
    }
    if (req.method === 'POST') {
      try {
        const body = CreateRuleBody.parse(await readJson(req));
        const rule = deps.hookRegistry.create(body);
        sendJson(res, 201, { rule });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid rule body' });
      }
      return true;
    }
  }

  const ruleMatch = pathname.match(/^\/hooks\/rules\/([^/]+)$/);
  if (ruleMatch) {
    if (!deps.hookRegistry) {
      sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    const id = decodeURIComponent(ruleMatch[1]!);
    if (req.method === 'PUT') {
      try {
        const patch = UpdateRuleBody.parse(await readJson(req));
        const rule = deps.hookRegistry.update(id, patch);
        if (!rule) {
          sendJson(res, 404, { error: 'Rule not found' });
          return true;
        }
        sendJson(res, 200, { rule });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid rule body' });
      }
      return true;
    }
    if (req.method === 'DELETE') {
      if (!deps.hookRegistry.remove(id)) {
        sendJson(res, 404, { error: 'Rule not found' });
        return true;
      }
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  const toggleMatch = pathname.match(/^\/hooks\/rules\/([^/]+)\/toggle$/);
  if (toggleMatch && req.method === 'POST') {
    if (!deps.hookRegistry) {
      sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    try {
      const body = ToggleBody.parse(await readJson(req));
      const rule = deps.hookRegistry.setEnabled(decodeURIComponent(toggleMatch[1]!), body.enabled);
      if (!rule) {
        sendJson(res, 404, { error: 'Rule not found' });
        return true;
      }
      sendJson(res, 200, { rule });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
    }
    return true;
  }

  // ---- 插件管理面（SPI 加载结果 + 插件级开关 + 安装/卸载）----
  if (pathname === '/hooks/plugins') {
    if (req.method === 'GET') {
      const projectIdRaw = url.searchParams.get('projectId');
      if (projectIdRaw == null || projectIdRaw === '') {
        sendJson(res, 200, { plugins: deps.hookPlugins?.list() ?? [] });
        return true;
      }
      const project = deps.projects.getById(Number(projectIdRaw));
      if (!project) {
        sendJson(res, 404, { error: 'Project not found' });
        return true;
      }
      if (!deps.pluginStates) {
        sendJson(res, 503, { error: 'Plugin states unavailable' });
        return true;
      }
      const states = deps.pluginStates;
      sendJson(res, 200, {
        plugins: (deps.hookPlugins?.list() ?? []).map((info) => {
          if (info.status === 'rejected') return info;
          const status = effective(project, info.id, { states }) ? 'active' : 'disabled';
          return status === info.status ? info : { ...info, status };
        }),
      });
      return true;
    }
    if (req.method === 'POST') {
      // 安装：body { src } = 本地路径 | git URL → 复制进全局插件根 → 立即重扫
      if (!deps.hookPlugins) {
        sendJson(res, 503, { error: 'Plugin loader unavailable' });
        return true;
      }
      try {
        const body = InstallBody.parse(await readJson(req));
        const result = await installPlugin(body.src);
        await deps.hookPlugins.reloadAll();
        sendJson(res, 201, result);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Install failed' });
      }
      return true;
    }
  }

  const pluginUninstallMatch = pathname.match(/^\/hooks\/plugins\/([^/]+)\/uninstall$/);
  if (pluginUninstallMatch && req.method === 'POST') {
    if (!deps.hookPlugins) {
      sendJson(res, 503, { error: 'Plugin loader unavailable' });
      return true;
    }
    const id = decodeURIComponent(pluginUninstallMatch[1]!);
    const removed = await uninstallPlugin(id);
    if (!removed) {
      sendJson(res, 404, { error: 'Plugin directory not found' });
      return true;
    }
    await deps.hookPlugins.reloadAll();
    sendJson(res, 200, { ok: true });
    return true;
  }

  // 「重新扫描」：重登记根（运行期新登记项目）+ 重扫 + watcher 重挂。启动时不存在的
  // 根挂不上 watcher（见 plugin-loader 的 watchRoots），运行期才建起来的靠这一下纳管。
  if (pathname === '/hooks/plugins/rescan' && req.method === 'POST') {
    if (!deps.hookPlugins) {
      sendJson(res, 503, { error: 'Plugin loader unavailable' });
      return true;
    }
    try {
      await deps.hookPlugins.rescan();
      sendJson(res, 200, { ok: true, plugins: deps.hookPlugins.list().length });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'Rescan failed' });
    }
    return true;
  }

  const pluginToggleMatch = pathname.match(/^\/hooks\/plugins\/([^/]+)\/toggle$/);
  if (pluginToggleMatch && req.method === 'POST') {
    if (!deps.hookPlugins) {
      sendJson(res, 503, { error: 'Plugin loader unavailable' });
      return true;
    }
    try {
      const body = PluginToggleBody.parse(await readJson(req));
      const id = decodeURIComponent(pluginToggleMatch[1]!);
      if (body.projectId !== undefined) {
        const project = deps.projects.getById(body.projectId);
        if (!project) {
          sendJson(res, 404, { error: 'Project not found' });
          return true;
        }
        if (!deps.hookPlugins.list().some((p) => p.id === id)) {
          sendJson(res, 404, { error: 'Plugin not found' });
          return true;
        }
        setProjectEnabled(project, id, body.enabled, { projects: deps.projects });
        sendJson(res, 200, { ok: true });
        return true;
      }
      const ok = deps.hookPlugins.setPluginEnabled(id, body.enabled);
      if (!ok) {
        sendJson(res, 404, { error: 'Plugin not found' });
        return true;
      }
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
    }
    return true;
  }

  // ---- 派发记录 ----
  if (pathname === '/hooks/dispatches' && req.method === 'GET') {
    if (!deps.hookDispatches) {
      sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    const ruleId = url.searchParams.get('ruleId') ?? undefined;
    const statusRaw = url.searchParams.get('status');
    const status = statusRaw ? HookDispatchStatusSchema.parse(statusRaw) : undefined;
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;
    sendJson(res, 200, {
      dispatches: deps.hookDispatches.list({
        ruleId,
        status,
        sessionId,
        limit: Number.isFinite(limit) ? limit : undefined,
      }),
    });
    return true;
  }

  // ---- 指令池 resume：spawn claude --resume 后立即返回（「已启动」语义）----
  const runMatch = pathname.match(/^\/hooks\/dispatches\/(\d+)\/run$/);
  if (runMatch && req.method === 'POST') {
    if (!deps.hookRunner) {
      sendJson(res, 503, { error: 'Resume runner unavailable' });
      return true;
    }
    let sessionId: string;
    try {
      sessionId = RunDispatchBody.parse(await readJson(req)).sessionId;
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
      return true;
    }
    const result = await deps.hookRunner.run(Number(runMatch[1]!), sessionId);
    if (result.ok) {
      sendJson(res, 200, { ok: true, dispatchId: result.dispatchId });
    } else {
      sendJson(res, result.status, { error: result.error });
    }
    return true;
  }

  // ---- 会话列表 / 改名 ----
  // POST /dashboard/refresh — 空载荷的「重推一次」触发：SSE 连接早于仪表盘挂载，
  // 首连推送的分块会被错过；挂载时打这一枪让服务端按需重发（数据仍走 SSE）。
  if (pathname === '/dashboard/refresh' && req.method === 'POST') {
    deps.dashboardRefresh?.();
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/sessions' && req.method === 'GET') {
    if (!deps.hookSessions) {
      sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    const projectIdRaw = url.searchParams.get('projectId');
    const projectId = projectIdRaw != null && projectIdRaw !== '' ? Number(projectIdRaw) : undefined;
    const sessions = deps.hookSessions.listWithCounts(projectId);
    // claude 注册表判活随返回：true/false=判得动，null=判不动（codex/新鲜会话）不猜
    // （在途消息角标不在这里：走 SSE push 'inflightCounts'，见 InflightCountsRefresher）
    const liveness = claudeLivenessById();
    // 会话所在可见屏幕（列表分块）：探测要吃子进程，只能回隐藏刷新器的**上次快照**
    // （null = 反查不到，不分组），增量经 push 'terminalTopology' 到达——同角标口径。
    const screens = deps.terminalRefresher?.lastSnapshot?.terminals ?? {};
    // 模型别名 → 真名（claude 的 `ANTHROPIC_DEFAULT_<别名>_MODEL` 约定）：下拉要两个
    // 都摆，转录里照会的真名也得认回别名那档。按 harness 分面，各问各的词表。
    const catalog: Record<string, ModelAliasTarget[]> = {};
    for (const s of sessions) {
      const key = s.harness ?? '';
      if (key in catalog) continue;
      catalog[key] = modelAliasTargets(HARNESS_SESSION_CONTROL[s.harness as Harness]?.modelNames ?? []);
    }
    sendJson(res, 200, {
      sessions: sessions.map((s) => {
        const model = deps.sessionProbe?.currentModel(s.sessionId) ?? null;
        const present = deps.sessionProbe?.transcriptPresent(s.sessionId) ?? null;
        // 「在终端打开」的能力位：harness 的 resume 槽声明了交互式 openArgs 才有。
        // web 只渲染这个字段，不自带 harness 白名单（路由侧仍做同样的 501 校验）。
        const resume = isHarness(s.harness) ? deps.harnesses?.get(s.harness)?.resume : undefined;
        return {
          ...s,
          pidAlive: pidAliveOf(s, liveness),
          canOpenTerminal: !!(resume?.supported && resume.openArgs),
          terminal: screens[s.sessionId] ?? null,
          // 已中断（转录最后一条标记晚于最后一条事件）：只有「看着还在跑」的会话才现算
          interruptedAt:
            s.turnOpen === true ? (deps.sessionProbe?.interruptedAt(s.sessionId, s.lastSeenAt) ?? null) : null,
          // 当前模型：换模型落定由 `PostModelSwitch` 先说（标签立刻跟得上），转录
          // 只在 assistant 消息上照会——两边取更晚的那个；null = 不知道（不猜）。
          model,
          // 同一个模型的**别名**（`/model` 收的那个）：网关把别名换成自家 ID，转录里
          // 只见真名；认不出 = null，前端回落显示真名。
          modelAlias: aliasOfModel(catalog[s.harness ?? ''] ?? [], model),
          // 执行模式（事件自带的 permission_mode 优先、转录兜底）：切模式既不落转录、
          // 也没有专门事件，故是「最后已知」。
          mode: deps.sessionProbe?.currentMode(s.sessionId) ?? null,
          // 推理档位（hook 事件自带的 `effort.level`）：状态栏 `thinking` 块的事实，
          // 与模型/模式同口径（只放内存、最后已知、没上报过即 null）。
          effort: deps.sessionProbe?.currentEffort(s.sessionId) ?? null,
          // 转录还在不在（与 `claude --resume` 认的那份文件对齐）：false = 接不回来了，
          // 行内给提示、「打开」禁用；null = 判不动（该 harness 没有转录概念，或这个
          // 会话还没跑过——刚建的会话转录文件尚未写入，没内容不等于丢过）。
          transcriptPresent: transcriptState(present, s.hasRun),
        };
      }),
      modelCatalog: catalog,
    });
    return true;
  }

  const sessionMatch = pathname.match(/^\/sessions\/([^/]+)$/);
  if (sessionMatch && req.method === 'PATCH') {
    if (!deps.hookSessions) {
      sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    const sessionId = decodeURIComponent(sessionMatch[1]!);
    if (!deps.hookSessions.getBySessionId(sessionId)) {
      sendJson(res, 404, { error: 'Session not found' });
      return true;
    }
    try {
      const body = RenameSessionBody.parse(await readJson(req));
      const session = deps.hookSessions.setPendingTitle(sessionId, body.title);
      // 改名挂起/撤销即时进 mirror——不然要等到下一个 hook 事件才同步
      if (session?.projectId != null) deps.hookMirror?.syncProject(session.projectId);
      sendJson(res, 200, { session });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
    }
    return true;
  }

  // ---- 删会话（手动）：会话行 + 该会话的采集事件 + 指令池派发一并清 ----
  if (sessionMatch && req.method === 'DELETE') {
    if (!deps.hookSessions || !deps.hookEvents) {
      sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    const sessionId = decodeURIComponent(sessionMatch[1]!);
    const session = deps.hookSessions.getBySessionId(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found' });
      return true;
    }
    const purged = purgeSession(
      {
        sessions: deps.hookSessions,
        events: deps.hookEvents,
        dispatches: deps.hookDispatches,
        deliverer: deps.messageDeliverer,
        watches: deps.sessionWatches,
        orchestrations: deps.orchestrations,
        questions: deps.questionTracker,
        sideQuestions: deps.sideQuestions?.repo,
        probe: deps.sessionProbe,
        uploads: deps.uploads,
      },
      sessionId,
    );
    if (session.projectId != null) deps.hookMirror?.syncProject(session.projectId);
    sendJson(res, 200, { ok: true, sessionId, ...purged });
    return true;
  }

  // ---- 在默认终端打开会话：spawn 独立终端跑 harness 交互式 resume（如
  // `claude --resume <id>`）——opener 的 detached+unref 保证进程不随 daemon 退出 ----
  const openTermMatch = pathname.match(/^\/sessions\/([^/]+)\/open-terminal$/);
  if (openTermMatch && req.method === 'POST') {
    const sessionId = decodeURIComponent(openTermMatch[1]!);
    // 多终端弹窗选定的目标（可选）：定点附加到那个 tab；缺省 = 自动选落点。
    let target: string | undefined;
    try {
      const raw = (await readJson(req)) as { target?: unknown };
      if (typeof raw?.target === 'string' && raw.target) target = raw.target;
    } catch {
      // 空 body 合法（老前端不带 body）——不是 JSON 就当没给 target
    }
    const result = await openSessionTerminal(deps, sessionId, target);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      sessionId: result.sessionId,
      command: result.command,
      cwd: result.cwd,
      ...(result.target ? { target: result.target } : {}),
    });
    return true;
  }

  // ---- 分块上传（断点续传）：begin → 按 offset 顺序 PUT → finish ----
  const uploadSessions = deps.uploadSessions ?? defaultUploadSessions;
  if (pathname === '/uploads/begin' && req.method === 'POST') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    let body: z.infer<typeof UploadBeginBody>;
    try {
      body = UploadBeginBody.parse(await readJson(req));
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
      return true;
    }
    if (body.size > maxUploadBytes(body.mediaType)) {
      sendJson(res, 413, { error: 'File too large' });
      return true;
    }
    const begun = await uploadSessions.begin(body);
    sendJson(res, 201, { uploadId: begun.id, received: 0, size: begun.size });
    return true;
  }

  const finishMatch = pathname.match(/^\/uploads\/([0-9a-f-]{36})\/finish$/);
  if (finishMatch && req.method === 'POST') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    const info = await uploadSessions.finish(finishMatch[1]!);
    if (!info) {
      sendJson(res, 409, { error: 'Upload incomplete' });
      return true;
    }
    const row = await deps.uploads.adoptFromFile(info);
    await uploadSessions.abort(finishMatch[1]!);
    sendJson(res, 201, { upload: toUploadDto(row) });
    return true;
  }

  const chunkMatch = pathname.match(/^\/uploads\/([0-9a-f-]{36})$/);
  if (chunkMatch) {
    const uploadId = chunkMatch[1]!;
    if (req.method === 'GET') {
      const cur = await uploadSessions.get(uploadId);
      if (!cur) {
        sendJson(res, 404, { error: 'Upload not found' });
        return true;
      }
      sendJson(res, 200, { received: cur.received, size: cur.size, name: cur.name, mediaType: cur.mediaType });
      return true;
    }
    if (req.method === 'PUT') {
      const offset = Number(url.searchParams.get('offset') ?? '');
      if (!Number.isInteger(offset) || offset < 0) {
        sendJson(res, 400, { error: 'Invalid offset' });
        return true;
      }
      const bytes = await readRawBody(req, UPLOAD_CHUNK_MAX_BYTES).catch(() => null);
      if (!bytes) {
        sendJson(res, 413, { error: 'Chunk too large' });
        return true;
      }
      const result = await uploadSessions.append(uploadId, offset, bytes);
      if (result.kind === 'missing') {
        sendJson(res, 404, { error: 'Upload not found' });
        return true;
      }
      if (result.kind === 'conflict') {
        // 客户端拿着旧偏移：把真实长度回给它，从那儿续
        sendJson(res, 409, { received: result.received });
        return true;
      }
      if (result.kind === 'overflow') {
        sendJson(res, 413, { received: result.received, error: 'Exceeds declared size' });
        return true;
      }
      sendJson(res, 200, { received: result.received });
      return true;
    }
    if (req.method === 'DELETE') {
      await uploadSessions.abort(uploadId);
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  // ---- 会话上传件：一次性上传 / 回显（内容寻址 `data/uploads/`；上传 ≠ 投递） ----
  if (pathname === '/uploads' && req.method === 'POST') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    let body: z.infer<typeof UploadBody>;
    try {
      body = UploadBody.parse(await readJson(req));
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
      return true;
    }
    const bytes = Buffer.from(body.data, 'base64');
    if (bytes.length === 0) {
      sendJson(res, 400, { error: 'Empty upload' });
      return true;
    }
    if (bytes.length > maxUploadBytes(body.mediaType)) {
      sendJson(res, 413, { error: 'File too large' });
      return true;
    }
    const row = deps.uploads.save({ name: body.name, mediaType: body.mediaType, bytes });
    sendJson(res, 201, { upload: toUploadDto(row) });
    return true;
  }

  // ---- 对话附件存储清理（设置页）：按会话统计/删除 + 无引用件一键清 ----
  const sessionUploadsMatch = pathname.match(/^\/sessions\/([^/]+)\/uploads$/);
  if (sessionUploadsMatch && req.method === 'GET') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    const rows = deps.uploads.uploadsBySession(decodeURIComponent(sessionUploadsMatch[1]!));
    sendJson(res, 200, {
      uploads: (rows ?? []).map((r) => ({ ...toUploadDto(r), createdAt: r.createdAt })),
      totalBytes: (rows ?? []).reduce((sum, r) => sum + r.size, 0),
    });
    return true;
  }
  if (sessionUploadsMatch && req.method === 'DELETE') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    const rows = deps.uploads.uploadsBySession(decodeURIComponent(sessionUploadsMatch[1]!));
    if (!rows) {
      sendJson(res, 200, { removed: 0, freedBytes: 0 });
      return true;
    }
    const freedBytes = rows.reduce((sum, r) => sum + r.size, 0);
    const removed = deps.uploads.removeMany(rows.map((r) => r.id));
    deps.dataBus?.emit({ key: 'sessions' });
    sendJson(res, 200, { removed, freedBytes });
    return true;
  }

  if (pathname === '/uploads/unreferenced' && req.method === 'GET') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    sendJson(res, 200, deps.uploads.unreferencedStats());
    return true;
  }
  if (pathname === '/uploads/usage' && req.method === 'GET') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    sendJson(res, 200, { sessions: deps.uploads.usageBySession() });
    return true;
  }
  if (pathname === '/uploads/unreferenced' && req.method === 'POST') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    // 逐条回调只是给响应攒进度快照——HTTP 应答是一次性的，进度条由前端按
    // 「已清 / 预告数」自行推进，这里最后只报总数。
    let last = { done: 0, total: 0 };
    const removed = deps.uploads.cleanupUnreferenced((done, total) => {
      last = { done, total };
    });
    deps.dataBus?.emit({ key: 'sessions' });
    sendJson(res, 200, { removed, ...last });
    return true;
  }

  const imageMatch = pathname.match(/^\/images\/([a-f0-9]{64})$/);
  if (imageMatch && req.method === 'GET') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    const file = deps.uploads.fileStatOf(imageMatch[1]!);
    if (!file) {
      sendJson(res, 404, { error: 'Image not found' });
      return true;
    }
    // 内容寻址（id = sha256）→ 永不改写，可长缓存。流式回显：512MB 的附件
    // 不整份进内存，管道直灌（content-length 取 stat，不读内容）。
    res.writeHead(200, {
      'content-type': file.row.mediaType,
      'content-length': String(file.size),
      'cache-control': 'private, max-age=31536000, immutable',
    });
    const stream = createReadStream(file.file);
    stream.on('error', () => {
      if (typeof (res as { destroy?: unknown }).destroy === 'function') res.destroy();
    });
    stream.pipe(res);
    return true;
  }

  // ---- 消息域（消息域重塑：纯递送管道）：在途视图读 + 投递 ----
  const messagesMatch = pathname.match(/^\/sessions\/([^/]+)\/messages$/);
  if (messagesMatch) {
    const sessionId = decodeURIComponent(messagesMatch[1]!);
    if (req.method === 'GET') {
      if (!deps.messageDeliverer) {
        sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
        return true;
      }
      if (!deps.hookSessions?.getBySessionId(sessionId)) {
        sendJson(res, 404, { error: 'Session not found' });
        return true;
      }
      sendJson(res, 200, { messages: deps.messageDeliverer.listVisible(sessionId) });
      return true;
    }
    if (req.method === 'POST') {
      if (!deps.messageDeliverer || !deps.hookSessions) {
        sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
        return true;
      }
      let body: z.infer<typeof SendMessageBody>;
      try {
        body = SendMessageBody.parse(await readJson(req));
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
        return true;
      }
      // 两种入参名并存：`attachments` 是新名，`images` 是既有调用方的旧名
      const attachmentIds = [...(body.attachments ?? []), ...(body.images ?? [])];
      if (!body.text.trim() && attachmentIds.length === 0) {
        sendJson(res, 400, { error: 'Message is empty' });
        return true;
      }
      let attachments: MessageAttachment[] = [];
      if (attachmentIds.length > 0) {
        const refs = deps.uploads?.refsOf(attachmentIds) ?? null;
        if (!refs) {
          sendJson(res, 404, { error: 'Attachment not found' });
          return true;
        }
        attachments = refs;
      }
      const result = await deps.messageDeliverer.send({
        toSessionId: sessionId,
        text: body.text,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(body.forceTerminal === true ? { forceTerminal: true } : {}),
        mode: 'prompt',
        fromKind: body.fromKind ?? 'dashboard',
        fromSessionId: body.fromSessionId ?? null,
        // 手动面 = 单向注入：没有接收方会话，中继载荷带「无需回复」注记
        // （编排域不置 = 双向对话保留）。
        oneWay: true,
      });
      if (result.ok) {
        sendJson(res, 201, {
          ok: true,
          messageId: result.messageId,
          status: result.status,
          message: result.message,
        });
      } else {
        sendJson(res, result.status, { error: result.error });
      }
      return true;
    }
  }

  // ---- 计划模式：最近一次 ExitPlanMode 交出的计划正文（对话面板当气泡摆出来批阅）----
  const planMatch = pathname.match(/^\/sessions\/([^/]+)\/plan$/);
  if (planMatch && req.method === 'GET') {
    const sessionId = decodeURIComponent(planMatch[1]!);
    if (!deps.hookEvents) {
      sendJson(res, 503, { error: 'Hook ingestion unavailable' });
      return true;
    }
    // harness 归属 = 最新事件 source（同 open-terminal 口径）；没事件的会话没有计划
    const latest = deps.hookEvents.listBySession(sessionId, 1);
    const src = latest[latest.length - 1]?.source;
    const spec = isHarness(src) ? (blockingPromptFor(src)?.plan ?? null) : null;
    if (!spec) {
      sendJson(res, 200, { plan: null });
      return true;
    }
    // 正文两条来源：提交那次调用自己带的（老模型）/ 写计划文件那次调用带的
    // （2.1.296 起 tool_input 恒空，正文只在 Write 的 content 里）。事件里都没有
    // 就现读计划文件——它只在计划待批阅期间存在，批准后宿主会删。
    const scan = (rows: ReadonlyArray<Pick<HookEventRow, 'id' | 'createdAt' | 'payload'>>) =>
      rows.flatMap((row) => {
        const draft = spec.draftOf(...payloadTools(row.payload));
        return draft ? [{ row, draft }] : [];
      });
    const [commit] = scan(deps.hookEvents.listByTools(sessionId, [spec.tool], null, PLAN_SCAN));
    if (!commit) {
      sendJson(res, 200, { plan: null });
      return true;
    }
    // 只认**提交之前**的那次写盘：之后的写盘属于下一轮计划，拿它当这一份的正文
    // 就是张冠李戴（同一个会话可以来回好几轮计划模式）。
    const [write] = scan(
      deps.hookEvents.listByTools(sessionId, spec.writeTools, spec.fileHint, PLAN_SCAN),
    ).filter((w) => w.row.id < commit.row.id);
    const text =
      commit.draft.text ??
      readPlanFile(commit.draft.filePath) ??
      write?.draft.text ??
      readPlanFile(write?.draft.filePath ?? null);
    if (!text) {
      sendJson(res, 200, { plan: null });
      return true;
    }
    sendJson(res, 200, {
      plan: { eventId: commit.row.id, at: commit.row.createdAt, text: text.slice(0, PLAN_MAX_CHARS) },
    });
    return true;
  }

  // ---- 聊天窗口 `/` 的命令候选：内建 + 项目/用户命令 + skill（发现规则归 harness）----
  const commandsMatch = pathname.match(/^\/sessions\/([^/]+)\/commands$/);
  if (commandsMatch && req.method === 'GET') {
    const sessionId = decodeURIComponent(commandsMatch[1]!);
    const project = projectOfSession(res, deps, sessionId);
    if (!project) return true;
    const src = latestHarnessOf(deps, sessionId);
    const surface = src ? commandsSurfaceFor(src) : null;
    if (!surface) {
      sendJson(res, 200, { supported: false, commands: [] });
      return true;
    }
    sendJson(res, 200, { supported: true, commands: await surface.list({ projectPath: project.path }) });
    return true;
  }

  // ---- 命令执行的返显：内建命令不发 hook 事件，只有转录记着 ----
  const execMatch = pathname.match(/^\/sessions\/([^/]+)\/command-executions$/);
  if (execMatch && req.method === 'GET') {
    const sessionId = decodeURIComponent(execMatch[1]!);
    if (!projectOfSession(res, deps, sessionId)) return true;
    const src = latestHarnessOf(deps, sessionId);
    const surface = src ? commandsSurfaceFor(src) : null;
    if (!surface) {
      sendJson(res, 200, { supported: false, executions: null });
      return true;
    }
    const executions = await surface.executions(deps.sessionProbe?.transcriptPathOf(sessionId) ?? null);
    sendJson(res, 200, { supported: executions !== null, executions });
    return true;
  }

  // ---- 会话改动汇总：这次对话改了哪些文件、每处改了什么（diff 由 web 现算）----
  // 改动记在各 harness 自己的账本里（claude = 转录的 Edit/Write 调用），故取数走
  // 能力面；没有这个面的 harness 答 null，前端据此说明「为什么这里什么都没有」。
  const editsMatch = pathname.match(/^\/sessions\/([^/]+)\/edits$/);
  if (editsMatch && req.method === 'GET') {
    const sessionId = decodeURIComponent(editsMatch[1]!);
    const project = projectOfSession(res, deps, sessionId);
    if (!project) return true;
    const src = latestHarnessOf(deps, sessionId);
    const surface = src ? editSurfaceFor(src) : null;
    if (!surface) {
      sendJson(res, 200, { files: null, hunks: 0, truncated: false, reason: 'unsupported' });
      return true;
    }
    const records = await surface.sessionEdits({
      sessionId,
      transcriptPath: deps.sessionProbe?.transcriptPathOf(sessionId) ?? null,
    });
    if (!records) {
      sendJson(res, 200, { files: null, hunks: 0, truncated: false, reason: 'unreadable' });
      return true;
    }
    // 按轮取数：前端把「上一次回复 → 这一次回复」的窗口带上来（不带 = 全部）
    const since = parseIsoParam(url.searchParams.get('since'));
    const until = parseIsoParam(url.searchParams.get('until'));
    const ranged = since !== null || until !== null ? records.filter((r) => editInRange(r.at, since, until)) : records;
    sendJson(res, 200, summarizeEdits(ranged, project.path));
    return true;
  }

  // ---- 路径引用：项目文件索引（打开即重建的面，不常驻、不进 DataKey） ----
  // 表达式归 harness：`ref` 由能力面现算，web 只把它当不透明字符串贴进输入框。
  const filesMatch = pathname.match(/^\/sessions\/([^/]+)\/files$/);
  if (filesMatch && req.method === 'GET') {
    const sessionId = decodeURIComponent(filesMatch[1]!);
    const project = projectOfSession(res, deps, sessionId);
    if (!project) return true;
    const refSpec = pathRefSpecOf(res, deps, sessionId);
    if (!refSpec) return true;

    // 打开选择器那一拍带 `fresh=1`：索引立刻重建一次，之后按 git 指纹重验
    const index = await projectFileIndex(project.id, project.path, {
      fresh: url.searchParams.get('fresh') === '1',
    });
    const q = url.searchParams.get('q') ?? '';
    const dir = (url.searchParams.get('dir') ?? '').replace(/^\/+|\/+$/g, '');
    const limit = clampLimit(url.searchParams.get('limit'));
    const toEntry = (p: string, kind: 'file' | 'dir', ranges?: [number, number][]) => ({
      path: p,
      name: p.slice(p.lastIndexOf('/') + 1),
      kind,
      ref: refSpec.expression({ path: p, kind }),
      ...(ranges ? { ranges } : {}),
    });

    // 搜索模式：全索引模糊匹配，不带 size/mtime（100 条 stat 每键一次太贵）
    if (q.trim()) {
      const { hits, total, capped } = await matchPaths(index, q, limit);
      sendJson(res, 200, {
        root: project.path,
        dir: '',
        total,
        capped,
        truncated: index.truncated,
        entries: hits.map((h) => toEntry(h.path, h.kind, h.ranges)),
      });
      return true;
    }

    // 目录浏览模式：直接子项，文件补 size/mtime（≤200 条，一次并行 stat）
    const children = listDirOf(index, dir);
    const entries = await Promise.all(
      children.slice(0, limit).map(async (c) => {
        const base = toEntry(c.path, c.kind);
        if (c.kind !== 'file') return base;
        try {
          const s = await stat(path.join(project.path, c.path));
          return { ...base, size: s.size, mtime: s.mtime.toISOString() };
        } catch {
          return base;
        }
      }),
    );
    sendJson(res, 200, {
      root: project.path,
      dir,
      total: children.length,
      capped: false,
      truncated: index.truncated,
      entries,
    });
    return true;
  }

  // ---- 路径引用的表达式：带行区间时由这里现算（前端不拼 `#L` 这类文法） ----
  const refMatch = pathname.match(/^\/sessions\/([^/]+)\/ref$/);
  if (refMatch && req.method === 'GET') {
    const sessionId = decodeURIComponent(refMatch[1]!);
    if (!projectOfSession(res, deps, sessionId)) return true;
    const refSpec = pathRefSpecOf(res, deps, sessionId);
    if (!refSpec) return true;
    const relPath = (url.searchParams.get('path') ?? '').replace(/^\/+|\/+$/g, '');
    if (!relPath) {
      sendJson(res, 400, { error: 'Missing "path" query parameter' });
      return true;
    }
    const kind = url.searchParams.get('kind') === 'dir' ? 'dir' : 'file';
    if (!refSpec.kinds.includes(kind)) {
      sendJson(res, 409, { error: `Harness does not accept "${kind}" references` });
      return true;
    }
    const start = lineOf(url.searchParams.get('start'));
    const end = lineOf(url.searchParams.get('end'));
    if (!refSpec.lines) {
      sendJson(res, 200, { ref: refSpec.expression({ path: relPath, kind }) });
      return true;
    }
    if (start == null) {
      sendJson(res, 200, { ref: refSpec.expression({ path: relPath, kind }) });
      return true;
    }
    if (end != null && end < start) {
      sendJson(res, 400, { error: '"end" must not precede "start"' });
      return true;
    }
    sendJson(res, 200, {
      ref: refSpec.expression({ path: relPath, kind, lines: { start, end: end ?? start } }),
    });
    return true;
  }

  // ---- 反向认引用：一段现成文本里的表达式还原成「路径 + 类型 + 行区间」 ----
  // 粘贴 / 取回队列消息时前端要把 `@src/a.ts#L3-5` 摆成胶囊，而语法是 harness 知识：
  // 文法由 `recognize` 认、存在性由文件索引判（索引里没有的路径不算引用），
  // web 只拿到「哪一段、换成什么胶囊」。
  const recognizeMatch = pathname.match(/^\/sessions\/([^/]+)\/refs\/recognize$/);
  if (recognizeMatch && req.method === 'POST') {
    const sessionId = decodeURIComponent(recognizeMatch[1]!);
    const project = projectOfSession(res, deps, sessionId);
    if (!project) return true;
    const refSpec = pathRefSpecOf(res, deps, sessionId);
    if (!refSpec) return true;
    let text = '';
    try {
      const body = (await readJson(req)) as { text?: unknown };
      text = typeof body?.text === 'string' ? body.text : '';
    } catch {
      sendJson(res, 400, { error: 'Body must be JSON' });
      return true;
    }
    const index = await projectFileIndex(project.id, project.path);
    const refs: {
      start: number;
      end: number;
      ref: string;
      path: string;
      kind: 'file' | 'dir';
      lines?: { start: number; end: number };
    }[] = [];
    for (const hit of refSpec.recognize(text)) {
      // 索引里真有这条路径才算引用（否则 `@types/node` 这类字样也会变胶囊）
      const kind =
        hit.kind === 'dir' && hasPath(index.dirs, hit.path)
          ? 'dir'
          : hasPath(index.files, hit.path)
            ? 'file'
            : null;
      if (!kind || !refSpec.kinds.includes(kind)) continue;
      const lines = hit.lines && refSpec.lines ? hit.lines : undefined;
      refs.push({
        start: hit.start,
        end: hit.end,
        // 归一：`@docs` 与 `@docs/` 都摆成文法那种形状
        ref: refSpec.expression({ path: hit.path, kind, ...(lines ? { lines } : {}) }),
        path: hit.path,
        kind,
        ...(lines ? { lines } : {}),
      });
    }
    sendJson(res, 200, { refs });
    return true;
  }

  // ---- 路径引用的预览：项目根内的只读字节流 ----
  // 与 `/projects/:id/file` 分开：那条只认资产白名单（`.claude/` 等），预览要读源码。
  // 这里的收窄 = 项目根 containment + 大小上限 + Content-Type 白名单（非图一律
  // text/plain——绝不下发 text/html，否则等于把 dashboard origin 交给任意项目文件）。
  const fileMatch = pathname.match(/^\/sessions\/([^/]+)\/file$/);
  if (fileMatch && req.method === 'GET') {
    const sessionId = decodeURIComponent(fileMatch[1]!);
    const project = projectOfSession(res, deps, sessionId);
    if (!project) return true;
    const relPath = url.searchParams.get('path');
    if (!relPath) {
      sendJson(res, 400, { error: 'Missing "path" query parameter' });
      return true;
    }
    let abs: string;
    try {
      abs = resolveWithinProject(project.path, relPath);
    } catch {
      sendJson(res, 403, { error: 'Path escapes the project' });
      return true;
    }
    let info;
    try {
      info = await stat(abs);
    } catch {
      sendJson(res, 404, { error: 'File not found' });
      return true;
    }
    if (!info.isFile()) {
      sendJson(res, 404, { error: 'Not a file' });
      return true;
    }
    if (info.size > PREVIEW_MAX_BYTES) {
      sendJson(res, 413, { error: 'File too large to preview' });
      return true;
    }
    const image = imageTypeOf(relPath);
    let bytes = await readFile(abs);
    if (!image) {
      // 二进制（NUL 打头那种）不给编辑器：CM 渲出来是一片乱码占位符，不如明说没有预览
      if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        sendJson(res, 415, { error: 'Binary file' });
        return true;
      }
      // 文本按上限截断，且切在行边界上——切在半个字符里会让整段变成替换符
      if (bytes.length > PREVIEW_MAX_TEXT_BYTES) {
        const cut = bytes.subarray(0, PREVIEW_MAX_TEXT_BYTES);
        const nl = cut.lastIndexOf(10);
        bytes = nl > 0 ? cut.subarray(0, nl) : cut;
        res.setHeader('x-weave-truncated', '1');
      }
    }
    res.writeHead(200, {
      'content-type': image ?? 'text/plain; charset=utf-8',
      'content-length': String(bytes.length),
      'cache-control': 'private, max-age=60',
    });
    res.end(bytes);
    return true;
  }

  // ---- 手动重发（暂停闸解除动作）：prompt 通道 failed / delivered-未回执 才可重发 ----
  const resendMatch = pathname.match(/^\/sessions\/([^/]+)\/messages\/([^/]+)\/resend$/);
  if (resendMatch && req.method === 'POST') {
    if (!deps.messageDeliverer) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const result = await deps.messageDeliverer.resend(decodeURIComponent(resendMatch[2]!));
    if (result.ok) {
      sendJson(res, 200, { ok: true, messageId: result.messageId, status: result.status, message: result.message });
    } else {
      sendJson(res, result.status, { error: result.error });
    }
    return true;
  }

  // ---- 删除在途视图里的消息行（暂停闸成因也能删：删即解闸并续排空；
  //      队列待递送行删 = 取消发送）----
  const dismissMatch = pathname.match(/^\/sessions\/([^/]+)\/messages\/([^/]+)\/dismiss$/);
  if (dismissMatch && req.method === 'POST') {
    if (!deps.messageDeliverer) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const result = deps.messageDeliverer.dismiss(
      decodeURIComponent(dismissMatch[1]!),
      decodeURIComponent(dismissMatch[2]!),
    );
    if (result.ok) {
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, result.status, { error: result.error });
    }
    return true;
  }

  // ---- 阻塞问答：待答清单（AskUserQuestion / 计划确认 / 权限确认的实时状态）----
  if (pathname === '/messaging/questions' && req.method === 'GET') {
    if (!deps.questionTracker) {
      sendJson(res, 503, { error: 'Question tracking unavailable' });
      return true;
    }
    sendJson(res, 200, { questions: deps.questionTracker.snapshot() });
    return true;
  }

  // ---- 阻塞问答作答：选项下标 → harness 拼的键序 → 终端 pane（模态框只吃键盘）----
  const answerMatch = pathname.match(/^\/sessions\/([^/]+)\/answer$/);
  if (answerMatch && req.method === 'POST') {
    if (!deps.questionTracker || !deps.messageDeliverer) {
      sendJson(res, 503, { error: 'Question tracking unavailable' });
      return true;
    }
    const sessionId = decodeURIComponent(answerMatch[1]!);
    let body: z.infer<typeof AnswerBody>;
    try {
      body = AnswerBody.parse(await readJson(req));
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
      return true;
    }
    const entry = deps.questionTracker.get(sessionId);
    if (!entry) {
      sendJson(res, 409, { error: 'Session has no pending question' });
      return true;
    }
    const composed = composeAnswerAtoms(entry.questions, body.answers);
    if (!composed.ok) {
      sendJson(res, 400, { error: composed.error });
      return true;
    }
    const result = await deps.messageDeliverer.answer(sessionId, composed.atoms);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    // 乐观落位：作答成功即整条摘除（PostToolUse 到达照常再清一次）——防重复作答
    // 把键序打进已关的模态框、漏进输入框执行。
    deps.questionTracker.markAnswered(sessionId);
    sendJson(res, 200, { ok: true, sessionId });
    return true;
  }

  // ---- 中断：向会话 pane 打一记 ESC（停止正在跑的回合；键序固定死在服务端）----
  const interruptMatch = pathname.match(/^\/sessions\/([^/]+)\/interrupt$/);
  if (interruptMatch && req.method === 'POST') {
    if (!deps.messageDeliverer) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const sessionId = decodeURIComponent(interruptMatch[1]!);
    // 「停没停」的唯一证据在转录里（hook 域没有中断事件）。判不了（没探针 / 转录
    // 路径未知 / 非 claude）就只报送出，不猜结果。
    const probe = deps.sessionProbe;
    const session = deps.hookSessions?.getBySessionId(sessionId) ?? null;
    const judgeable = !!probe && !!session && probe.transcriptPresent(sessionId) !== null;
    const markerOf = (): number | null =>
      judgeable ? (probe!.interruptedAt(sessionId, session!.lastSeenAt) ?? null) : null;
    const before = markerOf() ?? 0;

    const result = await deps.messageDeliverer.interrupt(sessionId);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    // 一记没反应就按标题+cwd 补打一记（**只打别的 pane**）：pane env 指着旧 pane
    // 时第一记落进的是别人的输入行，宿主一声不响，投递侧却照样拿 exit 0 —— 实机
    // 2026-10-21：8c85b9c7 连按三次 200 全无效果，而同一分钟另一会话 0.5 秒即中断。
    let interrupted: boolean | null = null;
    if (judgeable) {
      interrupted = await confirmInterrupt(markerOf, before);
      if (interrupted === false) {
        const retry = await deps.messageDeliverer.interrupt(sessionId, 'heuristic', result.paneId);
        if (retry.ok && retry.sent) interrupted = await confirmInterrupt(markerOf, before);
      }
    }
    // 打断之后 claude 要过一下才把中断标记写进转录：补一拍探针，让「生成中」尽快
    // 变成「已中断」（不补则要等下一个周期）。同 terminalTopology 的即时刷新口径。
    setTimeout(() => deps.interruptRefresher?.tick(), 1_500);
    sendJson(res, 200, { ok: true, sessionId, interrupted });
    return true;
  }

  // ---- 关 pane：会话生命周期收尾（宿主随 pane 一起退出；会话行与它的对话照常保留）----
  const closePaneMatch = pathname.match(/^\/sessions\/([^/]+)\/close-pane$/);
  if (closePaneMatch && req.method === 'POST') {
    if (!deps.messageDeliverer) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const sessionId = decodeURIComponent(closePaneMatch[1]!);
    const result = await deps.messageDeliverer.closePane(sessionId);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    // pane 没了 = 会话进程也没了，而这两件事都不发 hook 事件：补一拍判活与终端
    // 分块，让「活着」的图标与分组尽快摘掉（不补则要等 15s/30s 的周期拍）。
    setTimeout(() => {
      deps.livenessRefresher?.tick();
      void deps.terminalRefresher?.refreshNow();
    }, 600);
    sendJson(res, 200, { ok: true, sessionId });
    return true;
  }

  // ---- 执行模式切换：一记 Shift+Tab（宿主自己算下一个模式；键序固定死在服务端）----
  const modeMatch = pathname.match(/^\/sessions\/([^/]+)\/mode$/);
  if (modeMatch && req.method === 'POST') {
    if (!deps.messageDeliverer) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const sessionId = decodeURIComponent(modeMatch[1]!);
    const result = await deps.messageDeliverer.cycleMode(sessionId);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    sendJson(res, 200, { ok: true, sessionId });
    return true;
  }

  // ---- 模型切换：宿主自己的 `/model <名>`（会话级、不落盘）----
  const modelMatch = pathname.match(/^\/sessions\/([^/]+)\/model$/);
  if (modelMatch && req.method === 'POST') {
    if (!deps.messageDeliverer) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const sessionId = decodeURIComponent(modelMatch[1]!);
    const body = SetModelBody.parse(await readJson(req));
    const result = await deps.messageDeliverer.setModel(sessionId, body.model);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    // 换模型会写一条 assistant 记录进转录：补一拍探针，让「当前模型」尽快跟上。
    setTimeout(() => deps.interruptRefresher?.tick(), 1_500);
    sendJson(res, 200, { ok: true, sessionId });
    return true;
  }

  // ---- 思考强度调整：宿主自己的 `/effort <档位>`（档位过 core 表词表白名单）----
  const effortMatch = pathname.match(/^\/sessions\/([^/]+)\/effort$/);
  if (effortMatch && req.method === 'POST') {
    if (!deps.messageDeliverer) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const sessionId = decodeURIComponent(effortMatch[1]!);
    const body = SetEffortBody.parse(await readJson(req));
    const result = await deps.messageDeliverer.setEffort(sessionId, body.level);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    sendJson(res, 200, { ok: true, sessionId });
    return true;
  }

  // ---- 旁路会话（claude = /btw）：问句经层② 终端打进 pane ----
  // 宿主侧问开着 skipTranscript，问与答**都不落盘**（面板历史只在宿主内存里），
  // 所以问句只有 weave 自己发过才知道——落 side_questions 是这条历史的唯一出处。
  const sideAskMatch = pathname.match(/^\/sessions\/([^/]+)\/side-question$/);
  if (sideAskMatch && req.method === 'POST') {
    if (!deps.messageDeliverer || !deps.sideQuestions) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const sessionId = decodeURIComponent(sideAskMatch[1]!);
    let body: z.infer<typeof SideQuestionBody>;
    try {
      body = SideQuestionBody.parse(await readJson(req));
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
      return true;
    }
    const result = await deps.messageDeliverer.askSideQuestion(sessionId, body.question);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    const row = deps.sideQuestions.repo.insert({
      sessionId,
      projectId: deps.hookSessions?.getBySessionId(sessionId)?.projectId ?? null,
      question: result.question,
    });
    sendJson(res, 200, { ok: true, sideQuestion: row });
    return true;
  }

  const sideListMatch = pathname.match(/^\/sessions\/([^/]+)\/side-questions$/);
  if (sideListMatch && req.method === 'GET') {
    if (!deps.sideQuestions) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const sessionId = decodeURIComponent(sideListMatch[1]!);
    const limitRaw = Number(url.searchParams.get('limit'));
    const beforeRaw = Number(url.searchParams.get('beforeId'));
    const rows = readSideQuestions(deps.sideQuestions, sessionId, {
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20,
      beforeId: Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : undefined,
    });
    sendJson(res, 200, { sideQuestions: rows });
    return true;
  }

  // ---- 空闲订阅域（session-orchestration 批 2）：one-shot「空闲时提醒我」 ----
  const watchMatch = pathname.match(/^\/sessions\/([^/]+)\/watch$/);
  if (watchMatch) {
    const sessionId = decodeURIComponent(watchMatch[1]!);
    if (req.method === 'POST') {
      if (!deps.sessionWatches || !deps.hookSessions || !deps.hookEvents) {
        sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
        return true;
      }
      let body: z.infer<typeof CreateWatchBody>;
      try {
        body = CreateWatchBody.parse(await readJson(req));
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
        return true;
      }
      const target = deps.hookSessions.getBySessionId(sessionId);
      if (!target) {
        sendJson(res, 404, { error: 'Session not found' });
        return true;
      }
      // 目标 harness = 最新事件 source（与 open-terminal / 消息投递同口径）
      const latest = deps.hookEvents.listBySession(sessionId, 1);
      const targetSrc = latest[latest.length - 1]?.source;
      if (!isHarness(targetSrc)) {
        sendJson(res, 400, { error: 'Session has no hook events to determine its harness' });
        return true;
      }
      const targetSurface = messagingSurfaceFor(targetSrc);
      const on = body.on ?? [...DEFAULT_WATCH_ON];
      // 按订阅类型逐个验通道：空闲/回合结束要 idleSignals（批 2 判据）；
      // 投递失败要该会话「可被投递」（prompt 列 || inject/headless），否则永不可达。
      if ((on.includes('idle') || on.includes('turnEnd')) && targetSurface.idleSignals.length === 0) {
        sendJson(
          res,
          409,
          { error: targetSurface.unsupportedReasons?.watch ?? `Harness "${targetSrc}" does not support idle watching` },
        );
        return true;
      }
      if (on.includes('messageFailed')) {
        const messageable =
          promptChannelOf(targetSurface, deps.messageDeliverer?.hasTerminalChannel() ?? false) ||
          targetSurface.inject !== null ||
          targetSurface.headless !== null;
        if (!messageable) {
          sendJson(res, 409, {
            error:
              targetSurface.unsupportedReasons?.prompt ??
              `Harness "${targetSrc}" supports no messaging channel`,
          });
          return true;
        }
      }
      // 会话订阅方：通知注入它的 inject 通道必须在场（否则 fire 时必然无声丢弃）
      if (body.watcherSessionId) {
        const watcher = deps.hookSessions.getBySessionId(body.watcherSessionId);
        if (!watcher) {
          sendJson(res, 404, { error: 'Watcher session not found' });
          return true;
        }
        const watcherLatest = deps.hookEvents.listBySession(body.watcherSessionId, 1);
        const watcherSrc = watcherLatest[watcherLatest.length - 1]?.source;
        if (!isHarness(watcherSrc)) {
          sendJson(res, 400, { error: 'Watcher session has no hook events to determine its harness' });
          return true;
        }
        const watcherSurface = messagingSurfaceFor(watcherSrc);
        if (!watcherSurface.inject) {
          sendJson(
            res,
            409,
            { error: watcherSurface.unsupportedReasons?.inject ?? `Harness "${watcherSrc}" cannot receive watch notifications` },
          );
          return true;
        }
      }
      // dashboard 订阅（watcherSessionId null）按「每目标至多一行」upsert：同目标
      // 已有 pending dashboard 行 → 原行改写类型集/次数（id/createdAt 不动），不再
      // 插影子行——否则旧行在 UI 里不可见但仍会 fire。会话订阅方多行合法，走 insert。
      const times = body.times === undefined ? 1 : body.times;
      const existing =
        (body.watcherSessionId ?? null) === null
          ? deps.sessionWatches
              .listPendingByTarget(sessionId)
              .find((w) => w.watcherSessionId === null)
          : undefined;
      const updated = existing
        ? deps.sessionWatches.updateById(existing.id, { onEvents: on, remaining: times })
        : undefined;
      // existing 在读取到写入之间恰好落定（并发 fire 改了 fired_at）→ 退回新订阅
      const watch = updated ??
        deps.sessionWatches.insert({
          watcherSessionId: body.watcherSessionId ?? null,
          targetSessionId: sessionId,
          notify: body.notify ?? null,
          onEvents: on,
          times,
        });
      // 目标此刻已空闲 → 立即 fire（不等下一拍；one-shot 语义即「答案就是现在」）
      deps.watchEngine?.created(watch);
      sendJson(res, updated ? 200 : 201, { ok: true, watchId: watch.id, watch });
      return true;
    }
    if (req.method === 'DELETE') {
      if (!deps.sessionWatches) {
        sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
        return true;
      }
      let body: z.infer<typeof DeleteWatchBody>;
      try {
        body = DeleteWatchBody.parse(await readJson(req));
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
        return true;
      }
      const row = deps.sessionWatches.getById(body.watchId);
      if (!row || row.targetSessionId !== sessionId || row.firedAt !== null) {
        sendJson(res, 404, { error: 'Watch not found' });
        return true;
      }
      deps.sessionWatches.deleteById(body.watchId);
      sendJson(res, 200, { ok: true, watchId: body.watchId });
      return true;
    }
  }

  // ---- 订阅面查询：pending 全量（web 按 watcherSessionId 过滤 dashboard 行） ----
  if (pathname === '/messaging/watches' && req.method === 'GET') {
    if (!deps.sessionWatches) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    sendJson(res, 200, { watches: deps.sessionWatches.listPending() });
    return true;
  }

  // ---- Web Push（提醒第三条腿）：applicationServerKey + 浏览器订阅注册/撤销 ----
  if (pathname === '/messaging/push/key' && req.method === 'GET') {
    if (!deps.pushNotifier) {
      sendJson(res, 503, { error: 'Push subsystem unavailable' });
      return true;
    }
    sendJson(res, 200, { publicKey: deps.pushNotifier.publicKey() });
    return true;
  }

  if (pathname === '/messaging/push/subscribe' && req.method === 'POST') {
    if (!deps.pushSubscriptions) {
      sendJson(res, 503, { error: 'Push subsystem unavailable' });
      return true;
    }
    try {
      const body = SubscribePushBody.parse(await readJson(req));
      const subscription = deps.pushSubscriptions.upsert({
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent: req.headers['user-agent'] ?? null,
      });
      sendJson(res, 201, { ok: true, subscription });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
    }
    return true;
  }

  if (pathname === '/messaging/push/unsubscribe' && req.method === 'POST') {
    if (!deps.pushSubscriptions) {
      sendJson(res, 503, { error: 'Push subsystem unavailable' });
      return true;
    }
    try {
      const body = UnsubscribePushBody.parse(await readJson(req));
      deps.pushSubscriptions.deleteByEndpoint(body.endpoint);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
    }
    return true;
  }

  // ---- 编排域：跨会话编排的定义、触发、运行日志 ----
  if (pathname === '/messaging/orchestrations') {
    if (!deps.orchestrations) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    if (req.method === 'GET') {
      const projectId = intParam(url, 'projectId');
      const rows =
        projectId === undefined
          ? deps.orchestrations.list()
          : deps.orchestrations.listByProject(projectId);
      sendJson(res, 200, { orchestrations: rows.map(withNextRun) });
      return true;
    }
    if (req.method === 'POST') {
      let body: z.infer<typeof OrchestrationBody>;
      try {
        body = OrchestrationBody.parse(await readJson(req));
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
        return true;
      }
      const resolved = resolveOrchestration(deps, body);
      if (!resolved.ok) {
        sendJson(res, 400, { error: resolved.error });
        return true;
      }
      sendJson(res, 201, {
        ok: true,
        // enabled 不在 resolve 的字段里（insert 默认启用）：建「默认停用」的编排
        // 必须透传，否则入口会话的下一个自然回合就会自动触发
        orchestration: withNextRun(
          deps.orchestrations.insert({ ...resolved.value, enabled: body.enabled }),
        ),
      });
      return true;
    }
  }

  const orchestrationMatch = pathname.match(/^\/messaging\/orchestrations\/(\d+)$/);
  if (orchestrationMatch) {
    const id = Number(orchestrationMatch[1]);
    if (req.method === 'PUT') {
      if (!deps.orchestrations) {
        sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
        return true;
      }
      const row = deps.orchestrations.getById(id);
      if (!row) {
        sendJson(res, 404, { error: 'Orchestration not found' });
        return true;
      }
      let body: z.infer<typeof OrchestrationPatchBody>;
      try {
        body = OrchestrationPatchBody.parse(await readJson(req));
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
        return true;
      }
      // 在飞的运行吃的是触发那一刻的快照：改图不影响它，下一次触发才生效。
      const resolved = resolveOrchestration(deps, {
        name: body.name ?? row.name,
        startText: body.startText ?? row.startText,
        projectId: body.projectId ?? (row.nodes.some((n) => n.kind === 'session') ? undefined : row.projectId),
        nodes: body.nodes ?? row.nodes,
        edges: body.edges ?? row.edges,
        cron: body.cron === undefined ? row.cron : body.cron,
      });
      if (!resolved.ok) {
        sendJson(res, 400, { error: resolved.error });
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        orchestration: withNextRun(
          deps.orchestrations.update(id, { ...resolved.value, enabled: body.enabled })!,
        ),
      });
      return true;
    }
    if (req.method === 'DELETE') {
      if (!deps.orchestrations) {
        sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
        return true;
      }
      if (!deps.orchestrations.getById(id)) {
        sendJson(res, 404, { error: 'Orchestration not found' });
        return true;
      }
      cancelRunsOf(deps, id);
      deps.orchestrations.deleteById(id);
      sendJson(res, 200, { ok: true, orchestrationId: id });
      return true;
    }
  }

  const triggerMatch = pathname.match(/^\/messaging\/orchestrations\/(\d+)\/trigger$/);
  if (triggerMatch && req.method === 'POST') {
    if (!deps.orchestrationEngine || !deps.orchestrations) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    let body: z.infer<typeof TriggerBody> = {};
    try {
      const raw = (await readBody(req)).trim();
      if (raw) body = TriggerBody.parse(JSON.parse(raw));
    } catch {
      sendJson(res, 400, { error: 'Invalid body' });
      return true;
    }
    const result = await deps.orchestrationEngine.start(
      Number(triggerMatch[1]),
      'manual',
      body.text,
      body.entries,
    );
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    sendJson(res, 201, { ok: true, runId: result.runId });
    return true;
  }

  const rotateMatch = pathname.match(/^\/messaging\/orchestrations\/(\d+)\/rotate-webhook$/);
  if (rotateMatch && req.method === 'POST') {
    if (!deps.orchestrations) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    let body: z.infer<typeof RotateNodeBody>;
    try {
      body = RotateNodeBody.parse(await readJson(req));
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
      return true;
    }
    const token = deps.orchestrations.rotateNodeToken(Number(rotateMatch[1]), body.nodeId);
    if (!token) {
      sendJson(res, 404, { error: 'Webhook entry node not found' });
      return true;
    }
    sendJson(res, 200, { ok: true, webhookToken: token });
    return true;
  }

  if (pathname === '/messaging/orchestration-runs') {
    if (!deps.orchestrationRuns) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    if (req.method === 'GET') {
      const status = url.searchParams.get('status') || undefined;
      if (status && !RUN_STATUSES.has(status as OrchestrationRunStatus)) {
        sendJson(res, 400, { error: `Unknown run status: ${status}` });
        return true;
      }
      const page = deps.orchestrationRuns.query({
        orchestrationId: intParam(url, 'orchestrationId'),
        projectId: intParam(url, 'projectId'),
        status,
        text: url.searchParams.get('text') || undefined,
        before: intParam(url, 'before'),
        limit: intParam(url, 'limit'),
      });
      sendJson(res, 200, { runs: page.runs.map(toRunSummary), nextBefore: page.nextBefore });
      return true;
    }
    if (req.method === 'DELETE') {
      const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'finished';
      const projectId = intParam(url, 'projectId');
      if (scope === 'all') {
        // 全清 = 先停手再删：运行态活着却没有行可写，只会静默失败。
        for (const run of deps.orchestrationRuns.listRunning()) {
          if (projectId != null && run.projectId !== projectId) continue;
          deps.orchestrationEngine?.cancel(run.id);
        }
      }
      sendJson(res, 200, {
        ok: true,
        deleted: deps.orchestrationRuns.clear(scope, projectId),
      });
      return true;
    }
  }

  const runDetailMatch = pathname.match(/^\/messaging\/orchestration-runs\/(\d+)$/);
  if (runDetailMatch && req.method === 'GET') {
    if (!deps.orchestrationRuns) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const run = deps.orchestrationRuns.getById(Number(runDetailMatch[1]));
    if (!run) {
      sendJson(res, 404, { error: 'Run not found' });
      return true;
    }
    // 详情 = summary + state：列表行带 pendingCounts 无 state，原始行反之——
    // web 的 OrchestrationRunRow 两者都要（展开行直接顶替列表行渲染）。
    sendJson(res, 200, { run: { ...toRunSummary(run), state: run.state } });
    return true;
  }

  const cancelRunMatch = pathname.match(/^\/messaging\/orchestration-runs\/(\d+)\/cancel$/);
  if (cancelRunMatch && req.method === 'POST') {
    if (!deps.orchestrationRuns) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const run = deps.orchestrationRuns.getById(Number(cancelRunMatch[1]));
    if (!run) {
      sendJson(res, 404, { error: 'Run not found' });
      return true;
    }
    if (run.status !== 'running') {
      sendJson(res, 409, { error: `Run already ${run.status}` });
      return true;
    }
    if (!deps.orchestrationEngine?.cancel(run.id)) {
      deps.orchestrationRuns.finish(run.id, 'cancelled');
    }
    sendJson(res, 200, { ok: true, runId: run.id });
    return true;
  }

  // ---- 公开 webhook 触发：token 即凭证（认证门在 server.ts 的 isPublicRequest 放行）----
  const webhookMatch = pathname.match(/^\/webhooks\/orchestrate\/([A-Za-z0-9_-]+)$/);
  if (webhookMatch && req.method === 'POST') {
    if (!deps.orchestrations || !deps.orchestrationEngine) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const hit = deps.orchestrations.getByNodeToken(webhookMatch[1]!);
    if (!hit) {
      sendJson(res, 404, { error: 'Unknown webhook token' });
      return true;
    }
    // 载荷随该入口的出边正文下发（空则只发边正文）。
    const payload = (await readBody(req)).trim().slice(0, 20_000);
    const result = await deps.orchestrationEngine.start(hit.row.id, 'webhook', payload || undefined, [
      hit.nodeId,
    ]);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    sendJson(res, 202, { ok: true, runId: result.runId });
    return true;
  }

  // ---- 能力矩阵：纯派生自 MessagingSurface + 终端通道装配态（无第二事实源） ----
  if (pathname === '/messaging/capabilities' && req.method === 'GET') {
    // prompt 列 = 层① 原生中继 || 层② 终端 send-text 兜底（随 settings/机器变）。
    const terminalChannel = deps.messageDeliverer?.hasTerminalChannel() ?? false;
    sendJson(res, 200, {
      capabilities: messagingSurfaces().map(({ harness, surface }) => ({
        harness,
        discovery: surface.discovery,
        prompt: promptChannelOf(surface, terminalChannel),
        inject: surface.inject !== null,
        headless: surface.headless !== null,
        watch: surface.idleSignals.length > 0,
        /** 附件随 prompt 的对齐面收哪些类型（空 = 该 harness 不收附件，附件钮置灰）。 */
        attachKinds: surface.attach?.kinds ?? [],
        /** 项目内路径的引用文法（false = 该 harness 没有这种文法，文件钮置灰）。 */
        pathRefs: surface.pathRefs !== null,
        /** 该文法认不认行区间（false = 选择器只给整文件引用，不摆行号选择）。 */
        pathRefLines: surface.pathRefs?.lines === true,
        /** 该文法能引用什么（`dir` 缺席 = 只给文件引用，目录行不摆「引用此文件夹」）。 */
        pathRefKinds: surface.pathRefs?.kinds ?? [],
        /** 旁路会话（侧问）通道；false = 该 harness 没有这种机制（入口不渲染）。 */
        sideQuestion: surface.sideQuestion !== null,
        unsupportedReasons: surface.unsupportedReasons ?? null,
      })),
    });
    return true;
  }

  // ---- 投递诊断：daemon + 项目采集脚本健康 + 会话通道矩阵（被动只读现算） ----
  // 判据集 = 各通道「何时不可用」的全部条件（见 MessageDeliverer.diagnose / CaptureSurface.
  // scriptHealth），不探端口、不起子进程、不落库、不回传凭据值。?session= / ?project= 收窄。
  if (pathname === '/messaging/diagnostics' && req.method === 'GET') {
    if (!deps.messageDeliverer || !deps.hookSessions) {
      sendJson(res, 503, { error: 'Message subsystem unavailable' });
      return true;
    }
    const sessionFilter = url.searchParams.get('session');
    const projectFilter = url.searchParams.get('project');
    const captures = captureSurfaces();
    const projects = deps.projects.list();

    const projectRows = await Promise.all(
      projects.map(async (p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
        captures: await Promise.all(
          captures.map(async ({ harness, surface }) => ({
            harness,
            ...(await surface.scriptHealth({ projectPath: p.path })),
          })),
        ),
      })),
    );
    const captureOf = (projectId: number | null, harness: string | null) =>
      projectRows
        .find((p) => p.id === projectId)
        ?.captures.find((c) => c.harness === harness) ?? null;

    const liveness = claudeLivenessById();
    const rows = deps.hookSessions.listWithCounts(
      sessionFilter ? undefined : projectFilter ? Number(projectFilter) : undefined,
    );
    const sessions = rows
      .filter((s) => (sessionFilter ? s.sessionId === sessionFilter : pidAliveOf(s, liveness) !== false))
      .map((s) => {
        const diag = deps.messageDeliverer!.diagnose(s.sessionId);
        const capture = captureOf(s.projectId, s.harness ?? null);
        const channels = { inbox: diag.inbox, queue: diag.queue, relay: diag.relay, terminal: diag.terminal };
        return {
          sessionId: s.sessionId,
          projectId: s.projectId,
          harness: s.harness ?? null,
          title: s.title,
          lastSeenAt: s.lastSeenAt,
          eventCount: s.eventCount ?? 0,
          lastEventType: s.lastEventType ?? null,
          alive: diag.alive,
          paneEnvReported: diag.paneEnvReported,
          channels,
          queue: { pending: diag.pending, stalled: diag.stalled },
          reachable: Object.values(channels).some((c) => c.status === 'ready'),
          hints: deliveryHints({ diag, capture, eventCount: s.eventCount ?? 0 }),
        };
      });

    sendJson(res, 200, {
      daemon: {
        version: WEAVE_VERSION,
        platform: process.platform,
        dataDir: getDataDir(),
        uptimeMs: Math.round(process.uptime() * 1000),
        terminalPreset: readDaemonSettingsSync().terminal.preset,
        terminalTextChannel: deps.messageDeliverer.hasTerminalChannel(),
        hooksEnabled: readHooksEnabled(),
      },
      projects: projectRows,
      sessions,
    });
    return true;
  }

  return false;
}
