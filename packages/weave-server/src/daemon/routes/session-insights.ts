import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isHarness, type Harness } from '@weavecode/core';
import type { FileEdit } from '@weavecode/harness';
import type { WeaveServerDeps } from '../server.js';
import { sendJson } from '../http.js';
import { blockingPromptFor, commandsSurfaceFor, editSurfaceFor } from '../../surfaces.js';
import type { HookEventRow } from '../../repositories/hook-events.js';
import type { ProjectRow } from '../../repositories/projects.js';

/**
 * 会话洞察域路由（只读）：计划模式正文、提问前说明、命令候选、命令返显、改动汇总。
 * 数据源 = 各 harness 能力面（blockingPrompt / CommandsSurface / EditsSurface）+
 * hook 事件，server 只做按轮过滤与限额。
 */

/** 会话 → 项目：判定不过就写好响应并返回 null。 */
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
function readPlanFile(filePath: string | null): string | null {
  if (!filePath) return null;
  try {
    const text = readFileSync(filePath, 'utf8');
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

/**
 * 会话洞察域路由。返回 true = 本路由认领；false = 未命中，主链继续。
 */
export async function handleSessionInsightRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
  url: URL,
): Promise<boolean> {
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

  // ---- 提问前说明：阻塞提问（AskUserQuestion/计划确认）前模型写下的那段话 ----
  // 阻塞提问不发 Stop ⇒ hook 事件里没有它，转录是唯一来源（提取归 harness 面）。
  const preQMatch = pathname.match(/^\/sessions\/([^/]+)\/pre-question$/);
  if (preQMatch && req.method === 'GET') {
    const sessionId = decodeURIComponent(preQMatch[1]!);
    if (!projectOfSession(res, deps, sessionId)) return true;
    const src = latestHarnessOf(deps, sessionId);
    const spec = src ? blockingPromptFor(src) : null;
    const pre = await spec?.preQuestion?.(deps.sessionProbe?.transcriptPathOf(sessionId) ?? null);
    sendJson(res, 200, { preQuestion: pre ?? null });
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

  return false;
}
