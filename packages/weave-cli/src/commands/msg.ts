import { DAEMON_HOST } from '@weavecode/server';
import { logger } from '@weavecode/core';
import { createRuntimeRegistry } from '@weavecode/harness';
import { ensureDaemonRunning } from './daemon.js';
import { t } from '../i18n/index.js';
import type { Command } from '../parser.js';

/**
 * `weave msg` —— 跨会话编排的 CLI 发起面（session-orchestration 批 3）：
 * 与 dashboard 同一 daemon 路由、同一能力面；agent 在会话内发起编排的入口
 * （ListAgents / SendMessage 的 CLI 对等物）。身份定位经 MessagingSurface 的
 * sessionEnv 声明（env 变量名是 harness 知识，CLI 不散写）。
 */

interface SessionRow {
  sessionId: string;
  title: string | null;
  harness: string | null;
  turnOpen?: boolean;
  pidAlive?: boolean | null;
}

interface MessageRow {
  id: number;
  fromKind: 'dashboard' | 'session' | 'cli';
  fromSessionId: string | null;
  toSessionId: string;
  text: string;
  mode: string;
  status: string;
  createdAt: string;
}

/** daemon JSON API：非 2xx 抛 Error（body.error 原文，与 web apiFetch 同口径）。 */
async function daemonApi<T>(port: number, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`http://${DAEMON_HOST}:${port}${path}`, init);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`));
  return body as T;
}

/**
 * 会话寻址（D4）：精确 id → id 前缀 → 标题模糊（皆大小写不敏感）。零命中 =
 * not-found；多命中 = ambiguous（带候选，由调用方渲染）。
 */
export function resolveSessionRef<T extends { sessionId: string; title: string | null }>(
  sessions: readonly T[],
  ref: string,
): { row: T } | { error: 'not-found' } | { error: 'ambiguous'; rows: T[] } {
  const lower = ref.toLowerCase();
  const exact = sessions.filter((s) => s.sessionId.toLowerCase() === lower);
  if (exact.length === 1) return { row: exact[0]! };
  const byPrefix = sessions.filter((s) => s.sessionId.toLowerCase().startsWith(lower));
  if (byPrefix.length === 1) return { row: byPrefix[0]! };
  const byTitle = sessions.filter(
    (s) => s.title != null && s.title.toLowerCase().includes(lower),
  );
  if (byTitle.length === 1) return { row: byTitle[0]! };
  const candidates = byPrefix.length > 0 ? byPrefix : byTitle;
  if (candidates.length > 1) return { error: 'ambiguous', rows: candidates };
  return { error: 'not-found' };
}

/** 当前会话 id：首个在 env 里取到值的面声明变量（claude = CLAUDE_CODE_SESSION_ID）。 */
export function currentSessionId(
  env: NodeJS.ProcessEnv,
  envNames: readonly (string | undefined)[],
): string | null {
  for (const name of envNames) {
    if (!name) continue;
    const value = env[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/**
 * 回复目标（D4「回复 = from 即 to」）：我的线程里最后一条入站消息的发起方。
 */
export function pickReplyTarget(
  messages: readonly Pick<MessageRow, 'toSessionId' | 'fromSessionId'>[],
  mySessionId: string,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.toSessionId === mySessionId && m.fromSessionId != null) return m.fromSessionId;
  }
  return null;
}

/** 简单列对齐（formatTable 是 label-value 形，此处要列式）。 */
function formatColumns(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}

const shortId = (id: string): string => id.slice(0, 8);

function sendTarget(port: number, ref: string): Promise<SessionRow> {
  return daemonApi<{ sessions: SessionRow[] }>(port, '/sessions')
    .then(({ sessions }) => {
      const resolved = resolveSessionRef(sessions, ref);
      if ('row' in resolved) return resolved.row;
      if (resolved.error === 'ambiguous') {
        throw new Error(
          t('out.msg.ambiguous', {
            ref,
            candidates: resolved.rows
              .map((r) => `${shortId(r.sessionId)}${r.title ? ` (${r.title})` : ''}`)
              .join(', '),
          }),
        );
      }
      throw new Error(t('out.msg.notFound', { ref }));
    });
}

/** CLI 的会话内身份：按注册面声明取 env（在 harness 会话外运行为 null）。 */
function mySessionId(): string | null {
  const envNames = createRuntimeRegistry()
    .byCapability('messaging')
    .flatMap((d) => (d.messaging?.sessionEnv ? [d.messaging.sessionEnv] : []));
  return currentSessionId(process.env, envNames);
}

async function sendAction(
  port: number,
  to: string,
  text: string,
  mode: string,
  fromSessionId: string | null,
): Promise<void> {
  const target = await sendTarget(port, to);
  const result = await daemonApi<{ ok: true; messageId: number; status: string }>(
    port,
    `/sessions/${encodeURIComponent(target.sessionId)}/messages`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, mode, fromKind: 'cli', fromSessionId }),
    },
  );
  logger.success(
    t('out.msg.sendOk', {
      target: target.title ?? shortId(target.sessionId),
      id: result.messageId,
      status: result.status,
    }),
  );
}

async function lsAction(port: number, ref: string | undefined): Promise<void> {
  const { sessions } = await daemonApi<{ sessions: SessionRow[] }>(port, '/sessions');
  if (!ref) {
    const { capabilities } = await daemonApi<{
      capabilities: Array<{ harness: string; discovery: boolean }>;
    }>(port, '/messaging/capabilities');
    const addressable = new Set(
      capabilities.filter((c) => c.discovery).map((c) => c.harness),
    );
    const rows = sessions.map((s) => [
      shortId(s.sessionId),
      s.title ?? '',
      s.harness ?? '-',
      s.turnOpen === undefined ? '-' : s.turnOpen ? t('out.msg.busy') : t('out.msg.idle'),
      s.harness != null && addressable.has(s.harness) ? '✓' : '—',
    ]);
    if (rows.length === 0) {
      logger.info(t('out.msg.noSessions'));
      return;
    }
    logger.info(
      t('out.msg.sessionHeader', { n: rows.length }),
    );
    console.log(
      formatColumns([
        [
          t('out.msg.col.session'),
          t('out.msg.col.title'),
          t('out.msg.col.harness'),
          t('out.msg.col.state'),
          t('out.msg.col.msg'),
        ],
        ...rows,
      ]),
    );
    return;
  }
  const target = await sendTarget(port, ref);
  const { messages } = await daemonApi<{ messages: MessageRow[] }>(
    port,
    `/sessions/${encodeURIComponent(target.sessionId)}/messages`,
  );
  logger.info(
    t('out.msg.threadHeader', {
      session: target.title ?? target.sessionId,
      n: messages.length,
    }),
  );
  for (const m of messages) {
    const dir = m.fromSessionId === target.sessionId ? '▶' : '◀';
    const from =
      m.fromKind === 'dashboard'
        ? 'dashboard'
        : m.fromKind === 'cli'
          ? 'cli'
          : (m.fromSessionId ?? '?');
    console.log(`${m.createdAt.slice(11, 19)} ${dir} ${from} [${m.status}] ${m.text.slice(0, 80)}`);
  }
}

async function watchAction(
  port: number,
  ref: string,
  notify: string | undefined,
): Promise<void> {
  const target = await sendTarget(port, ref);
  const fromSessionId = mySessionId();
  const result = await daemonApi<{ ok: true; watchId: number }>(
    port,
    `/sessions/${encodeURIComponent(target.sessionId)}/watch`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ watcherSessionId: fromSessionId, notify: notify ?? null }),
    },
  );
  logger.success(
    t('out.msg.watchOk', {
      target: target.title ?? shortId(target.sessionId),
      id: result.watchId,
      via: fromSessionId ?? t('out.msg.watchViaDashboard'),
    }),
  );
}

async function replyAction(port: number, text: string): Promise<void> {
  const fromSessionId = mySessionId();
  if (!fromSessionId) {
    logger.warn(t('out.msg.replyNoSession'));
    process.exitCode = 1;
    return;
  }
  const { messages } = await daemonApi<{ messages: MessageRow[] }>(
    port,
    `/sessions/${encodeURIComponent(fromSessionId)}/messages`,
  );
  const target = pickReplyTarget(messages, fromSessionId);
  if (!target) {
    logger.warn(t('out.msg.replyNothing'));
    process.exitCode = 1;
    return;
  }
  await sendAction(port, target, text, 'inject', fromSessionId);
}

export const msgCommand: Command = {
  name: 'msg',
  description: 'cmd.msg.desc',
  subcommands: [
    {
      name: 'ls',
      description: 'cmd.msg.ls.desc',
      async action(ctx) {
        const handle = await ensureDaemonRunning();
        try {
          await lsAction(handle.port, ctx.positional[0]);
        } catch (e) {
          logger.warn(t('out.msg.failed', { error: e instanceof Error ? e.message : String(e) }));
          process.exitCode = 1;
        }
      },
    },
    {
      name: 'send',
      description: 'cmd.msg.send.desc',
      options: [
        {
          name: 'mode',
          short: 'm',
          description: 'flag.msg.mode',
          type: 'string',
          choices: ['auto', 'inject', 'headless'],
          default: 'inject',
        },
      ],
      async action(ctx) {
        const ref = ctx.positional[0];
        const text = ctx.positional.slice(1).join(' ');
        if (!ref || !text) {
          logger.warn(t('out.msg.sendUsage'));
          process.exitCode = 1;
          return;
        }
        const handle = await ensureDaemonRunning();
        try {
          await sendAction(handle.port, ref, text, String(ctx.flags.mode ?? 'inject'), mySessionId());
        } catch (e) {
          logger.warn(t('out.msg.sendFail', { error: e instanceof Error ? e.message : String(e) }));
          process.exitCode = 1;
        }
      },
    },
    {
      name: 'watch',
      description: 'cmd.msg.watch.desc',
      options: [
        {
          name: 'notify',
          description: 'flag.msg.notify',
          type: 'string',
        },
      ],
      async action(ctx) {
        const ref = ctx.positional[0];
        if (!ref) {
          logger.warn(t('out.msg.watchUsage'));
          process.exitCode = 1;
          return;
        }
        const handle = await ensureDaemonRunning();
        try {
          await watchAction(handle.port, ref, ctx.flags.notify == null ? undefined : String(ctx.flags.notify));
        } catch (e) {
          logger.warn(t('out.msg.watchFail', { error: e instanceof Error ? e.message : String(e) }));
          process.exitCode = 1;
        }
      },
    },
    {
      name: 'reply',
      description: 'cmd.msg.reply.desc',
      async action(ctx) {
        const text = ctx.positional.join(' ');
        if (!text) {
          logger.warn(t('out.msg.replyUsage'));
          process.exitCode = 1;
          return;
        }
        const handle = await ensureDaemonRunning();
        try {
          await replyAction(handle.port, text);
        } catch (e) {
          logger.warn(t('out.msg.sendFail', { error: e instanceof Error ? e.message : String(e) }));
          process.exitCode = 1;
        }
      },
    },
  ],
};
