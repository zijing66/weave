import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isHarness, type Harness } from '@weavecode/core';
import type { WeaveServerDeps } from '../server.js';
import { messagingSurfaceFor } from '../../surfaces.js';
import { readBody, sendJson } from '../http.js';
import { handleProjectInit } from './project-init.js';
import { readDaemonSettings } from '../settings.js';
import {
  closeTerminalsIn,
  defaultProjectOpener,
  readTerminalCounts,
  readTerminalHidden,
  terminalBackendFor,
} from '../opener.js';
import { purgeProjectPipeline } from '../hook-pipeline.js';
import { hooksRoot } from '../../hooks/mirror.js';
import { projectHarnesses, withProjectHarnesses } from '../project-harnesses.js';
import { scheduleBootstrapInjection } from '../session-open.js';
import { getUploadsDir } from '../../db/paths.js';
import { PENDING_WT_PREFIX, createSessionWorktree, upsertWorktreeEntry } from '../worktree.js';

/** 项目配置（projects.meta.storage）：存储目录 + 终端窗口行为。 */
export interface ProjectStorage {
  images?: string | null;
  files?: string | null;
  /** 打开/唤出终端窗口后是否顺手系统级隐藏（SW_HIDE）。缺省 false = 不隐藏。 */
  hideWindow?: boolean;
}

/**
 * 项目域路由：目录/终端打开、关终端、唤出终端、新会话、归档/恢复、排序、
 * pane/终端枚举、终端角标。返回 true = 本路由认领；false = 未命中，主链继续。
 */
export async function handleProjectRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
): Promise<boolean> {
  // --- open a project directory in the file manager or a terminal ---
  const openMatch = pathname.match(/^\/projects\/(\d+)\/open$/);
  if (openMatch && req.method === 'POST') {
    const project = deps.projects.getById(Number(openMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    let body: { target?: string };
    try {
      body = JSON.parse(await readBody(req)) as { target?: string };
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (body.target !== 'explorer' && body.target !== 'terminal') {
      sendJson(res, 400, { error: 'Invalid "target" (explorer|terminal)' });
      return true;
    }
    const opener = deps.opener ?? defaultProjectOpener;
    try {
      const stat = await fs.promises.stat(project.path);
      if (!stat.isDirectory()) throw new Error(`Not a directory: ${project.path}`);
      if (body.target === 'explorer') {
        await opener.openExplorer(project.path);
      } else {
        const settings = await readDaemonSettings();
        await opener.openTerminal(project.path, settings.terminal);
        // 项目配置 hideWindow：开完顺手系统级隐藏（延迟一拍——窗要起来才藏得着）。
        const hideWindow =
          (deps.projects.getMeta(project.id) as { storage?: ProjectStorage } | null)?.storage
            ?.hideWindow === true;
        if (hideWindow) {
          setTimeout(() => {
            void (async () => {
              try {
                const list = opener.listTerminals ?? defaultProjectOpener.listTerminals!;
                const targets = await list(project.path, settings.terminal);
                const setVis =
                  opener.setTerminalVisibility ?? defaultProjectOpener.setTerminalVisibility;
                if (targets[0] && setVis) {
                  await setVis(project.path, targets[0].id, 'hide', settings.terminal);
                }
              } catch {
                // 尽力而为：藏不成就保持可见
              }
            })();
          }, 2500);
        }
        // 角标对账：新窗 pane 的 cwd 上报有一拍延迟，立即探也看不到增量——
        // 600ms 后对一次账（原先由前端 setTimeout 拉 GET，改服务端自对账）。
        setTimeout(() => void deps.terminalRefresher?.refreshNow(), 600);
      }
      sendJson(res, 200, { ok: true, target: body.target, path: project.path });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Open failed' });
    }
    return true;
  }

  // --- close this project's open terminals (project card "关闭终端") ---
  // 只关 body.paneIds 清单里的 pane（用户在多选弹窗里勾的那些）——**不提供一口气
  // 全关**。命中判据仍是 pane 的 cwd **恰为**项目目录（与「终端」角标同一条，不含
  // 子目录）：窗口里别的 cwd 的 pane 不动（不替用户关掉顺手开着的别的活）。
  // 关完角标自己掉——与 /open 同口径，600ms 后对一次账。
  const closeTermMatch = pathname.match(/^\/projects\/(\d+)\/close-terminal$/);
  if (closeTermMatch && req.method === 'POST') {
    const project = deps.projects.getById(Number(closeTermMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    let body: { paneIds?: unknown };
    try {
      body = JSON.parse((await readBody(req)) || '{}') as { paneIds?: unknown };
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (
      !Array.isArray(body.paneIds) ||
      body.paneIds.length === 0 ||
      body.paneIds.some((id) => typeof id !== 'string')
    ) {
      sendJson(res, 400, { error: 'paneIds must be a non-empty array of strings' });
      return true;
    }
    const opener = deps.opener ?? defaultProjectOpener;
    const settings = await readDaemonSettings();
    try {
      const close = opener.closeTerminals ?? closeTerminalsIn;
      const closed = await close(project.path, settings.terminal, body.paneIds as string[]);
      setTimeout(() => void deps.terminalRefresher?.refreshNow(), 600);
      sendJson(res, 200, { ok: true, closed });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Close failed' });
    }
    return true;
  }

  // --- 唤出这个项目的某个已开终端（项目卡终端弹层：点卡片 = 切到前台）---
  // targetId 取自 GET /projects/:id/terminals（不透明，表示法归后端）；项目不存在
  // 404、id 缺失 400，唤不醒（pane/tab 已关、preset 无通道）一律 409 带原文。
  const focusTermMatch = pathname.match(/^\/projects\/(\d+)\/focus-terminal$/);
  if (focusTermMatch && req.method === 'POST') {
    const project = deps.projects.getById(Number(focusTermMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    let body: { targetId?: unknown };
    try {
      body = JSON.parse((await readBody(req)) || '{}') as { targetId?: unknown };
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (typeof body.targetId !== 'string' || !body.targetId) {
      sendJson(res, 400, { error: 'targetId must be a non-empty string' });
      return true;
    }
    const opener = deps.opener ?? defaultProjectOpener;
    const settings = await readDaemonSettings();
    try {
      const focus = opener.focusTerminal ?? defaultProjectOpener.focusTerminal!;
      await focus(project.path, body.targetId, settings.terminal);
      sendJson(res, 200, { ok: true, targetId: body.targetId });
    } catch (e) {
      sendJson(res, 409, { error: e instanceof Error ? e.message : 'Cannot focus terminal' });
    }
    return true;
  }

  // --- 系统级隐藏/恢复该项目的某个已开终端窗口（终端弹层的「隐藏/显示」切换）---
  // SW_HIDE 比最小化深一级：任务栏与 Alt+Tab 都消失，weave 是唯一找回入口，故
  // 切换响应里带**切换后实况可见性**（前端就地摆态）。项目不存在 404、targetId
  // 缺失 400、preset 无通道/窗已不在 409 带原文。GET = 只查实况（拿不到 null）。
  const visMatch = pathname.match(/^\/projects\/(\d+)\/terminal-visibility$/);
  if (visMatch) {
    const project = deps.projects.getById(Number(visMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    let body: { targetId?: unknown; visibility?: unknown } = {};
    if (req.method === 'POST') {
      try {
        body = JSON.parse((await readBody(req)) || '{}') as typeof body;
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return true;
      }
      if (typeof body.targetId !== 'string' || !body.targetId) {
        sendJson(res, 400, { error: 'targetId must be a non-empty string' });
        return true;
      }
      if (body.visibility !== 'hide' && body.visibility !== 'show') {
        sendJson(res, 400, { error: "visibility must be 'hide' or 'show'" });
        return true;
      }
    } else if (req.method !== 'GET') {
      return false;
    }
    const opener = deps.opener ?? defaultProjectOpener;
    const settings = await readDaemonSettings();
    if (req.method === 'POST') {
      const setVis = opener.setTerminalVisibility ?? defaultProjectOpener.setTerminalVisibility;
      if (!setVis) {
        sendJson(res, 409, { error: 'Terminal preset has no window visibility channel' });
        return true;
      }
      try {
        const r = await setVis(project.path, body.targetId as string, body.visibility as 'hide' | 'show', settings.terminal);
        // 窗口世界变了（可见性进角标的 hidden 半边）：踢一拍对账，别让前端等 30s 周期。
        setTimeout(() => void deps.terminalRefresher?.refreshNow(), 600);
        sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        sendJson(res, 409, { error: e instanceof Error ? e.message : 'Cannot change window visibility' });
      }
      return true;
    }
    // GET：targetId 走 query（GET 不带 body）
    const targetId = new URL(req.url ?? '', 'http://x').searchParams.get('targetId');
    if (!targetId) {
      sendJson(res, 400, { error: 'targetId query param is required' });
      return true;
    }
    const getVis = opener.terminalVisibility ?? defaultProjectOpener.terminalVisibility;
    const visibility = getVis ? await getVis(project.path, targetId, settings.terminal) : null;
    sendJson(res, 200, { visibility });
    return true;
  }

  // --- start a new session in this project's terminal ---
  // POST /projects/:id/new-session — 落进本项目的终端：命令 = harness 裸 bin（新会话，
  // 不带 resume 参数——`openArgs` 才是 resume），落点由终端后端的复用逻辑决定
  // （同项目目录的既有 pane 分屏 → 没有就新窗口；wezterm 连实例都没开则后端报因）。
  // **不要求「本项目已打开终端」**：没有就自己开一个，新建会话不靠先手动开终端。
  const newSessionMatch = pathname.match(/^\/projects\/(\d+)\/new-session$/);
  if (newSessionMatch && req.method === 'POST') {
    const project = deps.projects.getById(Number(newSessionMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    let body: { harness?: unknown; worktree?: unknown; target?: unknown };
    try {
      body = JSON.parse((await readBody(req)) || '{}') as { harness?: unknown };
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (body.worktree !== undefined && typeof body.worktree !== 'boolean') {
      sendJson(res, 400, { error: 'Invalid "worktree" (boolean)' });
      return true;
    }
    if (body.target !== undefined && (typeof body.target !== 'string' || !body.target)) {
      sendJson(res, 400, { error: 'Invalid "target" (non-empty string)' });
      return true;
    }
    // 起哪个 harness = 项目 init 选择结果里的；请求体指定则用它。未接入的不许起
    // （不替用户跨配置起会话）；能起 = resume 槽有裸 bin 且宿主版本够
    // （canStartSession，版本闸见 project-harnesses），都不行 → 501。
    const integrated = await projectHarnesses(project.path, deps.harnesses);
    if (body.harness !== undefined && !isHarness(body.harness)) {
      sendJson(res, 400, { error: 'Invalid "harness"' });
      return true;
    }
    const requested = body.harness as Harness | undefined;
    if (requested && !integrated.some((h) => h.id === requested)) {
      sendJson(res, 409, { error: `Harness "${requested}" is not integrated in this project` });
      return true;
    }
    const wanted = requested ? [requested] : integrated.map((h) => h.id);
    const picked = integrated.find((h) => wanted.includes(h.id) && h.canStartSession);
    const spec = picked ? deps.harnesses?.get(picked.id)?.resume : undefined;
    if (!spec?.bin) {
      sendJson(res, 501, {
        error: `Harness "${wanted[0]}" cannot start an interactive session`,
      });
      return true;
    }
    const opener = deps.opener ?? defaultProjectOpener;
    try {
      const stat = await fs.promises.stat(project.path);
      if (!stat.isDirectory()) throw new Error(`Not a directory: ${project.path}`);
      // worktree 隔离（B5 最小切片）：起手建 worktree，会话 cwd 落进它（与会话级
      // 生命周期两端绑死：SessionEnd 后由 sweepWorktreeMerges 并回主干）。环境
      // 不支持（非 git 仓 / git 缺席）→ 409 如实报因，前端据此置灰——不炸、不回落。
      let cwd = project.path;
      let worktreePath: string | undefined;
      if (body.worktree === true) {
        // sessionId 此刻未知（宿主自己生成）：先用占位键建目录与分支，登记按
        // 占位键记；首个会话事件到达时按 cwd 前缀认领改绑（claimPendingSessionWorktree，
        // 与起点候选 pending-origins 同一哲学）。
        const key = PENDING_WT_PREFIX + crypto.randomUUID();
        const created = await createSessionWorktree(
          project.path,
          key,
          deps.worktreeGitExec,
        );
        if (!created.ok) {
          sendJson(res, created.unsupported ? 409 : 400, {
            error: created.error ?? 'worktree unavailable',
          });
          return true;
        }
        cwd = created.path!;
        worktreePath = created.path;
        if (deps.hooksDir) {
          upsertWorktreeEntry(deps.hooksDir, {
            sessionId: key,
            projectId: project.id,
            path: created.path!,
            branch: created.branch!,
            status: 'active',
            at: new Date().toISOString(),
          });
        }
      }
      const settings = await readDaemonSettings();
      const argv = [spec.bin, ...(spec.launchArgs ?? [])];
      // 定点落子（可选 target = list_terminals 的 targetId）：能力归后端——enumerable
      // preset 才有定点通道，其余明确报因；目标没了 / 长满了 throw 转前端报因，
      // 绝不静默换落点（换了就是「点了 A 进了 B」）。
      const origin =
        typeof body.target === 'string'
          ? await opener.runInTerminalAt!(cwd, argv, body.target, settings.terminal)
          : await opener.runInTerminal(cwd, argv, settings.terminal);
      // 起点候选：sessionId 事后才知道（宿主自己生成）——spawn 回执先按
      // (harness, projectId) 排队，ingest 侧（hook 事件 / rollout session_meta）
      // 认领。只为 paneEnvSource='launch' 的 harness 记（'hook' 的 env 精确，
      // 起点只会引入过期源）。
      if (origin && picked && messagingSurfaceFor(picked.id).paneEnvSource === 'launch') {
        deps.messageDeliverer?.notePendingOrigin({
          harness: picked.id,
          projectId: project.id,
          env: origin.env,
        });
      }
      // 引导注入（懒建档宿主的会话行加速）：spec 声明了 bootstrapText 才注入，
      // 文本 = `/rename <项目名>` 这类零模型命令，会话行即刻进列表。
      if (origin && picked && spec?.bootstrapText) {
        scheduleBootstrapInjection(deps, origin, spec.bootstrapText(project.name));
      }
      // 角标对账：新 pane 的 cwd 上报有一拍延迟（与 /open 同口径）。
      setTimeout(() => void deps.terminalRefresher?.refreshNow(), 600);
      sendJson(res, 200, { ok: true, command: argv.join(' '), cwd, ...(worktreePath ? { worktree: worktreePath } : {}) });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Open failed' });
    }
    return true;
  }

  if (pathname === '/projects' && req.method === 'GET') {
    sendJson(res, 200, {
      projects: await withProjectHarnesses(deps.projects.list(), deps.harnesses),
    });
    return true;
  }

  // POST /projects/:id/init — dashboard 触发重跑 `weave init`（子进程跑 CLI，
  // 隔离 CLI 的 process.exit；实现归 project-init.ts 一处）。
  const initMatch = pathname.match(/^\/projects\/(\d+)\/init$/);
  if (initMatch && req.method === 'POST') {
    return handleProjectInit(req, res, Number(initMatch[1]), deps);
  }

  // GET /projects/archived — 归档面数据（仅基础信息；历史会话已在归档时清空）。
  if (pathname === '/projects/archived' && req.method === 'GET') {
    sendJson(res, 200, {
      projects: await withProjectHarnesses(deps.projects.listArchived(), deps.harnesses),
    });
    return true;
  }

  // POST /projects/:id/archive — 归档：清空历史会话（派发→事件→会话行，顺序
  // 保证派发子查询还能圈到行）+ 焚毁管道文件（inbox/mirror/outbox，hook 侧
  // 镜像即刻消失）。项目行只留基础信息（archived_at 标记）；各消费面
  // （watch/mirror/inbox/同步）按「活跃项目」口径自动跳过，无需逐处剔除。
  // watcher 由 watch.reconcile 立即收掉（不等 5s 周期）。
  const archiveMatch = pathname.match(/^\/projects\/(\d+)\/archive$/);
  if (archiveMatch && req.method === 'POST') {
    const project = deps.projects.getById(Number(archiveMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    // 超级代理项目（上帝 = coordinator）不可归档（2026-11-11 用户裁决）：
    // 功能随 weave 版本更新，归档会焚毁会话与消费面。
    if (project.superagent) {
      sendJson(res, 409, { error: 'Superagent project cannot be archived' });
      return true;
    }
    if (project.archivedAt) {
      sendJson(res, 200, {
        project,
        purged: { events: 0, dispatches: 0, sessions: 0, messages: 0 },
      });
      return true; // 幂等：重复归档不动已清空的数据
    }
    const dispatches = deps.hookDispatches?.deleteByProject(project.id) ?? 0;
    const events = deps.hookEvents?.deleteByProject(project.id) ?? 0;
    // 事件清完（event_images 级联删）再回收孤儿上传件
    deps.uploads?.pruneUnreferenced();
    // 消息域先于会话行清（内存态按会话→项目归属圈；队列行按会话清）；订阅/编排同形
    // （编排按项目会话集圈「任一步目标」行，同样必须在会话行删除前执行）
    const messages = deps.messageDeliverer?.forgetProject(project.id) ?? 0;
    deps.sessionWatches?.deleteByProject(project.id);
    deps.orchestrations?.deleteByProject(project.id);
    deps.orchestrationRuns?.clear('all', project.id);
    // 会话扩展点级联：绑定先删（执行行按 binding_id 引用它），再清执行行
    deps.extensionBindings?.deleteByProject(project.id);
    deps.extensionExecutions?.deleteByProject(project.id);
    deps.sideQuestions?.repo.deleteByProject(project.id);
    const sessions = deps.hookSessions?.removeByProject(project.id) ?? 0;
    deps.projects.setArchived(project.id, true);
    purgeProjectPipeline(deps.hooksDir ?? hooksRoot(), project.token);
    deps.watch?.reconcile();
    deps.dataBus?.emit({ key: 'projects' });
    sendJson(res, 200, {
      project: deps.projects.getById(project.id),
      purged: { events, dispatches, sessions, messages },
    });
    return true;
  }

  // POST /projects/:id/restore — 恢复：翻转归档位，重写注入镜像，watcher 由
  // reconcile 立即拉起（会话历史不回来——归档是删除不是暂停）。
  const restoreMatch = pathname.match(/^\/projects\/(\d+)\/restore$/);
  if (restoreMatch && req.method === 'POST') {
    const project = deps.projects.getById(Number(restoreMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    if (!project.archivedAt) {
      sendJson(res, 200, { project });
      return true; // 幂等：活跃项目的恢复是 no-op
    }
    deps.projects.setArchived(project.id, false);
    deps.hookMirror?.syncProject(project.id);
    deps.watch?.reconcile();
    deps.dataBus?.emit({ key: 'projects' });
    sendJson(res, 200, { project: deps.projects.getById(project.id) });
    return true;
  }

  // PUT /projects/order — dashboard 拖动排序持久化：payload = 完整目标顺序
  // （id 全量列表），repo 事务内全清重排，幂等。
  if (pathname === '/projects/order' && req.method === 'PUT') {
    let body: { ids?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as { ids?: unknown };
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (!Array.isArray(body.ids) || !body.ids.every((id) => Number.isInteger(id))) {
      sendJson(res, 400, { error: 'Invalid "ids" (integer array expected)' });
      return true;
    }
    deps.projects.setOrder(body.ids as number[]);
    deps.dataBus?.emit({ key: 'projects' });
    sendJson(res, 200, { projects: deps.projects.list() });
    return true;
  }

  // GET /projects/:id/panes — 项目关终端多选弹窗的数据面：本项目名下可关的 pane
  // （cwd 恰为项目目录；窗口里别的目录的 pane 不进来）。枚举不到却计数说有 = 这个
  // preset 关不了远程 pane（wt 只数不关）→ 如实 409，不给空表装作「没有终端」。
  const panesMatch = pathname.match(/^\/projects\/(\d+)\/panes$/);
  if (panesMatch && req.method === 'GET') {
    const project = deps.projects.getById(Number(panesMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    const settings = await readDaemonSettings();
    const list = deps.opener?.listPanes ?? defaultProjectOpener.listPanes!;
    try {
      sendJson(res, 200, { projectId: project.id, panes: await list(project.path, settings.terminal) });
    } catch (e) {
      sendJson(res, 409, { error: e instanceof Error ? e.message : 'Cannot list panes' });
    }
    return true;
  }

  // GET /projects/:id/terminals — 会话终端「选哪个终端」弹窗的数据面：
  // 按最近活跃排序的可附加目标（窗口内的 tab）。枚举能力归后端——非 enumerable
  // 的 preset 无枚举通道 → 空表。`?all=1`（opt-in）：别的项目的 tab 也进候选
  // （跨项目分屏落点用），本项目的照旧排前。
  const terminalsMatch = pathname.match(/^\/projects\/(\d+)\/terminals$/);
  if (terminalsMatch && req.method === 'GET') {
    const project = deps.projects.getById(Number(terminalsMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    const settings = await readDaemonSettings();
    const list = deps.opener?.listTerminals ?? defaultProjectOpener.listTerminals!;
    const includeForeign = new URL(req.url ?? '', 'http://x').searchParams.get('all') === '1';
    const terminals = terminalBackendFor(settings.terminal).enumerable
      ? await list(project.path, settings.terminal, includeForeign)
      : [];
    sendJson(res, 200, { projectId: project.id, terminals });
    return true;
  }

  // GET /terminals/counts — 项目卡「终端」角标：每项目已打开的终端数，单位 =
  // 该后端的可见屏幕（wezterm = tab，与「选哪个终端」弹窗的选项同一口径），
  // 不是分屏 pane、也不是会话数；枚举能力见 countOpenTerminals。
  // 陈旧值先给、后台对账：探测 = 每存活 socket spawn 一次 `wezterm cli`（实测
  // ~200ms），不该让响应等它；增量经 push 帧到达，正常消费方（SSE 客户端）
  // 不需要再打这枪。未接刷新器（测试注入缝）才现探。
  if (pathname === '/terminals/counts' && req.method === 'GET') {
    if (deps.terminalRefresher) {
      sendJson(res, 200, {
        counts: deps.terminalRefresher.lastSnapshot?.counts ?? {},
        hidden: deps.terminalRefresher.lastSnapshot?.hidden ?? {},
      });
      void deps.terminalRefresher.tick(true);
    } else {
      const opener = deps.opener ?? defaultProjectOpener;
      sendJson(res, 200, {
        counts: await readTerminalCounts(deps.projects.list(), opener),
        hidden: await readTerminalHidden(deps.projects.list(), opener),
      });
    }
    return true;
  }

  // GET /terminals/visibility — 全部已开终端窗的实况可见性计数（桌宠菜单胶囊）：
  // 合并面枚举目标后逐个查实况；探不到的目标不进计数。
  if (pathname === '/terminals/visibility' && req.method === 'GET') {
    const opener = deps.opener ?? defaultProjectOpener;
    const settings = await readDaemonSettings();
    const list = opener.listTerminals ?? defaultProjectOpener.listTerminals!;
    const getVis = opener.terminalVisibility ?? defaultProjectOpener.terminalVisibility!;
    let visible = 0;
    let hidden = 0;
    const seen = new Set<string>();
    for (const project of deps.projects.list()) {
      try {
        for (const t of await list(project.path, settings.terminal)) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          const v = await getVis(project.path, t.id, settings.terminal);
          if (v === 'visible') visible += 1;
          else if (v === 'hidden') hidden += 1;
        }
      } catch {
        // 单项目枚举失败隔离：计数照常回
      }
    }
    sendJson(res, 200, { visible, hidden });
    return true;
  }

  // POST /terminals/visibility — 批量显隐全部已开终端窗（桌宠右键菜单）：逐项目
  // 枚举可附加目标（合并面 = 全部有显隐通道的后端各列各的）后逐个 setVis；单项目
  // 枚举/切换失败隔离计入 failed，不拖垮其余。无显隐通道的后端逐项目静默跳过。
  if (pathname === '/terminals/visibility' && req.method === 'POST') {
    let body: { visibility?: unknown };
    try {
      body = JSON.parse((await readBody(req)) || '{}') as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (body.visibility !== 'hide' && body.visibility !== 'show') {
      sendJson(res, 400, { error: "visibility must be 'hide' or 'show'" });
      return true;
    }
    const opener = deps.opener ?? defaultProjectOpener;
    const settings = await readDaemonSettings();
    const list = opener.listTerminals ?? defaultProjectOpener.listTerminals!;
    const setVis = opener.setTerminalVisibility ?? defaultProjectOpener.setTerminalVisibility;
    if (!setVis) {
      sendJson(res, 409, { error: 'Terminal preset has no window visibility channel' });
      return true;
    }
    let changed = 0;
    const failed: string[] = [];
    const seen = new Set<string>();
    for (const project of deps.projects.list()) {
      try {
        const targets = await list(project.path, settings.terminal);
        for (const t of targets) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          await setVis(project.path, t.id, body.visibility as 'hide' | 'show', settings.terminal);
          changed += 1;
        }
      } catch {
        failed.push(project.path);
      }
    }
    setTimeout(() => void deps.terminalRefresher?.refreshNow(), 600);
    sendJson(res, 200, { ok: true, changed, failed });
    return true;
  }

  // --- 项目配置（存储路径 + 终端窗口行为）---
  // GET：回配置 + 生效目录（自定义 ?? 全局默认）。PUT：校验绝对路径 + mkdirSync
  // 试写（写不进的目录当场拒，不留一个存了也落不了盘的配置）；空串 = 清回全局默认。
  // 存量文件留原处（uploads 行记 dir），新上传走新路径，零迁移。hideWindow =
  // 打开/唤出终端窗口后顺手系统级隐藏（缺省 false）。
  const storageMatch = pathname.match(/^\/projects\/(\d+)\/storage$/);
  if (storageMatch) {
    const project = deps.projects.getById(Number(storageMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    const meta = deps.projects.getMeta(project.id) as { storage?: ProjectStorage } | null;
    const storage: ProjectStorage = meta?.storage ?? {};
    const fallback = deps.uploads?.defaultDir ?? getUploadsDir();
    if (req.method === 'GET') {
      sendJson(res, 200, {
        storage,
        effective: {
          images: storage.images || fallback,
          files: storage.files || fallback,
        },
      });
      return true;
    }
    if (req.method === 'PUT') {
      let body: { images?: unknown; files?: unknown; hideWindow?: unknown };
      try {
        body = JSON.parse(await readBody(req)) as { images?: unknown; files?: unknown; hideWindow?: unknown };
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return true;
      }
      if (body.hideWindow !== undefined && typeof body.hideWindow !== 'boolean') {
        sendJson(res, 400, { error: '"hideWindow" must be a boolean' });
        return true;
      }
      const next: ProjectStorage = {
        ...(body.hideWindow !== undefined ? { hideWindow: body.hideWindow } : {}),
      };
      for (const key of ['images', 'files'] as const) {
        const raw = body[key];
        if (raw === undefined || raw === null || raw === '') {
          next[key] = null;
          continue;
        }
        if (typeof raw !== 'string') {
          sendJson(res, 400, { error: `"${key}" must be a string or null` });
          return true;
        }
        const dir = raw.trim();
        if (!path.isAbsolute(dir)) {
          sendJson(res, 400, { error: `"${key}" must be an absolute path` });
          return true;
        }
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.accessSync(dir, fs.constants.W_OK);
        } catch (e) {
          sendJson(res, 400, {
            error: `"${key}" is not writable: ${e instanceof Error ? e.message : String(e)}`,
          });
          return true;
        }
        next[key] = dir;
      }
      deps.projects.setMeta(project.id, { storage: next });
      deps.dataBus?.emit({ key: 'projects' });
      sendJson(res, 200, {
        storage: next,
        effective: {
          images: next.images || fallback,
          files: next.files || fallback,
        },
      });
      return true;
    }
    return false;
  }

  return false;
}
