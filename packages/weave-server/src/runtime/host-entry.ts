import { RuntimeHostServer } from './host-server.js';

/**
 * Runtime Host 独立入口（agent-runtime-host-design.md §1.3）：由 daemon 经
 * `spawnOutsideJob`（WMI 断 Job 链）拉起，dataDir 经 `WEAVE_DATA_DIR` 传入。
 * dist 形直接跑本文件的 js；源码态由 daemon 以 `node --import tsx <本文件>` 起。
 */

async function main(): Promise<void> {
  // argv[2] 优先（WMI spawn 不继承调用方 env，只能走命令行）；env 兜底回落分支
  const dataDir = process.argv[2] ?? process.env.WEAVE_DATA_DIR;
  if (!dataDir) {
    console.error('[weave-runtime] dataDir is required (argv[2] or WEAVE_DATA_DIR)');
    process.exit(2);
  }
  const server = new RuntimeHostServer(dataDir);
  await server.start();
  const stop = (signal: string) => {
    console.log(`[weave-runtime] ${signal} — shutting down`);
    void server.shutdown(process.exit);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

void main().catch((err) => {
  console.error('[weave-runtime] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
