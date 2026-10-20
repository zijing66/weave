import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';
import { dataRoots, getDataDir, type DataRoots } from './paths.js';

/**
 * 旧版「顶层散放」→ 三档目录（`data/` `local/` `cache/`，见 `dataRoots`）的一次性搬迁。
 *
 * - **只 rename，从不删除**：目标已存在就跳过、旧文件原样留着供人核对；rename 失败
 *   （活着的进程正开着它 / 权限）也只跳过——下次启动再来一遍；
 * - 幂等：搬完源就不在了，再调是空转；
 * - 有活着的 daemon 占着这份数据目录时**整个不动**（搬走库与流水文件会把它拆散）。
 */
const LEGACY: Record<keyof DataRoots, string[]> = {
  data: ['market', 'uploads', 'plugins'],
  local: ['auth.json', 'ai.json', 'push.json', 'initial-password', 'certs', 'weave-autostart.vbs'],
  cache: ['logs', 'statusline', 'hooks', 'tmp', 'daemon.json'],
};

/** 库文件一族（含 `-wal` / `-shm` 与手工备份 `weave.db.bak-*`），按前缀认。 */
const DB_PREFIX = 'weave.db';

/**
 * 搬完要在旧位置留**目录链接**的两个：它们的写方是 `weave init` 生成到项目里的
 * 脚本（hook 采集脚本、statusline helper），落点写死在生成那一刻——包里改了路径，
 * 存量脚本仍往老位置写，事件就进了没人读的目录。留个链接，老脚本照旧写进 cache/，
 * 下次 `weave init` 换上新脚本后它只是个空壳。
 */
const BRIDGES = ['hooks', 'statusline'] as const;

export interface LayoutMigration {
  /** 搬过去的旧顶层名。 */
  moved: string[];
  /** 该搬但没搬（目标已存在 / rename 失败），旧文件仍在原处。 */
  kept: string[];
  /** 在旧位置补了目录链接的名字（存量脚本还在往那儿写）。 */
  bridged: string[];
  /** 占着数据目录的 daemon pid；非 null 时本次一个都没搬。 */
  busyPid: number | null;
}

/** 数据目录里活着的 daemon（新位置与旧顶层各看一眼：搬迁前后都要答得出）。 */
export function liveDaemonPid(root: string = getDataDir()): number | null {
  const plan = dataRoots(root);
  for (const file of [path.join(plan.cache, 'daemon.json'), path.join(root, 'daemon.json')]) {
    try {
      const pid = Number((JSON.parse(readFileSync(file, 'utf-8')) as { pid?: unknown }).pid);
      if (pid > 0 && isAlive(pid)) return pid;
    } catch {
      // 没有 / 半截文件 / 非法 JSON 都当「没人在」
    }
  }
  return null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 目录合并（目标已有的同名文件不覆盖），然后把空壳删掉——只为「搬完又长出来」兜底。 */
function mergeInto(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) mergeInto(src, dst);
    else if (!existsSync(dst)) renameSync(src, dst);
  }
  rmSync(from, { recursive: true, force: true });
}

/** 搬迁 + 打一行结果（daemon / CLI 启动点的唯一调用形）。 */
export function ensureDataLayout(root: string = getDataDir()): LayoutMigration {
  const r = migrateDataLayout(root);
  if (r.moved.length > 0) console.log(`[weave] data layout: moved ${r.moved.join(', ')}`);
  if (r.kept.length > 0) console.log(`[weave] data layout: kept ${r.kept.join(', ')} (target exists)`);
  return r;
}

export function migrateDataLayout(root: string = getDataDir()): LayoutMigration {
  const out: LayoutMigration = { moved: [], kept: [], bridged: [], busyPid: null };
  const busy = liveDaemonPid(root);
  if (busy !== null) {
    out.busyPid = busy;
    return out;
  }
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return out; // 数据目录还没建 = 全新安装，无旧可搬
  }
  const classes = Object.keys(LEGACY) as Array<keyof DataRoots>;
  const roots = dataRoots(root);
  for (const name of names) {
    if (isLink(path.join(root, name))) continue; // 上一轮补的链接
    const cls = classes.find((c) => LEGACY[c].includes(name)) ?? (name.startsWith(DB_PREFIX) ? 'data' : null);
    if (!cls) continue;
    const toDir = roots[cls];
    // 目标已存在 = 搬迁之后脚本又往老位置写了；合并过去而不是干看着丢事
    if (existsSync(path.join(toDir, name)) && (BRIDGES as readonly string[]).includes(name)) {
      try {
        mergeInto(path.join(root, name), path.join(toDir, name));
        out.moved.push(name);
      } catch {
        out.kept.push(name);
      }
      continue;
    }
    if (existsSync(path.join(toDir, name))) {
      out.kept.push(name);
      continue;
    }
    try {
      mkdirSync(toDir, { recursive: true });
      renameSync(path.join(root, name), path.join(toDir, name));
      out.moved.push(name);
    } catch {
      out.kept.push(name);
    }
  }
  for (const name of BRIDGES) {
    const legacy = path.join(root, name);
    const target = path.join(roots.cache, name);
    if (!existsSync(target) || existsSync(legacy)) continue;
    try {
      symlinkSync(target, legacy, process.platform === 'win32' ? 'junction' : 'dir');
      out.bridged.push(name);
    } catch {
      // 建不出链接就拉倒：老脚本继续写老目录，重新 init 之后自然就好
    }
  }
  return out;
}
