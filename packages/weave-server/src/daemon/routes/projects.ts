import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isHarness, type Harness } from '@weavecode/core';
import type { WeaveServerDeps } from '../server.js';
import { readBody, sendJson } from '../http.js';
import { readDaemonSettings } from '../settings.js';
import {
  closeTerminalsIn,
  defaultProjectOpener,
  readTerminalCounts,
  terminalBackendFor,
} from '../opener.js';
import { purgeProjectPipeline } from '../hook-pipeline.js';
import { hooksRoot } from '../../hooks/mirror.js';
import { projectHarnesses, withProjectHarnesses } from '../project-harnesses.js';
import { getUploadsDir } from '../../db/paths.js';

/** 项目存储配置（projects.meta.storage）：图片/文件各自的落盘目录，空 = 全局默认。 */
export interface ProjectStorage {
  images?: string | null;
  files?: string | null;
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
    let body: { harness?: unknown };
    try {
      body = JSON.parse((await readBody(req)) || '{}') as { harness?: unknown };
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
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
      const settings = await readDaemonSettings();
      const argv = [spec.bin, ...(spec.launchArgs ?? [])];
      await opener.runInTerminal(project.path, argv, settings.terminal);
      // 角标对账：新 pane 的 cwd 上报有一拍延迟（与 /open 同口径）。
      setTimeout(() => void deps.terminalRefresher?.refreshNow(), 600);
      sendJson(res, 200, { ok: true, command: argv.join(' '), cwd: project.path });
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
  // 的 preset 无枚举通道 → 空表。
  const terminalsMatch = pathname.match(/^\/projects\/(\d+)\/terminals$/);
  if (terminalsMatch && req.method === 'GET') {
    const project = deps.projects.getById(Number(terminalsMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    const settings = await readDaemonSettings();
    const list = deps.opener?.listTerminals ?? defaultProjectOpener.listTerminals!;
    const terminals = terminalBackendFor(settings.terminal).enumerable
      ? await list(project.path, settings.terminal)
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
      sendJson(res, 200, { counts: deps.terminalRefresher.lastSnapshot?.counts ?? {} });
      void deps.terminalRefresher.tick(true);
    } else {
      const opener = deps.opener ?? defaultProjectOpener;
      sendJson(res, 200, { counts: await readTerminalCounts(deps.projects.list(), opener) });
    }
    return true;
  }

  // --- 项目存储路径（对话附件的图片/文件落盘目录）---
  // GET：回配置 + 生效目录（自定义 ?? 全局默认）。PUT：校验绝对路径 + mkdirSync
  // 试写（写不进的目录当场拒，不留一个存了也落不了盘的配置）；空串 = 清回全局默认。
  // 存量文件留原处（uploads 行记 dir），新上传走新路径，零迁移。
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
      let body: { images?: unknown; files?: unknown };
      try {
        body = JSON.parse(await readBody(req)) as { images?: unknown; files?: unknown };
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return true;
      }
      const next: ProjectStorage = {};
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
