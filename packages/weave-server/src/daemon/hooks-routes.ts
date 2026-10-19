import type { IncomingMessage, ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
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
  type MessagingSurface,
  type ModelAliasTarget,
} from '@weavecode/harness';
import type { WeaveServerDeps } from './server.js';
import type { MessageImage, SessionDeliveryDiagnosis } from '../hooks/message-deliverer.js';
import { readJson, sendJson } from './http.js';
import { installPlugin, uninstallPlugin } from '../hooks/plugin-installer.js';
import { purgeSession } from '../hooks/session-purge.js';
import { composeAnswerAtoms } from '../hooks/answer-keys.js';
import { effective, setProjectEnabled } from '../hooks/plugin-project-state.js';
import { readDaemonSettings, readDaemonSettingsSync, readHooksEnabled } from './settings.js';
import { defaultProjectOpener, terminalBackendFor } from './opener.js';
import { claudeLivenessById, pidAliveOf } from './claude-liveness.js';
import { captureSurfaces, messagingSurfaceFor, messagingSurfaces } from '../surfaces.js';
import { getDataDir } from '../db/paths.js';
import { UPLOAD_MAX_BYTES, UPLOAD_MEDIA_TYPES, type UploadRow } from '../repositories/uploads.js';
import { WEAVE_VERSION } from '../version.js';
import { DEFAULT_WATCH_ON } from '../repositories/session-watches.js';
import { SEQUENCE_HOP_LIMIT } from '../hooks/sequence-engine.js';

/**
 * D3 hooks 系统的全部 HTTP 路由（规则 CRUD/toggle、派发查询、会话列表/改名）。
 * 从 server.ts 主路由链中调用；返回 false 表示未命中，主链继续分发。
 */

/**
 * 转录状态的判定（列表与打开门禁共用）：探测只答「那文件里有没有内容」，而没内容
 * 有两种成因：①刚建的会话宿主先建空文件（或缺席），首条消息写进去才有内容；②曾经
 * 写过又被清理/删掉。只有 ② 接不回来。判据 = 这个会话确实跑过（有 prompt 或收尾
 * 事件）——没跑过的会话没有可失去的转录，判不动（null），免得刚建出来就挂「转录已
 * 丢失」。false 因此只有一种含义：真丢了。
 */
function transcriptState(present: boolean | null, hasRun: boolean | undefined): boolean | null {
  if (present !== false) return present;
  return hasRun === true ? false : null;
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

const RunDispatchBody = z.object({ sessionId: z.string().min(1) });

/** 点对点消息投递（消息域重塑）：无模式入参——恒走 prompt 通道三层递送
 * （默认 = 原生 SendMessage 中继 + 未开会话积压队列；降级 = 终端 send-text，
 * 全自动）。inject/headless/auto 只活在编排域（序列步显式选项）。 */
const SendMessageBody = z.object({
  text: z.string().max(20_000),
  fromKind: z.enum(['dashboard', 'session']).optional(),
  fromSessionId: z.string().min(1).nullable().optional(),
  /** 随附图（上传件 id）；带图且目标 harness 的 `imageAttach` 为 null 即 409。 */
  images: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(8).optional(),
  /** 强制层② 终端 send-text（发送人下拉选的通道；缺省 = 直投优先的自动层序）。 */
  forceTerminal: z.boolean().optional(),
});

/** 图片上传（base64 JSON；内容寻址落 `<dataDir>/uploads/<sha256>.<ext>`）。 */
const UploadBody = z.object({
  name: z.string().min(1).max(200),
  mediaType: z.enum(UPLOAD_MEDIA_TYPES),
  /** base64（无 data: 前缀）；字节数以解码后计。 */
  data: z.string().min(1),
});

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

/** Web Push 订阅注册：endpoint = 浏览器推送服务分配的绝对 URL；keys = 载荷加密密钥对。 */
const SubscribePushBody = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

const UnsubscribePushBody = z.object({ endpoint: z.string().url() });

/** 跨会话序列（批 3）：步数上限单独校验（错误文案要带 hop limit 语义）。 */
const CreateSequenceBody = z.object({
  name: z.string().max(200).optional(),
  steps: z
    .array(
      z.object({
        to: z.string().min(1),
        text: z.string().min(1).max(20_000),
        mode: z.enum(['prompt', 'inject', 'headless', 'auto']).optional(),
      }),
    )
    .min(1),
});

const InstallBody = z.object({ src: z.string().min(1) });

/** prompt 通道可用性（与投递裁决同口径）：层① 原生中继 || 层② 终端 send-text 兜底。 */
function promptChannelOf(surface: MessagingSurface, terminalChannel: boolean): boolean {
  return surface.prompt !== null || terminalChannel;
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
  else if (!capture.reportsInbox) hints.push('hook-script-stale');
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
    pathname === '/sessions' ||
    pathname.startsWith('/sessions/') ||
    pathname.startsWith('/messaging') ||
    pathname === '/uploads' ||
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
        return {
          ...s,
          pidAlive: pidAliveOf(s, liveness),
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
          // 执行模式（转录最后一条 permissionMode）：Shift+Tab 不留痕，故是「最后已知」。
          mode: deps.sessionProbe?.currentMode(s.sessionId) ?? null,
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
        questions: deps.questionTracker,
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
    if (!deps.hookSessions) {
      sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    const session = deps.hookSessions.getBySessionId(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found' });
      return true;
    }
    if (!deps.hookEvents) {
      sendJson(res, 503, { error: 'Hook ingestion unavailable' });
      return true;
    }
    // harness 归属 = 最新事件 source（与 sessions 列表的计算字段同口径）
    const latest = deps.hookEvents.listBySession(sessionId, 1);
    const src = latest[latest.length - 1]?.source;
    if (!isHarness(src)) {
      sendJson(res, 400, { error: 'Session has no hook events to determine its harness' });
      return true;
    }
    // 交互式 resume 形态来自 harness 能力槽（server 不写 harness 命令硬编码）
    const spec = deps.harnesses?.get(src)?.resume;
    if (!spec?.supported || !spec.openArgs) {
      sendJson(res, 501, { error: `Harness "${src}" does not support interactive resume` });
      return true;
    }
    if (!session.projectId) {
      sendJson(res, 400, { error: 'Session is not bound to a project' });
      return true;
    }
    const project = deps.projects.getById(session.projectId);
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    // 转录没了就别 spawn：--resume 认的是那份文件，开出去只会在 pane 里报
    // 「No conversation found」。判不动（null）照旧放行，不猜。
    const transcriptPresent = deps.sessionProbe?.transcriptPresent(sessionId) ?? null;
    if (transcriptState(transcriptPresent, deps.hookSessions.hasRunOf(sessionId)) === false) {
      sendJson(res, 409, { error: 'Session transcript is missing — nothing to resume' });
      return true;
    }
    const opener = deps.opener ?? defaultProjectOpener;
    // 多终端弹窗选定的目标（可选）：定点附加到那个 tab；缺省 = 自动选落点。
    let target: string | undefined;
    if (req.method === 'POST') {
      try {
        const raw = (await readJson(req)) as { target?: unknown };
        if (typeof raw?.target === 'string' && raw.target) target = raw.target;
      } catch {
        // 空 body 合法（老前端不带 body）——不是 JSON 就当没给 target
      }
    }
    try {
      const info = await stat(project.path);
      if (!info.isDirectory()) throw new Error(`Not a directory: ${project.path}`);
      const settings = await readDaemonSettings();
      const argv = [spec.bin, ...spec.openArgs(sessionId)];
      if (target) {
        // 定点附加的能力归后端：能反查目标的 preset 才有定点通道（wezterm mux /
        // Terminal.app osascript / wt 进程表），其余明确拒绝而非静默忽略——调用方不列白名单。
        if (!terminalBackendFor(settings.terminal).enumerable) {
          throw new Error(
            `Terminal preset "${settings.terminal.preset}" cannot attach to a chosen pane — pick wezterm, wt or Terminal.app in settings`,
          );
        }
        const runAt = opener.runInTerminalAt;
        if (!runAt) throw new Error('Targeted attach is unavailable');
        await runAt(project.path, argv, target, settings.terminal);
      } else {
        await opener.runInTerminal(project.path, argv, settings.terminal);
      }
      // 角标对账：新 pane 的 cwd 上报有一拍延迟（立即探看不到增量），600ms 后补一枪。
      setTimeout(() => void deps.terminalRefresher?.refreshNow(), 600);
      sendJson(res, 200, {
        ok: true,
        sessionId,
        command: argv.join(' '),
        cwd: project.path,
        ...(target ? { target } : {}),
      });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Open failed' });
    }
    return true;
  }

  // ---- 会话图片上传 / 回显（内容寻址 `<dataDir>/uploads/`；上传 ≠ 投递） ----
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
      sendJson(res, 400, { error: 'Empty image' });
      return true;
    }
    if (bytes.length > UPLOAD_MAX_BYTES) {
      sendJson(res, 413, { error: 'Image too large' });
      return true;
    }
    const row = deps.uploads.save({ name: body.name, mediaType: body.mediaType, bytes });
    sendJson(res, 201, { upload: toUploadDto(row) });
    return true;
  }

  const imageMatch = pathname.match(/^\/images\/([a-f0-9]{64})$/);
  if (imageMatch && req.method === 'GET') {
    if (!deps.uploads) {
      sendJson(res, 503, { error: 'Upload subsystem unavailable' });
      return true;
    }
    const file = deps.uploads.fileOf(imageMatch[1]!);
    if (!file) {
      sendJson(res, 404, { error: 'Image not found' });
      return true;
    }
    // 内容寻址（id = sha256）→ 永不改写，可长缓存
    res.writeHead(200, {
      'content-type': file.row.mediaType,
      'content-length': String(file.bytes.length),
      'cache-control': 'private, max-age=31536000, immutable',
    });
    res.end(file.bytes);
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
      const imageIds = body.images ?? [];
      if (!body.text.trim() && imageIds.length === 0) {
        sendJson(res, 400, { error: 'Message is empty' });
        return true;
      }
      let images: MessageImage[] = [];
      if (imageIds.length > 0) {
        const refs = deps.uploads?.refsOf(imageIds) ?? null;
        if (!refs) {
          sendJson(res, 404, { error: 'Image not found' });
          return true;
        }
        images = refs;
      }
      const result = await deps.messageDeliverer.send({
        toSessionId: sessionId,
        text: body.text,
        ...(images.length > 0 ? { images } : {}),
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
    const result = await deps.messageDeliverer.interrupt(sessionId);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    // 打断之后 claude 要过一下才把中断标记写进转录：补一拍探针，让「生成中」尽快
    // 变成「已中断」（不补则要等下一个周期）。同 terminalTopology 的即时刷新口径。
    setTimeout(() => deps.interruptRefresher?.tick(), 1_500);
    sendJson(res, 200, { ok: true, sessionId });
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

  // ---- 序列域（session-orchestration 批 3）：手工编排多步链 A→B→C ----
  if (pathname === '/messaging/sequences') {
    if (req.method === 'GET') {
      if (!deps.sessionSequences) {
        sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
        return true;
      }
      sendJson(res, 200, { sequences: deps.sessionSequences.list() });
      return true;
    }
    if (req.method === 'POST') {
      if (!deps.sessionSequences || !deps.sequenceEngine || !deps.hookSessions || !deps.hookEvents) {
        sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
        return true;
      }
      let body: z.infer<typeof CreateSequenceBody>;
      try {
        body = CreateSequenceBody.parse(await readJson(req));
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
        return true;
      }
      if (body.steps.length > SEQUENCE_HOP_LIMIT) {
        sendJson(res, 400, {
          error: `Sequences are capped at ${SEQUENCE_HOP_LIMIT} steps (hop limit)`,
        });
        return true;
      }
      // 全部目标前置校验（每步 404/400/409 指明步号）：中途失败 = 步 1 已发出去、
      // 链断在半路，比创建前拒绝差得多——宁可先验完再触发步 0。
      // 按步的 mode 检验对应通道（prompt = 原生中继 || 终端兜底，与能力矩阵同源）。
      const terminalChannel = deps.messageDeliverer?.hasTerminalChannel() ?? false;
      for (let i = 0; i < body.steps.length; i++) {
        const step = body.steps[i]!;
        const target = deps.hookSessions.getBySessionId(step.to);
        if (!target) {
          sendJson(res, 404, { error: `Step ${i + 1}: session not found` });
          return true;
        }
        const latest = deps.hookEvents.listBySession(step.to, 1);
        const src = latest[latest.length - 1]?.source;
        if (!isHarness(src)) {
          sendJson(res, 400, { error: `Step ${i + 1}: session has no hook events to determine its harness` });
          return true;
        }
        const surface = messagingSurfaceFor(src);
        const mode = step.mode ?? 'auto';
        const supported =
          mode === 'prompt'
            ? promptChannelOf(surface, terminalChannel)
            : mode === 'inject'
              ? surface.inject !== null
              : mode === 'headless'
                ? surface.headless !== null
                : surface.inject !== null || surface.headless !== null;
        if (!supported) {
          const why =
            mode === 'auto'
              ? surface.unsupportedReasons?.inject ?? `Harness "${src}" supports no messaging channel`
              : surface.unsupportedReasons?.[mode] ?? `Harness "${src}" does not support the ${mode} channel`;
          sendJson(res, 409, { error: `Step ${i + 1}: ${why}` });
          return true;
        }
      }
      const sequence = deps.sessionSequences.insert({
        name: body.name ?? '',
        steps: body.steps.map((step) => ({ ...step, mode: step.mode ?? 'auto' })),
      });
      await deps.sequenceEngine.trigger(sequence);
      // trigger 后重读：响应即带步 0 的 messageId（web 画布直接渲染首步边）
      sendJson(res, 201, { ok: true, sequence: deps.sessionSequences.getById(sequence.id) ?? sequence });
      return true;
    }
  }

  const sequenceMatch = pathname.match(/^\/messaging\/sequences\/(\d+)$/);
  if (sequenceMatch && req.method === 'DELETE') {
    if (!deps.sessionSequences) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const row = deps.sessionSequences.getById(Number(sequenceMatch[1]));
    if (!row) {
      sendJson(res, 404, { error: 'Sequence not found' });
      return true;
    }
    if (row.status !== 'running') {
      sendJson(res, 409, { error: `Sequence already ${row.status}` });
      return true;
    }
    if (deps.sequenceEngine) deps.sequenceEngine.cancel(row.id);
    else deps.sessionSequences.finish(row.id, 'cancelled');
    sendJson(res, 200, { ok: true, sequenceId: row.id });
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
        /** 图片随 prompt 的对齐面（null = 该 harness 不收图，附件钮置灰）。 */
        imageAttach: surface.imageAttach !== null,
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
        const channels = { inbox: diag.inbox, relay: diag.relay, terminal: diag.terminal };
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
