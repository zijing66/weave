import type { Harness } from '@weavecode/core';
import type { MessagingSurface } from '@weavecode/harness';
import type { ProjectRepository } from '../repositories/projects.js';
import type { SessionRepository } from '../repositories/sessions.js';
import type { HeadlessRunner } from './headless-runner.js';
import { isSyntheticSession, registerSyntheticSession, syntheticSessionIds } from './synthetic-sessions.js';

/**
 * 编排边级提取（`edge.extract` / 判提合一的组合 fork prompt）的装配实现：对上游
 * 会话 fork 一个无头回合，继承会话上下文提炼信息，不动原会话、不留转录。两条通道
 * 按能力面分流：claude = `ResumeCommandSpec.extractArgs` 键形（headless runner
 * spawn CLI）；codex = MessagingSurface.forkExtract（app-server `thread/fork`
 * RPC，ephemeral fork 跑一轮收通知流）。fork 的 hook 事件由合成会话名单在 ingest
 * 侧过滤（见 `synthetic-sessions.ts`）——codex 的 fork id 宿主分配，在回合开跑前
 * 经 `onForkId` 回调登记。都不支持的 harness 返回 null，调用方回落只读上游输出。
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

/** 提炼产出的上限：与判断证据、边正文同账（2026-11-12 三本账统一 32k，原 8000 退役）。 */
const MAX_OUTPUT_CHARS = 32_000;

export function createEdgeExtract(deps: EdgeExtractDeps): EdgeExtract {
  const max = deps.concurrency ?? 4;
  let active = 0;

  return {
    supports(sessionId: string): boolean {
      const harness = deps.harnessOf(sessionId);
      if (!harness) return false;
      const surface = deps.surfaceFor(harness);
      return surface.headless?.extractArgs != null || surface.forkExtract != null;
    },

    run({ sessionId, prompt }): Promise<string | null> {
      if (active >= max) return Promise.resolve(null);
      const harness = deps.harnessOf(sessionId);
      const session = deps.sessions.getBySessionId(sessionId);
      if (!harness || !session?.projectId) return Promise.resolve(null);
      const surface = deps.surfaceFor(harness);
      const spec = surface.headless;
      const bin = process.env.WEAVE_CLAUDE_BIN ?? spec?.bin;
      // 通道按能力面分流：app-server fork 面（codex）不经 headless runner——
      // 它不拼命令行，fork id 由宿主分配（onForkId 回调先登记合成会话）。
      const forkExtract = surface.forkExtract ?? null;
      if (!forkExtract && (!spec?.extractArgs || !bin)) return Promise.resolve(null);
      const project = deps.projects.getById(session.projectId);
      if (!project) return Promise.resolve(null);

      active++;
      const done = (resolve: (value: string | null) => void): ((value: string | null) => void) => {
        let settled = false;
        return (value) => {
          if (settled) return;
          settled = true;
          active--;
          resolve(
            value && value.trim() ? value.trim().slice(0, MAX_OUTPUT_CHARS) : null,
          );
        };
      };
      if (forkExtract) {
        return new Promise<string | null>((resolve) => {
          const settle = done(resolve);
          forkExtract
            .run({
              sessionId,
              prompt,
              timeoutMs: deps.timeoutMs ?? 120_000,
              onForkId: (id) => {
                registerSyntheticSession(id);
                deps.onSyntheticChange();
              },
            })
            .then(settle, () => settle(null));
        });
      }
      // fork 会话 id 自己生成并先登记：ingest 收到它的 SessionStart 前名单已就位。
      const forkSessionId = registerSyntheticSession();
      deps.onSyntheticChange();
      return new Promise<string | null>((resolve) => {
        const settle = done(resolve);
        const started = deps.headless.run({
          sessionId: forkSessionId,
          cwd: project.path,
          prompt,
          spec: spec!,
          bin: bin!,
          argsOf: (id) => spec!.extractArgs!(sessionId, id),
          timeoutMs: deps.timeoutMs ?? 120_000,
          onSettle: (result) => {
            settle(result.status === 'succeeded' ? result.output : null);
          },
        });
        if (!started) settle(null);
      });
    },
  };
}

/** 测试/诊断辅助：当前名单（含刚登记未推送的）。 */
export { isSyntheticSession, syntheticSessionIds };
