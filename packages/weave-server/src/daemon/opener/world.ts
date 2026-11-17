/**
 * 终端世界读取与按目录的 pane 操作（opener 门面的动作半边）：开/数/列/关 +
 * 30s 对账的三视图探测。门面（工厂表 + re-export）在 `../opener.ts`。
 */
import { normalizeDirKey } from './wezterm-mux.js';
import {
  TerminalBackend,
  type LaunchOrigin,
  type PromptPaneTarget,
} from './backend.js';
import { enumerableBackends, terminalBackendFor } from './backend-registry.js';
import { invalidateWeztermMuxCache } from './wezterm-probe.js';
import type { TerminalSettings } from '../settings.js';

/** Open a terminal at `dir` that runs `argv` (e.g. `claude --resume <id>`).
 * Same detached semantics as `openInTerminal` — the process outlives the daemon.
 * Returns the launch origin (spawn receipt) when the backend can get one. */
export async function runInTerminal(
  dir: string,
  argv: string[],
  terminal: TerminalSettings,
): Promise<LaunchOrigin | null> {
  // wezterm 分流在 WeztermBackend 覆写的 run 里，不在这里 if preset：有活 mux
  // 走 mux（legacy `start -- PROG` 绕过 default_prog，且 mux 在时 `start` 只会
  // 挂死出一个无窗僵尸 + trySpawn 假成功）；一个活 mux 都没有 → 回落 `start`
  // 起新 GUI（用户此刻还没开 wezterm 的常态），回落里起不来才抛。
  return terminalBackendFor(terminal).run(dir, argv);
}

export async function countOpenTerminals(
  dirs: string[],
  terminal: TerminalSettings,
): Promise<Map<string, number>> {
  // 「这个 preset 能不能反查」由后端回答（不支持 → 基类空表 → 上游落 0），
  // 不在调用方列 preset 白名单。
  return terminalBackendFor(terminal).countWindows(dirs);
}

/**
 * cwd **恰为** `dir` 的 pane = 这个项目的终端（关终端的命中判据，与
 * `countWindowsByDir` 同一条：精确相等、不含子目录）。关错一个就是杀掉用户
 * 顺手开着的别的活，故判据单点在此。
 */
export function panesAtDir(
  panes: readonly PromptPaneTarget[],
  dir: string,
  platform: NodeJS.Platform = process.platform,
): PromptPaneTarget[] {
  const wanted = normalizeDirKey(dir, platform);
  return panes.filter((p) => p.cwd != null && normalizeDirKey(p.cwd, platform) === wanted);
}

/**
 * `dir` 名下可关的 pane（项目关终端多选弹窗的数据面）：`panesAtDir` 命中的那些。
 *
 * 枚举不到 pane 而计数说有 = 这个后端有窗口却关不了（wt 只数不关）——如实抛，
 * 不返回空表让弹窗装作「没有终端」。
 */
export async function listProjectPanes(
  dir: string,
  terminal: TerminalSettings,
  platform: NodeJS.Platform = process.platform,
): Promise<PromptPaneTarget[]> {
  const backend = terminalBackendFor(terminal, platform);
  let panes = panesAtDir(await backend.listPromptPanes(), dir, platform);
  if (panes.length === 0 && ((await backend.countWindows([dir])).get(dir) ?? 0) > 0) {
    // 计数有值而枚举空 = 两路口径错位（mux 迟滞窗里实时枚举超时/空世界、计数
    // 吃的是 10s 缓存旧账）——先作废缓存重试一次再下「关不了」的结论。
    invalidateWeztermMuxCache();
    panes = panesAtDir(await backend.listPromptPanes(), dir, platform);
    if (panes.length === 0) {
      throw new Error(
        `Terminal preset "${backend.preset}" cannot close open panes remotely — pick wezterm in settings`,
      );
    }
  }
  return panes;
}

/**
 * 关掉 `dir` 的已开终端（项目卡「关闭终端」）：只关清单里的那些 pane——清单来自
 * 用户在弹窗里的多选，**不提供「一口气全关」**（那是这次要去掉的误触面）。
 * 窗口里别的 cwd 的 pane 不动（不替用户关掉顺手开着的别的活），只剩它一个时整窗
 * 随 pane 一起没。返回关掉的 pane 数；清单里的 pane 一个都没命中 = 目标已经没了，
 * 如实返回 0。
 */
export async function closeTerminalsIn(
  dir: string,
  terminal: TerminalSettings,
  paneIds: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<number> {
  const backend = terminalBackendFor(terminal, platform);
  const wanted = new Set(paneIds);
  const panes = (await listProjectPanes(dir, terminal, platform)).filter((p) => wanted.has(p.id));
  for (const pane of panes) await backend.closePane(pane.id);
  // 关 pane 是用户主动动作：作废探活缓存，紧随的对账看实时世界（角标/分组立刻降）。
  invalidateWeztermMuxCache();
  return panes.length;
}

/**
 * 终端世界三视图（30s 对账的**唯一探测入口**）：一次枚举同时出
 * - `counts`   每项目可见屏幕数（projectId → 数；全部可枚举后端求和），
 * - `hidden`   每项目隐藏目标数（0 不进表；探不到的目标不计入），
 * - `byTarget` 逐目标可见性明细（`projectId|targetId` → visible/hidden）。
 *
 * 旧三兄弟（readTerminalCounts/Hidden/Visibility）是同一趟探测的三个切面，
 * 各调一遍 = 各枚举一遍；合一后 30s 对账只打一轮。逐目标 visibility 查询
 * 有 powershell 开销，只配对账循环、不进请求关键路径；单项目失败隔离跳过。
 * 显示数 = counts − hidden（前端现算，不另探一趟）。
 */
export async function readTerminalWorld(
  projects: readonly { id: number; path: string }[],
): Promise<{
  counts: Record<number, number>;
  hidden: Record<number, number>;
  byTarget: Map<string, 'visible' | 'hidden'>;
}> {
  const paths = projects.map((p) => p.path);
  const all = enumerableBackends();
  const visBackends = all.filter(
    (b) => b.targetVisibility !== TerminalBackend.prototype.targetVisibility,
  );
  const [counts, byTarget] = await Promise.all([
    (async () => {
      const maps = await Promise.all(all.map((b) => b.countWindows(paths)));
      const byPath = new Map<string, number>();
      for (const m of maps) for (const [dir, n] of m) byPath.set(dir, (byPath.get(dir) ?? 0) + n);
      return Object.fromEntries(projects.map((p) => [p.id, byPath.get(p.path) ?? 0]));
    })(),
    (async () => {
      const byTarget = new Map<string, 'visible' | 'hidden'>();
      if (visBackends.length === 0) return byTarget;
      await Promise.all(
        projects.map(async (project) => {
          try {
            // 合并面：每个有显隐通道的后端各枚举各的目标（id 前缀天然区分归属）。
            // 吃探活缓存（realtime=false）——实时 `cli list` 是整轮探测的延迟大头。
            await Promise.all(
              visBackends.map(async (backend) => {
                const targets = await backend.listTargets(project.path, false, false);
                await Promise.all(
                  targets.map(async (t) => {
                    const vis = await backend.targetVisibility(project.path, t.id);
                    if (vis !== null) byTarget.set(`${project.id}|${t.id}`, vis);
                  }),
                );
              }),
            );
          } catch {
            // 枚举/查询失败 = 不摆态（与 count 探测失败的口径一致）
          }
        }),
      );
      return byTarget;
    })(),
  ]);
  const hidden: Record<number, number> = {};
  for (const [key, vis] of byTarget) {
    const projectId = Number(key.split('|')[0]);
    if (vis === 'hidden') hidden[projectId] = (hidden[projectId] ?? 0) + 1;
  }
  return { counts, hidden, byTarget };
}
