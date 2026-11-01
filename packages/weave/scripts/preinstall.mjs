/**
 * 全局安装/升级前的尽力停机：旧 daemon 还跑着时，新版本一启动就会和它抢同一个
 * 库（WAL 写锁、迁移 DDL），升级期最容易出岔子的就是这一段。
 *
 * 停不掉也继续装——安装失败比留着一个旧进程更糟，所以这里吞掉所有错误、恒
 * exit 0。Windows 上没有 SIGTERM 语义，process.kill 就是强制终止；daemon 的
 * 优雅收尾（WAL checkpoint）由它自己的 shutdown 负责，这里只保证它先退场。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

function configDir() {
  if (process.platform === 'win32') {
    return process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config');
}

/** daemon 状态文件：0.1.7 起在 `cache/` 下，更早的版本放在数据目录根部。 */
function readDaemonState() {
  const root = path.join(configDir(), 'weave');
  for (const candidate of [path.join(root, 'cache', 'daemon.json'), path.join(root, 'daemon.json')]) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* 坏文件/读不到：当作没有 daemon */
    }
  }
  return null;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程在但没权限：仍算活着（不去碰它）
    return e && e.code !== 'ESRCH';
  }
}

// 只在**全局安装**时动手：workspace 里跑 `pnpm install` 会连开发者本机的
// daemon 一起杀掉，那是灾难。npm 分别在两者上设这个环境变量。
if (process.env.npm_config_global !== 'true') process.exit(0);

const state = readDaemonState();
const pid = state && typeof state.pid === 'number' ? state.pid : null;
if (!pid || pid <= 0 || !pidAlive(pid)) process.exit(0);

try {
  process.kill(pid);
} catch {
  process.exit(0); // 没权限/已经退了：都不该挡住安装
}

// 等它真退：shutdown 链（inbox worker 的 DB 连接、WAL 锁释放）在 kill 之后还在收尾，
// 立刻返回会让紧跟的新进程撞上垂死锁。5s 上限，超时也继续装。
const deadline = Date.now() + 5_000;
const timer = setInterval(() => {
  if (!pidAlive(pid) || Date.now() > deadline) {
    clearInterval(timer);
    process.exit(0);
  }
}, 100);
