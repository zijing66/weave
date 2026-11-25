import { mkdir, readdir, copyFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectRow } from '../repositories/projects.js';
import { projectKey } from '../repositories/projects.js';

/**
 * 项目迁移引擎（复制语义）：目标目录整树复制成功后 DB 才切 path——任何失败/
 * 取消都清理半成品、项目行原样，复制永远可退。旧目录保留（是否删除由用户在
 * 完成后的确认弹窗里定）。token 与 hook 管道按 token 分片、与路径无关，零改动。
 *
 * 形态仿 BackupEngine：running + progress + lastError，前端 1s 轮询；
 * 可退出三层 = cancel API / 轮询失败散屏 / 前端进度看门狗。
 */

export interface MoveProgress {
  phase: 'measure' | 'copy' | 'finalize';
  ratio: number;
  etaSeconds: number | null;
}

export interface MoveStatus {
  running: boolean;
  projectId: number | null;
  projectName: string | null;
  fromPath: string | null;
  toPath: string | null;
  progress: MoveProgress | null;
  /** 'cancelled' = 用户取消；其余为错误文案。 */
  lastError: string | null;
  /** 本次迁移成功落定（前端据此散屏并弹旧目录清理确认）。 */
  done: boolean;
  /** 迁移后的自动 `weave init` 失败原因（迁移本身已成功）。 */
  initError: string | null;
}

export interface MoveDeps {
  projects: { list(): ProjectRow[] };
  /** 仓储写入口（迁移落定的唯一 DB 写）。 */
  setPath: (id: number, newPath: string) => ProjectRow | undefined;
  /** setPath 成功后重建 watcher 与推送 projects 帧（可选，测试不注入）。 */
  reconcile?: () => void;
  emitProjects?: () => void;
  /** finalize 后自动 init（spawn CLI 子进程）；缺省跳过。 */
  runInit?: (projectPath: string) => Promise<void>;
}

/** 目标校验失败（路由直接 400，不起引擎）。 */
export class MoveValidationError extends Error {}

/** 每复制多少文件让出一拍事件循环（轮询路由不被饿死）。 */
const YIELD_EVERY = 16;

export class MoveEngine {
  private current: MoveStatus = {
    running: false,
    projectId: null,
    projectName: null,
    fromPath: null,
    toPath: null,
    progress: null,
    lastError: null,
    done: false,
    initError: null,
  };
  private cancelRequested = false;

  constructor(private readonly deps: MoveDeps) {}

  get status(): MoveStatus {
    return { ...this.current };
  }

  requestCancel(): void {
    this.cancelRequested = true;
  }

  /**
   * 跑一轮迁移。validate 失败抛 `MoveValidationError`（路由转 400，status 不进
   * running）；启动后的失败/取消进 `lastError`，前端轮询看到。
   */
  async run(project: ProjectRow, targetPath: string): Promise<void> {
    if (this.current.running) return;
    const from = projectKey(project.path);
    const to = projectKey(targetPath);
    this.validate(from, to);
    // cancelRequested 不在起跑时复位：起跑前那记取消要生效到复制循环里；
    // 复位在 run 收尾（落定/失败/取消后）。
    this.current = {
      running: true,
      projectId: project.id,
      projectName: project.name,
      fromPath: from,
      toPath: to,
      progress: null,
      lastError: null,
      done: false,
      initError: null,
    };
    // 取消/失败清理的判据（try 外声明：外层 catch 也要用）
    let createdTarget = false;
    let sourceTop: string[] = [];
    try {
      // 目标不存在 = 由我们创建（取消/失败可整删）；已存在空目录 = 只清本次
      // 复制进去的顶层条目，目录本身原样归还。
      try {
        const st = await stat(to);
        if (!st.isDirectory()) {
          throw new MoveValidationError(`Target exists and is not a directory: ${to}`);
        }
        if ((await readdir(to)).length > 0) {
          throw new MoveValidationError(`Target directory is not empty: ${to}`);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') createdTarget = true;
        else if (e instanceof MoveValidationError) throw e;
        else throw new MoveValidationError(`Target not accessible: ${to}`);
      }
      await mkdir(to, { recursive: true });

      // 顶层清单：createdTarget=false 的清理只删这些条目（不碰目录里既有的东西）
      sourceTop = await readdir(from);

      const totalBytes = await this.measure(from);
      const est = new RateEstimator();
      est.planTotal(totalBytes);
      const report = (phase: MoveProgress['phase']): void => {
        this.current.progress = { phase, ratio: est.ratio(), etaSeconds: est.etaSeconds() };
      };
      report('measure');

      let copied = 0;
      let files = 0;
      await this.copyTree(from, to, async (bytes) => {
        if (this.cancelRequested) throw new MoveCancelled();
        copied += bytes;
        files++;
        est.add(copied);
        if (files % YIELD_EVERY === 0) {
          report('copy');
          await yieldNow();
        }
      });
      report('copy');
      await yieldNow();

      // 复制全成功才碰 DB；失败/取消的清理都不带 DB
      this.current.progress = { phase: 'finalize', ratio: 0.99, etaSeconds: 0 };
      try {
        if (!this.deps.setPath(project.id, to)) {
          throw new Error('Project row disappeared during move');
        }
      } catch (e) {
        await this.cleanup(to, createdTarget, sourceTop);
        throw e;
      }
      this.deps.reconcile?.();
      this.deps.emitProjects?.();
      this.current.done = true;
      this.current.running = false;
      this.current.progress = null;

      // 自动 init（信任预写/codex trust 按新路径重建）：失败不回滚迁移，
      // 只如实记 initError——迁移成功态已落定。
      if (this.deps.runInit) {
        try {
          await this.deps.runInit(to);
        } catch (e) {
          this.current.initError = e instanceof Error ? e.message : String(e);
        }
      }
    } catch (e) {
      this.current.running = false;
      this.current.progress = null;
      this.cancelRequested = false;
      if (e instanceof MoveCancelled) {
        this.current.lastError = 'cancelled';
      } else if (e instanceof MoveValidationError) {
        throw e; // 调用方（路由）当场 400
      } else {
        this.current.lastError = e instanceof Error ? e.message : String(e);
      }
      if (!(e instanceof MoveValidationError)) {
        // 取消与复制失败的半成品清理（validate 失败根本没起复制，不用清）
        await this.cleanup(to, createdTarget, sourceTop);
      }
    }
  }

  private validate(from: string, to: string): void {
    if (from === to) throw new MoveValidationError('Target equals the current project path');
    const nested = (a: string, b: string): boolean => {
      const rel = path.relative(a, b);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    };
    if (nested(from, to) || nested(to, from)) {
      throw new MoveValidationError(
        'Target must not be inside or contain the current project directory',
      );
    }
    for (const p of this.deps.projects.list()) {
      const other = projectKey(p.path);
      if (other === to) {
        throw new MoveValidationError(`Target is already a registered project: ${p.name}`);
      }
      if (nested(other, to) || nested(to, other)) {
        throw new MoveValidationError(`Target overlaps registered project "${p.name}" (${p.path})`);
      }
    }
  }

  private async measure(dir: string): Promise<number> {
    let total = 0;
    const walk = async (d: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile()) {
          try {
            total += (await stat(abs)).size;
          } catch {
            // 读不到的按 0 计
          }
        }
      }
      await yieldNow();
    };
    await walk(dir);
    return total;
  }

  private async copyTree(
    from: string,
    to: string,
    onFile: (bytes: number) => Promise<void>,
  ): Promise<void> {
    await mkdir(to, { recursive: true });
    const entries = await readdir(from, { withFileTypes: true });
    for (const e of entries) {
      const src = path.join(from, e.name);
      const dst = path.join(to, e.name);
      if (e.isDirectory()) {
        await this.copyTree(src, dst, onFile);
      } else if (e.isFile()) {
        await copyFile(src, dst);
        let size = 0;
        try {
          size = (await stat(src)).size;
        } catch {
          // stat 不到按 0 计（进度少一点无妨）
        }
        await onFile(size);
      }
    }
  }

  /** 取消/失败的半成品清理：整建目录整删；借用空目录只清本次顶层条目。 */
  private async cleanup(
    to: string,
    createdTarget: boolean,
    sourceTop: readonly string[],
  ): Promise<void> {
    try {
      if (createdTarget) {
        await rm(to, { recursive: true, force: true });
      } else {
        for (const name of sourceTop) {
          await rm(path.join(to, name), { recursive: true, force: true });
        }
      }
    } catch {
      // 清理失败不掩盖主错误
    }
  }
}

/** 取消信号（内部控制流，不外泄）。 */
class MoveCancelled extends Error {}

/** 让出一拍事件循环。 */
function yieldNow(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 速率采样（与 backup.ts 的 ProgressEstimator 同形：20 点滑窗估 ETA）。 */
class RateEstimator {
  private totalBytes = 1;
  private doneBytes = 0;
  private readonly samples: Array<{ at: number; done: number }> = [];

  planTotal(bytes: number): void {
    this.totalBytes = Math.max(1, bytes);
  }

  add(done: number): void {
    this.doneBytes = done;
    const now = Date.now();
    this.samples.push({ at: now, done });
    if (this.samples.length > 20) this.samples.shift();
  }

  ratio(): number {
    return Math.min(0.99, this.doneBytes / this.totalBytes);
  }

  etaSeconds(): number | null {
    if (this.samples.length < 2) return null;
    const first = this.samples[0]!;
    const rate = (this.doneBytes - first.done) / Math.max(1, Date.now() - first.at);
    return rate > 0 ? Math.round((this.totalBytes - this.doneBytes) / rate / 1000) : null;
  }
}
