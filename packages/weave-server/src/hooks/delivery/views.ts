import { combinedLivenessOf } from '../../daemon/liveness.js';
import type { SessionTerminal } from '../../daemon/opener.js';
import type { ProjectRepository } from '../../repositories/projects.js';
import type { SessionRepository } from '../../repositories/sessions.js';
import { readAllPromptbox, readPromptbox, type PromptboxEntry } from '../promptbox.js';
import type { PipeMessage } from '../message-deliverer.js';
import { sessionJudgedDead } from './queue.js';

/**
 * 投递域的只读派生面：在途视图（对话尾巴）、在途计数（会话行角标）、会话 →
 * 可见屏幕（列表分块）。全部现算、不落任何东西——「管道不记录历史」的读侧。
 */

/** 队列行 → 在途视图行（pending 形态）。 */
function pendingView(sessionId: string, entry: PromptboxEntry): PipeMessage {
  return {
    id: entry.id,
    sessionId,
    text: entry.text,
    ...(entry.attachments && entry.attachments.length > 0 ? { attachments: entry.attachments } : {}),
    mode: 'prompt',
    oneWay: entry.oneWay === true,
    ...(entry.forceTerminal === true ? { forceTerminal: true } : {}),
    channel: 'prompt',
    status: 'pending',
    at: entry.at,
  };
}

/**
 * 在途视图（GET /sessions/:id/messages 的数据面）：promptbox 待递送 ∪ 内存态——
 * 终态短时驻留（delivered/injected/succeeded 在 settledAt+ttl 内可见，展示
 * via/acked），failed/timeout/暂停闸成因常驻。历史在会话自己的转录里。
 * 例外：已执行的斜杠命令（/rewind 类，宿主不回 UPS）也常驻——它们没有认领
 * 事件可退场，TTL 一到就消失会让「刚才那条命令呢」无从查起。**判据是「没有
 * 认领事件」**（`ackedEventId` 空）：skill/插件命令的正文也以 `/` 开头，但它的
 * UPS 就是气泡，留着这行等于同一条消息在对话尾巴上多挂一个「已执行」。
 */
export function listVisible(
  deps: {
    sessions: Pick<SessionRepository, 'getBySessionId'>;
    projects: Pick<ProjectRepository, 'getById'>;
  },
  hooksDir: string,
  memory: ReadonlyMap<string, PipeMessage>,
  sessionId: string,
  ttlMs: number,
  isCommandInput: (text: string) => boolean = () => false,
): PipeMessage[] {
  const now = Date.now();
  const out: PipeMessage[] = [];
  const session = deps.sessions.getBySessionId(sessionId);
  if (session?.projectId != null) {
    const project = deps.projects.getById(session.projectId);
    if (project) {
      for (const entry of readPromptbox(hooksDir, project.token)) {
        if (entry.sessionId !== sessionId) continue;
        out.push(pendingView(sessionId, entry));
      }
    }
  }
  for (const msg of memory.values()) {
    if (msg.sessionId !== sessionId) continue;
    if (msg.stalled === true || msg.status === 'delivering' || msg.status === 'running') {
      out.push(msg);
      continue;
    }
    if (msg.status === 'failed' || msg.status === 'timeout') {
      out.push(msg);
      continue;
    }
    const settled = msg.settledAt ? Date.parse(msg.settledAt) : NaN;
    // 送达未回执 = 在飞（气泡还没来）：窗口过了也别撤，否则队列里那条先消失、
    // 等到未回执闸落定时又冒出来，看着像发丢了。
    const unacked = msg.status === 'delivered' && msg.acked !== true;
    // 已执行的斜杠命令常驻（见上）：TTL 豁免，与 failed 同待遇。只有没有认领
    // 事件的那些（内建命令 / bash 模式）才常驻——有 `ackedEventId` 的行气泡已经在
    // 对话里，留着它同一条消息会露两遍。
    const executedCmd =
      msg.status === 'delivered' &&
      msg.acked === true &&
      msg.ackedEventId == null &&
      isCommandInput(msg.text);
    if (unacked || executedCmd || (!Number.isNaN(settled) && now - settled < ttlMs)) out.push(msg);
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : 1));
}

/**
 * 在途计数（sessionId → 条数）：队列 pending（未送达）∪ 内存 delivering/running
 * （在飞）。会话行角标用——终态（injected/delivered/succeeded/…）不计。
 */
export function listInflightCounts(
  hooksDir: string,
  memory: ReadonlyMap<string, PipeMessage>,
): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (sessionId: string): void => {
    counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
  };
  for (const entry of readAllPromptbox(hooksDir)) bump(entry.sessionId);
  for (const msg of memory.values()) {
    if (msg.status === 'delivering' || msg.status === 'running') bump(msg.sessionId);
  }
  return counts;
}

/**
 * 会话 → 所在可见屏幕（会话列表分块的数据面）。旁路 env 与投递路径共用同一份
 * 缓存，不另采一次；后端没有反查能力 = 空表（那些会话不分组）。顺手摘掉已判死
 * 会话的 env：那是上一次见到它时的快照，它不会再来报一次，留着只会让死会话常占块头。
 */
export async function sessionTerminals(
  deps: {
    sessions: Pick<SessionRepository, 'livenessRowOf'>;
    livenessOf?: () => Map<string, boolean>;
  },
  terminal: {
    locateScreens?(
      envs: Record<string, Record<string, string>>,
    ): Promise<Record<string, SessionTerminal | null>>;
  } | null,
  paneEnvs: Map<string, Record<string, string>>,
  persistPaneEnvs: () => void,
  /** 定位已被撤销的会话（会话退出）：显式回 null 摘出分组，报完即焚。 */
  revoked?: Set<string>,
): Promise<Record<string, SessionTerminal | null>> {
  const out: Record<string, SessionTerminal | null> = {};
  // 撤销了定位的会话不在 paneEnvs 里、这轮扫描也探不到它，而合并契约是
  // 「缺席 = 保留上次分块」——不显式回 null，旧分块会永远留在快照里（会话
  // 退出后仍挂在终端分组下的根源）。报完即焚：await 期间新撤销的下一轮再报。
  if (revoked && revoked.size > 0) {
    for (const sessionId of revoked) out[sessionId] = null;
    revoked.clear();
  }
  if (!terminal?.locateScreens || paneEnvs.size === 0) return out;
  const envs: Record<string, Record<string, string>> = {};
  const liveness = deps.livenessOf?.() ?? combinedLivenessOf();
  for (const [sessionId, env] of paneEnvs) {
    // 盘上的 env 是上一次见到它时的快照：进程已判死的会话不该还占着那块屏的块头。
    // 必须显式回 null——refresher 的合并契约是「缺席 = 保留上次分块」，只摘不报
    // 的话旧分块会永远留在快照里（手动关 pane 后会话仍挂在终端分组下的根源）。
    if (sessionJudgedDead(deps.sessions, sessionId, liveness)) {
      paneEnvs.delete(sessionId);
      persistPaneEnvs();
      out[sessionId] = null;
      continue;
    }
    envs[sessionId] = env;
  }
  return { ...out, ...(await terminal.locateScreens(envs)) };
}
