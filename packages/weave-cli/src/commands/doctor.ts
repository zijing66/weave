import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DAEMON_HOST,
  DEFAULT_PORT,
  getDbPath,
  ensureDataLayout,
  openDatabase,
  ProjectRepository,
  readDaemonState,
} from '@weavecode/server';
import { formatTable, logger } from '@weavecode/core';
import { checkHarness } from '../init/harness-checks.js';
import { probeDaemon } from './daemon.js';
import { localTokenHeader } from './daemon-auth.js';
import { t } from '../i18n/index.js';
import type { MessageKey } from '../i18n/dict/index.js';
import type { Command } from '../parser.js';

/** 本机注册表命中项（路径按平台口径归一后比较）。 */
interface RegistryHit {
  id: number;
  source: 'init' | 'scan';
  archived: boolean;
  token: string;
}

// ---- 投递诊断（GET /messaging/diagnostics）：只声明用到的字段，形状归 server ----

/** 生效采集脚本的健康（判据见 harness 的 CaptureSurface.scriptHealth）。 */
interface DiagScript {
  harness: string;
  source: 'user' | 'project' | 'none';
  present: boolean;
  weaveOwned: boolean;
  generatedVersion: string | null;
  reportsInbox: boolean;
  reportsPaneEnv: boolean;
}

/** 通道现况：unknown = 判不动（终端只剩标题/cwd 回落）。 */
interface DiagChannel {
  status: 'ready' | 'unavailable' | 'unknown';
  reason: string | null;
}

interface DiagSession {
  sessionId: string;
  title: string | null;
  alive: boolean | null;
  eventCount: number;
  lastEventType: string | null;
  channels: { inbox: DiagChannel; relay: DiagChannel; terminal: DiagChannel };
  queue: { pending: number; stalled: boolean };
  reachable: boolean;
  hints: string[];
}

interface DiagResponse {
  daemon: {
    version: string;
    platform: string;
    terminalPreset: string;
    terminalTextChannel: boolean;
  };
  projects: Array<{ id: number; captures: DiagScript[] }>;
  sessions: DiagSession[];
}

/** 通道不可用的成因（码表与 server 的 diagnose reason 一一对应）。 */
const REASON: Record<string, MessageKey> = {
  'no-mechanism': 'out.doctor.reason.noMechanism',
  'no-credentials': 'out.doctor.reason.noCredentials',
  'auth-token-required': 'out.doctor.reason.authTokenRequired',
  'no-peer-name': 'out.doctor.reason.noPeerName',
  'no-backend': 'out.doctor.reason.noBackend',
  'no-pane-env': 'out.doctor.reason.noPaneEnv',
};

/** 修法码（码表与 server 的 deliveryHints 一一对应）。 */
const HINT: Record<string, MessageKey> = {
  'no-hook-script': 'out.doctor.hint.noHookScript',
  'hook-script-not-weave': 'out.doctor.hint.hookScriptNotWeave',
  'hook-script-stale': 'out.doctor.hint.hookScriptStale',
  'no-events': 'out.doctor.hint.noEvents',
  'no-inbox-credentials': 'out.doctor.hint.noInboxCredentials',
  'inbox-token-required': 'out.doctor.hint.inboxTokenRequired',
  'no-peer-name': 'out.doctor.hint.noPeerName',
  'terminal-no-backend': 'out.doctor.hint.terminalNoBackend',
  'terminal-no-pane-env': 'out.doctor.hint.terminalNoPaneEnv',
  'not-running': 'out.doctor.hint.notRunning',
  queued: 'out.doctor.hint.queued',
  stalled: 'out.doctor.hint.stalled',
};

/** 码 → 文案；不认得的码原样回显（跨版本：新 daemon 的码不该凭空消失）。 */
function codeText(map: Record<string, MessageKey>, code: string | null): string {
  if (!code) return '';
  const key = map[code];
  return key ? t(key) : code;
}

/** 采集脚本一行（缺 / 非 weave 生成 / 正常，三种形态各一句话）。 */
function scriptText(capture: DiagScript | null): string {
  if (!capture || !capture.present) return t('out.doctor.diagScriptNone');
  const source =
    capture.source === 'user'
      ? t('out.doctor.diagSourceUser')
      : capture.source === 'project'
        ? t('out.doctor.diagSourceProject')
        : t('out.doctor.diagSourceNone');
  if (!capture.weaveOwned) return t('out.doctor.diagScriptNotOwned', { source });
  const yes = t('out.doctor.diagYes');
  return t('out.doctor.diagScriptValue', {
    harness: capture.harness,
    source,
    version: capture.generatedVersion ?? t('out.doctor.diagMissing'),
    inbox: capture.reportsInbox ? yes : t('out.doctor.diagNo'),
    pane: capture.reportsPaneEnv ? yes : t('out.doctor.diagNo'),
  });
}

/** 通道一格：可用 / 不可用（成因）/ 判不动（成因）。 */
function channelText(channel: DiagChannel): string {
  const reason = codeText(REASON, channel.reason);
  if (channel.status === 'ready') return t('out.doctor.diagReady');
  return channel.status === 'unknown'
    ? t('out.doctor.diagUnknown', { reason })
    : t('out.doctor.diagUnavailable', { reason });
}

/**
 * 打一节「消息投递诊断」：daemon 事实 + 采集脚本健康 + 每个会话的三通道矩阵。
 * 这是「消息为什么送不到」的唯一查法——能力矩阵只报机制有没有，不报本机凭据在不在。
 * 取不到（daemon 拒答/令牌不对）只降级本节，其余输出照旧。
 */
async function printDeliveryDiagnostics(port: number, projectId: number): Promise<void> {
  let data: DiagResponse;
  try {
    const res = await fetch(
      `http://${DAEMON_HOST}:${port}/messaging/diagnostics?project=${projectId}`,
      { headers: localTokenHeader() },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // 非 JSON 的 200 = 老 daemon 没这条路由，落到了静态兜底（读成 HTML 也没用）
    try {
      data = (await res.json()) as DiagResponse;
    } catch {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (e) {
    logger.warn(
      t('out.doctor.diagFailed', { error: e instanceof Error ? e.message : String(e) }),
    );
    return;
  }

  const { daemon } = data;
  const capture = data.projects.find((p) => p.id === projectId)?.captures[0] ?? null;
  console.log();
  logger.info(t('out.doctor.diagHeader', { id: projectId }));
  console.log(
    formatTable([
      [
        t('out.doctor.diagDaemon'),
        t('out.doctor.diagDaemonValue', {
          version: daemon.version,
          platform: daemon.platform,
          preset: daemon.terminalPreset,
          channel: t(
            daemon.terminalTextChannel ? 'out.doctor.diagChannelOn' : 'out.doctor.diagChannelOff',
          ),
        }),
      ],
      [t('out.doctor.diagScript'), scriptText(capture)],
    ]),
  );

  if (data.sessions.length === 0) {
    logger.dim(t('out.doctor.diagNoSessions'));
    return;
  }

  const yesNo = (v: boolean | null): string =>
    v === null ? t('out.doctor.diagUnknownAlive') : t(v ? 'out.doctor.diagYes' : 'out.doctor.diagNo');
  for (const s of data.sessions) {
    console.log();
    console.log(
      '  ' +
        t('out.doctor.diagSession', {
          id: s.sessionId.slice(0, 8),
          title: s.title ?? t('out.doctor.diagUntitled'),
          alive: yesNo(s.alive),
          events: s.eventCount,
          last: s.lastEventType ?? t('out.doctor.diagMissing'),
        }),
    );
    console.log(
      '    ' +
        t('out.doctor.diagChannels', {
          inbox: channelText(s.channels.inbox),
          relay: channelText(s.channels.relay),
          terminal: channelText(s.channels.terminal),
        }),
    );
    console.log(
      '    ' +
        t('out.doctor.diagQueue', {
          pending: s.queue.pending,
          stalled: t(s.queue.stalled ? 'out.doctor.diagYes' : 'out.doctor.diagNo'),
        }),
    );
    if (s.hints.length > 0) {
      logger.dim(
        '    ' +
          t('out.doctor.diagHints', {
            hints: s.hints.map((h) => codeText(HINT, h)).join('；'),
          }),
      );
    }
  }
}

const normalizePath = (p: string): string => {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/**
 * 在 daemon 的 SQLite 注册表里按路径找这条项目。DB 文件不存在 = 从未注册过项目，
 * 直接判未注册——不 openDatabase，免得一个只读检查凭空建库。
 */
function lookupRegistered(dir: string): RegistryHit | null {
  if (!existsSync(getDbPath())) return null;
  const db = openDatabase();
  try {
    const projects = new ProjectRepository(db);
    const target = normalizePath(dir);
    const row = [...projects.list(), ...projects.listArchived()].find(
      (r) => normalizePath(r.path) === target,
    );
    return row
      ? { id: row.id, source: row.source, archived: row.archivedAt !== null, token: row.token }
      : null;
  } finally {
    db.close();
  }
}

/** `<project>/.weave/token` 的内容；缺席返回 null。 */
function readLocalToken(dir: string): string | null {
  const file = path.join(dir, '.weave', 'token');
  return existsSync(file) ? readFileSync(file, 'utf-8').trim() : null;
}

/**
 * `weave doctor` — 诊断本机与 weave server 的接线。
 *
 * `weave status` 只看项目目录里的文件；本命令补上它看不见的一侧：这条检出是否
 * 已在 daemon 注册表中（典型故障 = 仓库重拉取后带着 weave 文件却从没在本机 init）。
 */
export const doctorCommand: Command = {
  name: 'doctor',
  description: 'cmd.doctor.desc',
  options: [
    {
      name: 'dir',
      short: 'd',
      description: 'flag.dir',
      type: 'string',
      default: process.cwd(),
    },
  ],

  async action(ctx) {
    // 旧布局（顶层散放）先搬成三档目录，否则下面按新路径找库会扑空。有活着的
    // daemon 占着数据目录时本次自动跳过（见 migrateDataLayout）。
    ensureDataLayout();
    const dir = path.resolve(String(ctx.flags.dir ?? process.cwd()));
    const initialized = existsSync(path.join(dir, '.weave', 'config.yaml'));

    const state = readDaemonState();
    const port = state?.port ?? DEFAULT_PORT;
    const running = await probeDaemon(port);

    const hit = lookupRegistered(dir);
    const token = readLocalToken(dir);

    let tokenState: string;
    if (token === null) tokenState = t('out.doctor.tokenMissing');
    else if (!hit) tokenState = t('out.doctor.tokenUnregistered');
    else if (token === hit.token) tokenState = t('out.doctor.tokenOk');
    else tokenState = t('out.doctor.tokenStale');

    logger.info(t('out.doctor.header'));
    console.log(
      formatTable([
        [t('out.doctor.dir'), dir],
        [t('out.doctor.initialized'), initialized ? t('out.doctor.yes') : t('out.doctor.no')],
        [
          t('out.doctor.daemon'),
          running ? t('out.doctor.daemonRunning', { port }) : t('out.doctor.daemonStopped'),
        ],
        [
          t('out.doctor.registered'),
          hit
            ? t(hit.archived ? 'out.doctor.registeredArchived' : 'out.doctor.registeredYes', {
                id: hit.id,
                source: hit.source,
              })
            : t('out.doctor.registeredNo'),
        ],
        [t('out.doctor.token'), tokenState],
      ]),
    );
    console.log();

    const issues = await checkHarness(dir);
    if (issues.length > 0) {
      logger.warn(t('out.status.issuesFound', { count: issues.length }));
      for (const issue of issues) {
        logger.warn(t('out.status.issue', { message: issue.message }));
        logger.dim(t('out.status.fix', { fix: issue.fix }));
      }
      console.log();
    }

    // 投递诊断要 daemon 活着且项目已注册（凭据与队列都在 daemon 的内存/数据目录里）。
    if (running && hit && !hit.archived) await printDeliveryDiagnostics(port, hit.id);

    if (!hit) {
      logger.warn(t('out.doctor.warnNotRegistered'));
      logger.dim(t('out.doctor.fixInit'));
      if (!initialized) logger.dim(t('out.doctor.fixScan', { dir }));
      return;
    }
    if (hit.archived) {
      logger.warn(t('out.doctor.warnArchived'));
      return;
    }
    if (token === null) {
      logger.warn(t('out.doctor.warnTokenMissing'));
      logger.dim(t('out.doctor.fixInit'));
      return;
    }
    if (token !== hit.token) {
      logger.warn(t('out.doctor.warnTokenStale'));
      logger.dim(t('out.doctor.fixInit'));
      return;
    }

    logger.success(t('out.doctor.ok'));
    if (!running) logger.dim(t('out.doctor.fixDaemon'));
  },
};
