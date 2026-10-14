import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { statuslineCacheDir } from './generator.js';

/** 清扫周期：缓存是 KB 级小文件，10 分钟一轮足够跟上会话消亡。 */
export const SWEEP_INTERVAL_MS = 10 * 60_000;
/** 会话缓存多久没被写过算陈旧（会话早已结束，增量扫描状态没意义了）。 */
export const FILE_STALE_MS = 24 * 60 * 60_000;
/** 写盘用了 tmp+rename：进程半途死掉会留下它，超过这个时长即回收。 */
export const TMP_STALE_MS = 60 * 60_000;
/** 旧版 helper 写在系统临时目录的两族缓存（渲染迁移期的存量）。 */
const LEGACY_PREFIXES = ['weave-sl-', 'weave-slc-'];
/** 旧 helper 可能仍在写它们，只回收一小时没动过的（周期跑 = 自愈）。 */
export const LEGACY_STALE_MS = 60 * 60_000;

interface CacheFile {
  git?: Record<string, { expires?: number } | undefined>;
  tokens?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * statusline 渲染缓存的回收器（daemon 侧）。
 *
 * 缓存由每次渲染的短命 helper 进程写进 `<dataDir>/statusline/<session>.json`
 * ——没有常驻进程知道它们何时作废，所以由 daemon 定期扫：清过期条目、删陈旧
 * 文件与写盘孤儿，并回收旧版散在系统临时目录里的存量。与终端角标刷新器不同，
 * 这是纯自清理、不推任何帧，故不受「有没有人看」约束。
 */
export class StatuslineCacheSweeper {
  constructor(
    private readonly dir: string = statuslineCacheDir(),
    private readonly tmpDir: string = os.tmpdir(),
    private readonly now: () => number = Date.now,
  ) {}

  /** 清一轮，返回删掉的文件数（幂等，可反复调用）。 */
  sweep(): number {
    return this.sweepCacheDir() + this.sweepLegacyTmp();
  }

  private sweepCacheDir(): number {
    if (!existsSync(this.dir)) return 0;
    const now = this.now();
    let removed = 0;
    for (const name of safeReaddir(this.dir)) {
      const file = path.join(this.dir, name);
      if (name.endsWith('.tmp')) {
        if (isStale(file, now, TMP_STALE_MS)) {
          rm(file);
          removed++;
        }
        continue;
      }
      if (!name.endsWith('.json')) continue;
      if (isStale(file, now, FILE_STALE_MS)) {
        rm(file);
        removed++;
        continue;
      }
      let data: CacheFile;
      try {
        data = JSON.parse(readFileSync(file, 'utf8')) as CacheFile;
      } catch {
        rm(file);
        removed++;
        continue;
      }
      const git = data.git ?? {};
      const tokens = data.tokens ?? {};
      let pruned = false;
      for (const [key, entry] of Object.entries(git)) {
        // 过期的 git 段（TTL 只有几秒到一小时）：留着只会让下次渲染拿到旧值
        if (!entry || typeof entry.expires !== 'number' || entry.expires < now) {
          delete git[key];
          pruned = true;
        }
      }
      for (const transcript of Object.keys(tokens)) {
        // 转录没了、或一天没动：增量状态作废，下次渲染重扫一遍即可
        if (!this.transcriptLive(transcript, now)) {
          delete tokens[transcript];
          pruned = true;
        }
      }
      if (Object.keys(git).length === 0 && Object.keys(tokens).length === 0) {
        rm(file);
        removed++;
        continue;
      }
      if (pruned) {
        try {
          writeFileSync(file, JSON.stringify({ ...data, git, tokens }));
        } catch {
          /* 下次再扫 */
        }
      }
    }
    return removed;
  }

  private transcriptLive(transcript: string, now: number): boolean {
    try {
      return now - statSync(transcript).mtimeMs <= FILE_STALE_MS;
    } catch {
      return false;
    }
  }

  /** 迁移期存量：旧版 helper 写在 `os.tmpdir()` 的 `weave-sl*-<hash>.json`。 */
  private sweepLegacyTmp(): number {
    const now = this.now();
    let removed = 0;
    for (const name of safeReaddir(this.tmpDir)) {
      if (!name.endsWith('.json') || !LEGACY_PREFIXES.some((p) => name.startsWith(p))) continue;
      const file = path.join(this.tmpDir, name);
      if (isStale(file, now, LEGACY_STALE_MS)) {
        rm(file);
        removed++;
      }
    }
    return removed;
  }

  /**
   * 起定时器。同 SessionSweeper：启动即扫一轮（dev 下 tsx watch 重启周期常短于
   * 间隔，只靠间隔的清扫器赶不上第一拍），unref 不吊住 daemon 退出。
   */
  start(): NodeJS.Timeout {
    this.sweep();
    const timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    timer.unref();
    return timer;
  }
}

/** 两个 daemon 入口（start.ts / dev-entry.ts）共用的装配点——防入口漂移。 */
export function startStatuslineCacheSweeper(): NodeJS.Timeout {
  return new StatuslineCacheSweeper().start();
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isStale(file: string, now: number, staleMs: number): boolean {
  try {
    return now - statSync(file).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

function rm(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    /* 已不在：无所谓 */
  }
}
