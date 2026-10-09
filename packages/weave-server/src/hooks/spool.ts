import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { frameFacts, type EventSource } from '@weavecode/harness';
import type { ProjectRow, ProjectRepository } from '../repositories/projects.js';
import type { HookEventRepository, HookEventInput } from '../repositories/hook-events.js';
import type { SessionRepository } from '../repositories/sessions.js';
import type { HookEventBus } from './bus.js';
import type { HookReport, NormalizedHookPayload } from './types.js';

/**
 * Hook 断连积压（spool）：daemon 不可达时 hook-handler.cjs 把事件落盘到项目
 * 本地 `.weave/spool.jsonl`（JSONL，一行一条 HookReport）；daemon 恢复后由
 * 客户端 flusher（detached 子进程 POST /hooks/batch）或本模块的启动 sweep 回灌。
 *
 * 文件名与格式是跨端契约：生成脚本无依赖不能 import，这些常量在
 * helpers-gen.ts 里以字面量保持同步。
 */
export const SPOOL_FILE = 'spool.jsonl';
export const SPOOL_CLAIM = 'spool.claim.jsonl';

export interface BacklogDeps {
  hookEvents: HookEventRepository;
  hookSessions?: SessionRepository;
  hookBus?: HookEventBus;
}

/**
 * 批量回灌落库：单事务 insertMany + 会话 touch 按 sessionId 去重 + 每事件
 * 一条 SSE（dashboard 边补边看）。不走 dispatcher——inject/webhook 对已经
 * 过去的事件无重放意义，回填只负责采集落库。
 */
export function ingestBacklog(
  deps: BacklogDeps,
  project: ProjectRow,
  inputs: HookEventInput[],
): void {
  const ids = deps.hookEvents.insertMany(inputs);
  const touched = new Set<string>();
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    if (deps.hookSessions && input.sessionId && !touched.has(input.sessionId)) {
      touched.add(input.sessionId);
      deps.hookSessions.touch(input.sessionId, project.id);
    }
    let payload: NormalizedHookPayload | null = null;
    try {
      payload = JSON.parse(input.payload) as NormalizedHookPayload;
    } catch {
      payload = null;
    }
    deps.hookBus?.emit({
      kind: 'event.ingested',
      eventId: ids[i]!,
      projectId: project.id,
      sessionId: input.sessionId ?? null,
      eventType: input.eventType,
      ...frameFacts(payload),
      at: new Date().toISOString(),
    });
  }
}

export interface SpoolSweepDeps extends BacklogDeps {
  projects: Pick<ProjectRepository, 'list'>;
  eventSources: readonly EventSource[];
}

/**
 * daemon 启动时扫一遍注册项目，把断连期积压的事件回灌入库并清理文件。
 * 覆盖「server 恢复但用户没触发任何 hook」的场景（客户端 flusher 只在
 * 下一条 hook 成功后才跑）。与客户端 flusher 竞争同一批文件是安全的，
 * 靠同一条认领规则：claim（rename 产物）先到先得，输家 ENOENT 空手而归。
 */
export function sweepProjectSpools(deps: SpoolSweepDeps): number {
  let total = 0;
  for (const project of deps.projects.list()) {
    total += drainProjectSpool(deps, project, join(project.path, '.weave'));
  }
  return total;
}

/**
 * 一个项目的 spool 目录：先消费残留 claim（上次 flush 崩了一半），claim
 * 清掉了才把 spool rename 成 claim 认领——rename 目标永不存在，Windows
 * 的覆盖语义也丢不了数据。rename 原子，与并发 append / 其他 flusher
 * 竞争安全（append 要么落进旧文件被本轮读到，要么落进新 spool 留给下轮）。
 */
function drainProjectSpool(deps: SpoolSweepDeps, project: ProjectRow, dir: string): number {
  const spool = join(dir, SPOOL_FILE);
  const claim = join(dir, SPOOL_CLAIM);
  let count = 0;
  if (existsSync(claim)) count += drainClaimFile(deps, project, claim);
  if (existsSync(spool) && !existsSync(claim)) {
    try {
      renameSync(spool, claim);
    } catch {
      return count;
    }
    count += drainClaimFile(deps, project, claim);
  }
  return count;
}

/** 消费一个 claim 文件：解析 → 归一化 → 单事务批量入库 → 删除。坏行跳过；
 * 入库抛错原样留在盘上等下一轮（sweep 下次启动 / 客户端 flusher 接续）。 */
function drainClaimFile(
  deps: SpoolSweepDeps,
  project: ProjectRow,
  claim: string,
): number {
  let lines: string[];
  try {
    lines = readFileSync(claim, 'utf8').split('\n');
  } catch {
    return 0;
  }
  const inputs: HookEventInput[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    let report: HookReport;
    try {
      report = JSON.parse(text) as HookReport;
    } catch {
      continue;
    }
    const adapter =
      report && typeof report === 'object'
        ? deps.eventSources.find((a) => a.source === report.source)
        : undefined;
    if (!adapter || !report.eventType) continue;
    try {
      inputs.push(adapter.normalize(report, project.id) as HookEventInput);
    } catch {
      // 单条坏报告不拖垮整批。
    }
  }
  if (inputs.length > 0) {
    try {
      ingestBacklog(deps, project, inputs);
    } catch {
      return 0;
    }
  }
  try {
    unlinkSync(claim);
  } catch {
    // Windows 上句柄还开着的极端场景：下一轮 sweep 会再删。
  }
  return inputs.length;
}
