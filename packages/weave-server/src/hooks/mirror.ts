import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HookRule } from '@weavecode/core';
import { hookSourceHarness } from '@weavecode/core';
import { getDataDir } from '../db/paths.js';
import type { ProjectRow, ProjectRepository } from '../repositories/projects.js';
import type { SessionRepository } from '../repositories/sessions.js';
import type { HookRuleRegistry } from './registry.js';
import type { HookEventBus } from './bus.js';
import { projectLabel } from './match.js';

/**
 * hook 文件化管道的 daemon 侧落点（`<dataDir>/hooks/`）：
 * - `inbox/<shard>.jsonl`  hook → daemon 事件采集（hook-handler.cjs 只追加）
 * - `mirror/<shard>.json`  daemon → hook 注入计划（本模块原子重写）
 * - `outbox/<shard>.jsonl` daemon → hook 顺延注入（消费侧追加、hook 消费即删行）
 *
 * 目录名/shard 算法/文档形是跨端契约：生成脚本无依赖不能 import，helpers-gen.ts
 * 以字面量保持同步。
 */

export const MIRROR_VERSION = 1;
export const OUTBOX_MAX_LINES = 200;

/** shard = 项目 token 的哈希前缀：纯分片键，不含语义；行内自带 token 解析项目。 */
export function hookShardId(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export function hooksRoot(dataDir: string = getDataDir()): string {
  return join(dataDir, 'hooks');
}

export function mirrorPathOf(hooksDir: string, shardId: string): string {
  return join(hooksDir, 'mirror', `${shardId}.json`);
}

export function outboxPathOf(hooksDir: string, shardId: string): string {
  return join(hooksDir, 'outbox', `${shardId}.jsonl`);
}

/** mirror 规则条目（hook 本地匹配所需的投影；数组序 = 匹配序 = priority 降序）。 */
export interface MirrorRule {
  id: string;
  name: string;
  events: string[];
  tools: string[] | null;
  globs: string[] | null;
  template: string;
}

export interface HookMirrorDoc {
  version: number;
  /** {project} 模板变量（项目根 basename，与 dispatcher 的 projectLabel 同源）。 */
  project: string;
  pendingTitles: Record<string, string>;
  rules: MirrorRule[];
}

/**
 * 项目 → hook 本地注入计划。只投影 inject 规则（manual/webhook/log/plugin 的
 * 动作都在消费侧）：harness 必须是 claude（hook-handler.cjs 只挂在 Claude Code）；
 * crossProjectOnly 需要全项目表参与判定、hook 无法本地裁决 → 不投影，其注入走
 * outbox 顺延。
 */
export function buildMirrorDoc(
  project: ProjectRow,
  rules: HookRule[],
  pendingTitles: Record<string, string>,
): HookMirrorDoc {
  const mirrored = rules
    .filter((rule) => {
      if (rule.source.kind !== 'hook-event') return false;
      if (hookSourceHarness(rule.source) !== 'claude') return false;
      if (rule.handler.type !== 'inject') return false;
      if (!rule.enabled) return false;
      if (rule.projectId !== null && rule.projectId !== project.id) return false;
      if (rule.filter.crossProjectOnly) return false;
      return true;
    })
    .sort((a, b) => b.priority - a.priority)
    .map((rule) => ({
      id: rule.id,
      name: rule.name,
      events: [rule.source.kind === 'hook-event' ? rule.source.event : ''],
      tools: rule.filter.toolNames?.length ? [...rule.filter.toolNames] : null,
      globs: rule.filter.pathGlobs?.length ? [...rule.filter.pathGlobs] : null,
      template: rule.handler.type === 'inject' ? rule.handler.template : '',
    }));
  return { version: MIRROR_VERSION, project: projectLabel(project.path), pendingTitles, rules: mirrored };
}

export interface MirrorWriterDeps {
  /** 覆盖 dataDir（测试注入）；缺省 getDataDir()。 */
  dataDir?: string;
  projects: Pick<ProjectRepository, 'list' | 'getById'>;
  rules: Pick<HookRuleRegistry, 'list'>;
  sessions: Pick<SessionRepository, 'list' | 'getBySessionId'>;
}

/**
 * 把注入计划镜像到 `<dataDir>/hooks/mirror/<shard>.json`（tmp + rename 原子换）。
 * 同步点：规则变更（registry.onChange → syncAll）、会话标题变更（bus
 * session.renamed / PATCH rename → syncProject）。写失败吞掉——mirror 缺失只损失
 * 注入，采集不受影响（hook 对缺失/坏 mirror 按空计划处理）。
 */
export class MirrorWriter {
  private readonly dataDir: string;

  constructor(private readonly deps: MirrorWriterDeps) {
    this.dataDir = deps.dataDir ?? getDataDir();
  }

  syncAll(): void {
    // list() 只含活跃项目——归档项目的镜像不重写（归档时已焚毁）。
    for (const project of this.deps.projects.list()) {
      this.syncProject(project.id);
    }
  }

  syncProject(projectId: number): void {
    const project = this.deps.projects.getById(projectId);
    if (!project || project.archivedAt) return; // 归档项目不喂镜像（文件已随归档焚毁）
    const pendingTitles: Record<string, string> = {};
    for (const session of this.deps.sessions.list(projectId)) {
      if (session.pendingTitle) pendingTitles[session.sessionId] = session.pendingTitle;
    }
    this.write(project.token, buildMirrorDoc(project, this.deps.rules.list(), pendingTitles));
  }

  write(token: string, doc: HookMirrorDoc): void {
    try {
      const target = mirrorPathOf(hooksRoot(this.dataDir), hookShardId(token));
      mkdirSync(join(hooksRoot(this.dataDir), 'mirror'), { recursive: true });
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, JSON.stringify(doc));
      renameSync(tmp, target);
    } catch {
      // mirror 写失败 = 注入降级，采集不受影响
    }
  }

  /** bus 订阅：session.renamed（改名挂起/采纳/交付落定）→ 该会话所属项目的 mirror 重同步。 */
  attachToBus(bus: Pick<HookEventBus, 'subscribe'>): void {
    bus.subscribe((message) => {
      if (message.kind !== 'session.renamed' || !message.sessionId) return;
      const session = this.deps.sessions.getBySessionId(message.sessionId);
      if (session?.projectId != null) this.syncProject(session.projectId);
    });
  }
}

export interface OutboxEntry {
  sessionId: string;
  text: string;
}

/**
 * inbox 追加（daemon 侧）：旧版 hook-handler 的 POST /hooks 兼容口把报告转投
 * 这里，与新版 hook 走同一条采集管道。行形 `{v, token, report}` 是跨端契约。
 */
export function appendInbox(hooksDir: string, token: string, report: unknown): void {
  const dir = join(hooksDir, 'inbox');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${hookShardId(token)}.jsonl`),
    JSON.stringify({ v: 1, token, report }) + '\n',
    { flag: 'a' },
  );
}

/**
 * 顺延注入追加（消费侧：dispatcher 产出的 plugin / 未镜像规则注入，交给同一
 * 会话的下一次 hook 事件带进会话）。有界：超过行上限丢最旧。
 */
export function appendOutbox(hooksDir: string, token: string, entries: OutboxEntry[]): void {
  if (entries.length === 0) return;
  try {
    const file = outboxPathOf(hooksDir, hookShardId(token));
    mkdirSync(join(hooksDir, 'outbox'), { recursive: true });
    let kept: string[] = [];
    try {
      kept = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    } catch {
      kept = [];
    }
    for (const entry of entries) {
      kept.push(JSON.stringify({ ...entry, at: new Date().toISOString() }));
    }
    const bounded = kept.slice(-OUTBOX_MAX_LINES);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, bounded.length ? bounded.join('\n') + '\n' : '');
    renameSync(tmp, file);
  } catch {
    // outbox 写失败只损失一次顺延注入
  }
}
