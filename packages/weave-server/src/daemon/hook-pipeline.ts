import { getDbPath } from '../db/paths.js';
import type { HookEventBus } from '../hooks/bus.js';
import type { HookDispatcher } from '../hooks/dispatcher.js';
import { MirrorWriter, hooksRoot } from '../hooks/mirror.js';
import {
  startInboxWorker,
  handleIngestedRecords,
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
  const mirror = new MirrorWriter({
    projects: deps.projects,
    rules: deps.rules,
    sessions: deps.sessions,
  });
  deps.rules.onChange = () => mirror.syncAll();
  mirror.attachToBus(deps.bus);
  mirror.syncAll();

  const hooksDir = hooksRoot();
  const worker = startInboxWorker({ dbPath: getDbPath(), hooksDir });
  worker.on('message', (records: InboxRecord[]) => {
    handleIngestedRecords(
      { projects: deps.projects, hooksDir, bus: deps.bus, dispatcher: deps.dispatcher },
      records,
    );
  });
  worker.on('error', (e) => console.error('[weave] inbox worker failed:', e));
  return { mirror, stop: () => worker.terminate().then(() => undefined) };
}
