import type { BackupEngine } from './backup.js';

/**
 * 每日自动备份调度：到点（settings `backup.hour`，0-23）触发一轮 + daemon
 * 启动后「今天这一档还没跑」就补跑（重启跨过 1 点也不丢当天的包）。节拍
 * 60s 一看（与 cron/(goal) 引擎同族），触发判据 = 本地日期变了或启动首拍。
 * unref：不吊住 daemon 退出。
 */

/** 已触发的本地日期（YYYY-MM-DD）；null = 本进程还没跑过。 */
let lastFiredDate: string | null = null;

function localDateOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 该不该这一拍触发：到点了（hour 且今天没跑过）或启动后补当天档。 */
export function shouldFireBackup(
  now: Date,
  hour: number,
  hasBackupToday: boolean,
): boolean {
  const today = localDateOf(now);
  if (lastFiredDate === today) return false;
  if (now.getHours() >= hour && !hasBackupToday) return true;
  return false;
}

/** 测试与重启场景重置「本进程已触发」记忆。 */
export function resetBackupScheduleForTest(): void {
  lastFiredDate = null;
}

/** 记一笔触发（调度器在真跑时调用）。 */
export function markBackupFired(now: Date): void {
  lastFiredDate = localDateOf(now);
}

export interface BackupSchedulerDeps {
  engine: BackupEngine;
  /** 当前备份设置（每次 tick 现读——改小时即时生效）。 */
  config: () => { enabled: boolean; hour: number; includeHistory: boolean };
  /** 今天有没有包（`data/backups/` 里看时刻戳）。 */
  hasBackupToday: () => Promise<boolean>;
  now?: () => Date;
}

export function startBackupScheduler(deps: BackupSchedulerDeps): NodeJS.Timeout {
  const now = deps.now ?? (() => new Date());
  const tick = async (): Promise<void> => {
    const cfg = deps.config();
    if (!cfg.enabled) return;
    if (!shouldFireBackup(now(), cfg.hour, await deps.hasBackupToday())) return;
    markBackupFired(now());
    await deps.engine.run(cfg.includeHistory);
  };
  void tick(); // 启动首拍：跨过时刻的补跑
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  return timer;
}
