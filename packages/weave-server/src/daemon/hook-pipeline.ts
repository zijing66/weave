import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getDbPath } from '../db/paths.js';
import type { HookEventBus } from '../hooks/bus.js';
import type { HookDispatcher } from '../hooks/dispatcher.js';
import type { WatchEngine } from '../hooks/watch-engine.js';
import type { SequenceEngine } from '../hooks/sequence-engine.js';
import { MirrorWriter, hookShardId, hooksRoot, mirrorPathOf, outboxPathOf } from '../hooks/mirror.js';
import { promptboxPathOf } from '../hooks/promptbox.js';
import type { MessageDeliverer } from '../hooks/message-deliverer.js';
import type { QuestionTracker } from '../hooks/question-tracker.js';
import {
  startInboxWorker,
  handleIngestedRecords,
  unparkFailedInbox,
  INBOX_CLAIM_SUFFIX,
  INBOX_FAILED_SUFFIX,
  type InboxRecord,
} from '../hooks/inbox-worker.js';
import type { HookRuleRegistry } from '../hooks/registry.js';
import type { ProjectRepository } from '../repositories/projects.js';
import type { SessionRepository } from '../repositories/sessions.js';

export interface HookPipelineDeps {
  projects: ProjectRepository;
  rules: HookRuleRegistry;
  sessions: SessionRepository;
  bus: HookEventBus;
  dispatcher: HookDispatcher;
  /** 空闲订阅引擎（批 2）：透传给 handleIngestedRecords（与 dispatcher 平行触发）。 */
  watchEngine?: Pick<WatchEngine, 'onEvent'>;
  /** 序列引擎（批 3）：同透传——inject 步完成判据挂在 ingest 消费路径。 */
  sequenceEngine?: Pick<SequenceEngine, 'onEvent'>;
  /** prompt 队列冲洗（消息域重塑）：ingest 事件 = 会话活着，即时试递队列行。 */
  messagePipe?: Pick<MessageDeliverer, 'hasQueued' | 'flushSession'>;
  /** 阻塞式问答跟踪（AskUserQuestion/计划/权限确认）：ingest 事件派生待答面。 */
  questionTracker?: Pick<QuestionTracker, 'onEvent'>;
  /** 会话转录路径上报（中断态探测；同 pane env 口径）。 */
  sessionProbe?: { noteTranscript(sessionId: string, path: string | null): void };
}

/** 一个 shard 的全部管道文件（inbox 三种形态 + mirror + outbox + promptbox）。 */
function pipelineFilesOf(hooksDir: string, shardId: string): string[] {
  return [
    join(hooksDir, 'inbox', `${shardId}.jsonl`),
    join(hooksDir, 'inbox', `${shardId}${INBOX_CLAIM_SUFFIX}`),
    join(hooksDir, 'inbox', `${shardId}${INBOX_FAILED_SUFFIX}`),
    mirrorPathOf(hooksDir, shardId),
    outboxPathOf(hooksDir, shardId),
    promptboxPathOf(hooksDir, shardId),
  ];
}

/** 删除一个项目的全部管道文件（忽略不存在）。删项目路由落地时一行调用。 */
export function purgeProjectPipeline(hooksDir: string, token: string): void {
  for (const file of pipelineFilesOf(hooksDir, hookShardId(token))) {
    try {
      unlinkSync(file);
    } catch {
      // 不存在即已达目的
    }
  }
}

/** 文件名 → shard（先剥 tmp 中间产物，再剥已知后缀）。 */
function shardOfFileName(name: string): string {
  const base = name.endsWith('.tmp') ? name.slice(0, -'.tmp'.length) : name;
  return base
    .replace(new RegExp(`(${INBOX_CLAIM_SUFFIX}|${INBOX_FAILED_SUFFIX})$`), '')
    .replace(/\.(jsonl|json)$/, '');
}

/** shard 形（sha256 前 16 位 hex）——只回收长得像 shard 的文件，别误删目录里的其他东西。 */
const SHARD_SHAPE = /^[0-9a-f]{16}$/;

/**
 * 孤儿管道文件回收：项目行已删（或历史上删过）留下的 shard 文件不会有人再消费
 * ——启动时扫一遍三个目录，shard 不匹配任何活跃项目 token 的直接删（归档项目
 * 的 shard 也不在活跃集内：归档即焚，残留文件一并回收）。
 *
 * 安全性：命中即「DB 里没这个 token（或已归档不消费）」，这类文件的行无论谁
 * 消费都归因不到活跃项目（消费侧按 token 查不到项目/查到归档即丢行），所以
 * 删除不损失任何可入库的数据。只在启动时跑一次（装配点），避免与运行中的
 * hook 写侧互相追尾。
 */
export function purgeOrphanPipelineFiles(deps: {
  projects: Pick<ProjectRepository, 'list'>;
  hooksDir: string;
}): number {
  const live = new Set(deps.projects.list().map((p) => hookShardId(p.token)));
  let removed = 0;
  for (const dir of ['inbox', 'mirror', 'outbox', 'promptbox']) {
    let names: string[];
    try {
      names = readdirSync(join(deps.hooksDir, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      const shard = shardOfFileName(name);
      if (!SHARD_SHAPE.test(shard) || live.has(shard)) continue;
      try {
        unlinkSync(join(deps.hooksDir, dir, name));
        removed++;
      } catch {
        // 已被并发清掉即算达成
      }
    }
  }
  return removed;
}

export interface HookPipeline {
  /** 交给 createWeaveServer：会话改名/删除后即时重写镜像。 */
  mirror: MirrorWriter;
  stop(): Promise<void>;
}

/**
 * hook 文件管道的 daemon 侧装配——两个入口共用（start.ts 生产 / dev-entry.ts 开发）：
 * - mirror：规则变更（registry.onChange）与会话标题变更（bus）时重写注入计划；
 * - inbox 消费线程：认领→入库（worker 内独立 db 连接），记录回主线程补 SSE/规则分发。
 *
 * 漏挂任何一环的表现都是「hook 在写 inbox，但 dashboard 没有事件」——新增入口时
 * 必须调用本函数，不要各自手写装配（dev-entry 曾因此静默漏掉整条链路）。
 */
export function wireHookFilePipeline(deps: HookPipelineDeps): HookPipeline {
  const hooksDir = hooksRoot();
  // 先回收孤儿文件（已删项目的残留），再起消费线程——顺序避免与运行中的写侧追尾
  const purged = purgeOrphanPipelineFiles({ projects: deps.projects, hooksDir });
  if (purged > 0) console.log(`[weave] hook pipeline: purged ${purged} orphan file(s)`);

  // 先回收孤儿，再复活上一次进程停放的失败文件（瞬时争用居多，重启给一轮新机会）
  const revived = unparkFailedInbox(hooksDir);
  if (revived > 0) console.log(`[weave] hook pipeline: revived ${revived} parked inbox file(s)`);

  const mirror = new MirrorWriter({
    projects: deps.projects,
    rules: deps.rules,
    sessions: deps.sessions,
  });
  deps.rules.onChange = () => mirror.syncAll();
  mirror.attachToBus(deps.bus);
  mirror.syncAll();

  const worker = startInboxWorker({ dbPath: getDbPath(), hooksDir });
  worker.on('message', (records: InboxRecord[]) => {
    handleIngestedRecords(
      {
        projects: deps.projects,
        hooksDir,
        bus: deps.bus,
        dispatcher: deps.dispatcher,
        watchEngine: deps.watchEngine,
        sequenceEngine: deps.sequenceEngine,
        messagePipe: deps.messagePipe,
        questionTracker: deps.questionTracker,
        sessionProbe: deps.sessionProbe,
      },
      records,
    );
  });
  worker.on('error', (e) => console.error('[weave] inbox worker failed:', e));
  return { mirror, stop: () => worker.terminate().then(() => undefined) };
}
