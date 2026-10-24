import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WeaveServerDeps } from '../server.js';
import { readJson, sendJson } from '../http.js';
import { composeAnswerAtoms } from '../../hooks/answer-keys.js';
import { readSideQuestions } from '../../hooks/side-questions.js';

const SideQuestionBody = z.object({ question: z.string().min(1).max(4_000) });

/** 模型切换：名字用户自填（网关模型 ID 会增删，不做静态映射表），形态由 deliverer 验。 */
const SetModelBody = z.object({ model: z.string().min(1).max(128) });
const SetEffortBody = z.object({ level: z.string().min(1).max(32) });

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

/**
 * 会话控制域路由：中断、关 pane、执行模式/模型/思考强度切换、阻塞问答作答、
 * 旁路会话（/btw）。全部经 MessageDeliverer 的层② 终端通道打键。返回 true = 本路由
 * 认领；false = 未命中，主链继续。
 */
export async function handleSessionControlRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
  url: URL,
): Promise<boolean> {
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

  // ---- 手动提交：一记回车（提交宿主输入框里现成的内容；键序固定死在服务端）----
  const enterMatch = pathname.match(/^\/sessions\/([^/]+)\/enter$/);
  if (enterMatch && req.method === 'POST') {
    if (!deps.messageDeliverer) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const sessionId = decodeURIComponent(enterMatch[1]!);
    const result = await deps.messageDeliverer.pressEnter(sessionId);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    sendJson(res, 200, { ok: true, sessionId });
    return true;
  }

  // ---- 手动硬中断：一记 Ctrl+C（不落转录标记，只报送出；键序固定死在服务端）----
  const ctrlCMatch = pathname.match(/^\/sessions\/([^/]+)\/ctrl-c$/);
  if (ctrlCMatch && req.method === 'POST') {
    if (!deps.messageDeliverer) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const sessionId = decodeURIComponent(ctrlCMatch[1]!);
    const result = await deps.messageDeliverer.pressCtrlC(sessionId);
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

  return false;
}
