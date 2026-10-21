import type { Harness } from '@weavecode/core';
import type { MessagingSurface } from '@weavecode/harness';
import type { ProjectRepository } from '../repositories/projects.js';
import type { SessionRepository } from '../repositories/sessions.js';
import type { HeadlessRunner } from './headless-runner.js';
import { isSyntheticSession, registerSyntheticSession, syntheticSessionIds } from './synthetic-sessions.js';

/**
 * 编排边级提取（`edge.extract`）的装配实现：对上游会话 fork 一个无头回合
 * （`ResumeCommandSpec.extractArgs` 键形），继承会话上下文提炼信息，不动原会话、
 * 不留转录。fork 的 hook 事件由合成会话名单在 ingest 侧过滤（见
 * `synthetic-sessions.ts`）。不支持 fork 的 harness（extractArgs 缺席，codex）
 * 返回 null，调用方回落只读上游输出。
 */

export interface EdgeExtractDeps {
  sessions: Pick<SessionRepository, 'getBySessionId'>;
  projects: Pick<ProjectRepository, 'getById'>;
  /** harness 归属 = 最新采集事件 source（MessageDeliverer.surfaceOfSession 同口径）。 */
  harnessOf(sessionId: string): Harness | null;
  surfaceFor(harness: Harness): MessagingSurface;
  headless: HeadlessRunner;
  /** 合成名单变化时全量推给 inbox 消费线程。 */
  onSyntheticChange(): void;
  /** 同时在跑的提取上限（对齐 plugin 槽 4）；满了立即 null（回落上游输出）。 */
  concurrency?: number;
  timeoutMs?: number;
}

export interface EdgeExtract {
  supports(sessionId: string): boolean;
  run(input: { sessionId: string; prompt: string }): Promise<string | null>;
}

const MAX_OUTPUT_CHARS = 8_000;

export function createEdgeExtract(deps: EdgeExtractDeps): EdgeExtract {
  const max = deps.concurrency ?? 4;
  let active = 0;

  return {
    supports(sessionId: string): boolean {
      const harness = deps.harnessOf(sessionId);
      if (!harness) return false;
      return deps.surfaceFor(harness).headless?.extractArgs != null;
    },

    run({ sessionId, prompt }): Promise<string | null> {
      if (active >= max) return Promise.resolve(null);
      const harness = deps.harnessOf(sessionId);
      const session = deps.sessions.getBySessionId(sessionId);
      if (!harness || !session?.projectId) return Promise.resolve(null);
      const project = deps.projects.getById(session.projectId);
      const spec = deps.surfaceFor(harness).headless;
      const bin = process.env.WEAVE_CLAUDE_BIN ?? spec?.bin;
      if (!project || !spec?.extractArgs || !bin) return Promise.resolve(null);

      // fork 会话 id 自己生成并先登记：ingest 收到它的 SessionStart 前名单已就位。
      const forkSessionId = registerSyntheticSession();
      deps.onSyntheticChange();
      active++;
      return new Promise<string | null>((resolve) => {
        let settled = false;
        const done = (value: string | null): void => {
          if (settled) return;
          settled = true;
          active--;
          resolve(value);
        };
        const started = deps.headless.run({
          sessionId: forkSessionId,
          cwd: project.path,
          prompt,
          spec,
          bin,
          argsOf: (id) => spec.extractArgs!(sessionId, id),
          timeoutMs: deps.timeoutMs ?? 120_000,
          onSettle: (result) => {
            done(
              result.status === 'succeeded' && result.output?.trim()
                ? result.output.trim().slice(0, MAX_OUTPUT_CHARS)
                : null,
            );
          },
        });
        if (!started) done(null);
      });
    },
  };
}

/** 测试/诊断辅助：当前名单（含刚登记未推送的）。 */
export { isSyntheticSession, syntheticSessionIds };
