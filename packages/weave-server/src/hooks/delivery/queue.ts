import { pidAliveOf } from '../../daemon/claude-liveness.js';
import { combinedLivenessOf } from '../../daemon/liveness.js';
import type { SessionRepository } from '../../repositories/sessions.js';
import type { ProjectRepository } from '../../repositories/projects.js';
import {
  appendPromptbox,
  removePromptboxEntries,
  type PromptboxEntry,
} from '../promptbox.js';
import type { PipeMessage } from '../message-deliverer.js';

/**
 * 层③ promptbox 队列的纯函数与死信落定：入队、判死、判死落定（整批 offline）。
 *
 * 队列文件是唯一事实源（`<dataDir>/hooks/promptbox/<shard>.jsonl`，送达即删行）；
 * 「哪些会话有队列」的索引（queuedSessions）与冲洗泵归宿主，本模块只做单行/整批
 * 的文件操作与落定形态——测试可以直接对着临时目录跑。
 */

export const OFFLINE_ERROR = 'Session is not running';

/** 入队（promptbox 追加；会话索引由宿主登记）。 */
export function appendQueueEntry(hooksDir: string, token: string, entry: PipeMessage): void {
  appendPromptbox(hooksDir, token, [
    {
      id: entry.id,
      sessionId: entry.sessionId,
      text: entry.text,
      oneWay: entry.oneWay === true,
      ...(entry.forceTerminal === true ? { forceTerminal: true } : {}),
      ...(entry.attachments && entry.attachments.length > 0 ? { attachments: entry.attachments } : {}),
    },
  ]);
}

/**
 * 该会话是否已判死：存活图 `pidAlive === false` 才认，`null` 不猜
 * （codex 锁宽限窗 / 新会话豁免窗 / SessionStart 空壳行都落 null）。判据与
 * 「已终止」态、两条 terminated 补射同源（claude-liveness 的 pidAliveOf）
 * ——消息行与会话行不会各说各话。
 */
export function sessionJudgedDead(
  sessions: Pick<SessionRepository, 'livenessRowOf'>,
  sessionId: string,
  liveness: Map<string, boolean> = combinedLivenessOf(),
): boolean {
  const row = sessions.livenessRowOf(sessionId);
  if (!row) return false;
  return pidAliveOf(row, liveness) === false;
}

/**
 * 判死落定（单行）：三层全无通路、目标进程又不在——**不假装排队**，落 `failed` +
 * `reason: 'offline'`（`message.finished` 帧照抛，既有 messageFailed 订阅提醒
 * 生效）。**刻意不置暂停闸**：队列整批转 offline 后已空，闸只会挡住用户重发
 * ——重发是有意的可逆出口（判活残差 / 会话其实活着时，一点就回来）。
 */
export function failOffline(
  memory: Map<string, PipeMessage>,
  emit: (message: { kind: string; [key: string]: unknown }) => void,
  entry: PipeMessage,
): PipeMessage {
  const at = new Date().toISOString();
  const failed: PipeMessage = {
    ...entry,
    status: 'failed',
    reason: 'offline',
    error: OFFLINE_ERROR,
    settledAt: at,
  };
  memory.set(entry.id, failed);
  emit({
    kind: 'message.finished',
    messageId: entry.id,
    sessionId: entry.sessionId,
    status: 'failed',
    at,
  });
  return failed;
}

/** 冲洗时判死：**该会话全部队列行**都是死信（死会话投不进去），整批落定 + 清队。 */
export function failQueuedOffline(
  deps: {
    sessions: Pick<SessionRepository, 'getBySessionId'>;
    projects: Pick<ProjectRepository, 'getById'>;
  },
  hooksDir: string,
  memory: Map<string, PipeMessage>,
  emit: (message: { kind: string; [key: string]: unknown }) => void,
  sessionId: string,
  entries: readonly PromptboxEntry[],
): void {
  const session = deps.sessions.getBySessionId(sessionId);
  const project = session?.projectId == null ? null : deps.projects.getById(session.projectId);
  if (!project || entries.length === 0) return;
  for (const entry of entries) {
    failOffline(memory, emit, {
      id: entry.id,
      sessionId,
      text: entry.text,
      ...(entry.attachments && entry.attachments.length > 0 ? { attachments: entry.attachments } : {}),
      mode: 'prompt',
      oneWay: entry.oneWay === true,
      channel: 'prompt',
      status: 'pending',
      at: entry.at,
    });
  }
  removePromptboxEntries(hooksDir, project.token, new Set(entries.map((e) => e.id)));
}
