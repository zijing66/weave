import type { Harness } from '@weavecode/core';
import type { MemorySinkSurface } from '@weavecode/harness';
import type { ProjectRepository } from '../repositories/projects.js';
import { readInitRuntime } from '../install/init-files.js';

/**
 * 编排记忆出口（批 3，2026-11-12）的写盘面：判决落进**目标项目自己的记忆
 * 文件**——编排行挂哪个 projectId 就写那个项目（用户裁决：每项目各一份，
 * 跟 coordinator 仓零关系；superagent 仓那张只是出厂示例编排）。
 * 写哪个文件归 harness 能力面（claude = CLAUDE.local.md、codex = AGENTS.md），
 * server 只按项目接入清单（`.weave/config.yaml` 的 harnesses）逐面分发；
 * 接入清单读不到 = 该项目没 init 过，没有能读到记忆文件的会话在，如实不写。
 */

export interface MemoryExitResult {
  ok: boolean;
  /** 落盘的文件清单（多 harness 接入的项目各写各的）。 */
  files: string[];
  /** 部分失败 / 不写的原因（落 run 事件的 detail）。 */
  error?: string;
}

export interface MemoryExit {
  deliverVerdict(input: { projectId: number; text: string }): Promise<MemoryExitResult>;
}

export function createMemoryExit(deps: {
  projects: Pick<ProjectRepository, 'getById'>;
  /** 按 harness 取记忆文件面（装配侧 = surfaces.ts 的 registry 访问器；null = 无此面）。 */
  sinkFor(harness: Harness): MemorySinkSurface | null;
}): MemoryExit {
  return {
    async deliverVerdict({ projectId, text }) {
      const project = deps.projects.getById(projectId);
      if (!project) return { ok: false, files: [], error: 'project not found' };
      const { harnesses } = await readInitRuntime(project.path);
      if (harnesses.length === 0) {
        return { ok: false, files: [], error: 'project has no harnesses configured (.weave/config.yaml)' };
      }
      const files: string[] = [];
      const errors: string[] = [];
      for (const harness of harnesses) {
        const sink = deps.sinkFor(harness);
        if (!sink) {
          errors.push(`${harness}: no memory sink face`);
          continue;
        }
        const result = await sink.appendVerdict({ projectPath: project.path, text });
        if (result.ok) files.push(result.file);
        else errors.push(`${harness}: ${result.error}`);
      }
      if (files.length === 0) return { ok: false, files: [], error: errors.join('; ') };
      return { ok: true, files, ...(errors.length > 0 ? { error: errors.join('; ') } : {}) };
    },
  };
}
