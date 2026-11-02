/**
 * 全局安装/升级前的尽力停机：旧 daemon 还跑着时，新版本一启动就会和它抢同一个
 * 库（WAL 写锁、迁移 DDL），升级期最容易出岔子的就是这一段。
 *
 * 优先走优雅路径——`POST /daemon/shutdown` 让 daemon 自己停子进程、把 WAL 并回
 * 主库再退；请求不通或它不肯退，才退回 process.kill（Windows 上就是强杀，WAL
 * 仍能靠回放恢复，只是留下孤儿 -wal）。
 *
 * 停不掉也继续装——安装失败比留着一个旧进程更糟，所以这里吞掉所有错误、恒
 * exit 0。
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

function readJson(file) {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null; // 坏文件/读不到：当作没有
  }
}

/** daemon 状态文件：0.1.7 起在 `cache/` 下，更早的版本放在数据目录根部。 */
function readDaemonState(root) {
  for (const candidate of [path.join(root, 'cache', 'daemon.json'), path.join(root, 'daemon.json')]) {
    const state = readJson(candidate);
    if (state) return state;
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

async function waitExit(pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !pidAlive(pid);
}

/** 请 daemon 自己退：本机回环 + 本机令牌（认证门与 dashboard 同一套）。 */
async function requestShutdown(port, token) {
  if (!port || !token) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/daemon/shutdown`, {
      method: 'POST',
      headers: { 'x-weave-local': token },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// 只在**全局安装**时动手：workspace 里跑 `pnpm install` 会连开发者本机的
// daemon 一起杀掉，那是灾难。npm 分别在两者上设这个环境变量。
if (process.env.npm_config_global !== 'true') process.exit(0);

const root = path.join(configDir(), 'weave');
const state = readDaemonState(root);
const pid = state && typeof state.pid === 'number' ? state.pid : null;
if (!pid || pid <= 0 || !pidAlive(pid)) process.exit(0);

const auth = readJson(path.join(root, 'local', 'auth.json'));
const token = auth && typeof auth.localToken === 'string' ? auth.localToken : null;

// 优雅路径：端点回 200 就等它自己收尾（shutdown 链最多 3s 兜底）
if (await requestShutdown(state.port, token)) {
  await waitExit(pid, 6_000);
  process.exit(0);
}

// 兜底：端点不通（旧版本 daemon / 端口变了）——直接终止进程
try {
  process.kill(pid);
} catch {
  process.exit(0); // 没权限/已经退了：都不该挡住安装
}
await waitExit(pid, 5_000);
process.exit(0);
