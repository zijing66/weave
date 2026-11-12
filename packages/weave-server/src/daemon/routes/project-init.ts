import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WeaveServerDeps } from '../server.js';
import { sendJson } from '../http.js';
import { readInitRuntime } from '../../install/init-files.js';

/**
 * POST /projects/:id/init — dashboard 触发 `weave init`（用户裁决按路径 B：
 * 子进程跑 CLI，与用户终端里那条命令同一层——信任预写、指令文件合并、
 * git rerere 全保真）。
 *
 * **为什么 spawn 不进程内 import**：CLI 的失败路径走 `process.exit(1)`，
 * 进程内调用会把 daemon 一起带走；子进程里 exit code 就是失败信号。
 *
 * bin 入口 = `@weavecode/cli/bin/cli.js`（内部进 dist）。动态 resolve 不进
 * 编译期依赖（依赖方向 cli → server，编译期引会成环）；伞包安装里两者同级、
 * 运行期一定解析得到。**dev 前提 = cli 的 dist 已 build**（bin 只认 dist，
 * 改 CLI 源码后须先 build 再触发本端点）。
 *
 * harness 清单从 `.weave/config.yaml` 落档读（init 自己的选择结果）——没跑过
 * init 的项目不在此起 init（无从读清单，接入项目先走终端 init 或 scan）。
 * 同项目并发闸：init 改盘上文件，两把并发互踩——在飞直接 409。跑完不 commit
 * （生成物进不进 git 由用户在 IDE 复核），前端收到 ok 后刷新 updates 拿真账。
 */

/** 同项目在飞的 init（projectId → promise）；进程内闸，daemon 重启即清。 */
const inflight = new Map<number, Promise<void>>();

const INIT_TIMEOUT_MS = 120_000;

export async function handleProjectInit(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: number,
  deps: WeaveServerDeps,
): Promise<boolean> {
  const project = deps.projects.getById(projectId);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return true;
  }
  const runtime = await readInitRuntime(project.path);
  const flag = runtime.preset === 'minimal' ? '--preset=minimal' : runtime.preset === 'full' ? '--preset=full' : null;
  if (runtime.harnesses.length === 0) {
    sendJson(res, 409, {
      error: 'Project has no harnesses on record; run `weave init` in a terminal first',
    });
    return true;
  }
  if (inflight.has(projectId)) {
    sendJson(res, 409, { error: 'An init is already running for this project' });
    return true;
  }
  const run = spawnInit(project.path, runtime.harnesses, flag).finally(() => inflight.delete(projectId));
  inflight.set(projectId, run);
  try {
    await run;
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String((err as Error).message ?? err) });
  }
  return true;
}

function resolveCliBin(): string {
  // 主路径：包解析（伞包安装里 cli 与 server 同级）。monorepo dev 下 workspace
  // 包不在 node_modules——回落到仓布局（packages/weave-cli）。
  try {
    const resolved = import.meta.resolve('@weavecode/cli/package.json');
    const pkgUrl = pathToFileURL(resolved.startsWith('file:') ? resolved : `file://${resolved}`);
    return new URL('./bin/cli.js', pkgUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  } catch {
    // dev：…/packages/weave-server/src|dist/… → 仓根 → packages/weave-cli/bin/cli.js
    const here = fileURLToPath(import.meta.url);
    let dir = path.dirname(here);
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, 'packages', 'weave-cli', 'bin', 'cli.js');
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error('Cannot locate @weavecode/cli (not installed and not a dev checkout)');
  }
}

function spawnInit(projectPath: string, harnesses: readonly string[], presetFlag: string | null): Promise<void> {
  const bin = resolveCliBin();
  const args = ['init', '--no-interactive', `--harness=${harnesses.join(',')}`, ...(presetFlag ? [presetFlag] : []), `--dir=${projectPath}`];
  return new Promise<void>((resolve, reject) => {
    // 不经 shell（Windows 下 shell:true 时 kill 只杀 cmd.exe，node 孙进程成孤儿）：
    // cli.js 是普通脚本，node 直跑，kill 打在真进程上。
    const child = spawn(process.execPath, [bin, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`weave init timed out after ${INIT_TIMEOUT_MS / 1000}s`));
    }, INIT_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`weave init exited ${code}: ${out.slice(-500)}`));
    });
  });
}
