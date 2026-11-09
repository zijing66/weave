/**
 * RPG 视图加载进度（G1 判据⑥）：每格 = 一项真实加载（请求或本地模块装载），
 * 按实际 settle 计数——没有假节奏动画（同 `lib/boot-requests.ts` 的「等待即
 * 事实现场」口径）。游戏视图在 SPA 启动之后才进入，不挂 apiFetch 全局钩子，
 * 在 boot-requests 旁建 rpg 作用域的同形 store（snapshot/subscribe 同一形态，
 * useSyncExternalStore 消费）。
 *
 * 失败不静默：失败项保留 failed 态并带文案 key，重试 = 调用方重新发起该项的
 * 真实请求再走 settle。全清后由调用方淡出退场（复用场景切换 transition）。
 */

export const RPG_BOOT_ITEMS = [
  { key: 'roles', labelKey: 'rpg.bootRoles' },
  { key: 'orchestrations', labelKey: 'rpg.bootOrchestrations' },
  { key: 'runs', labelKey: 'rpg.bootRuns' },
  { key: 'sessions', labelKey: 'rpg.bootSessions' },
  { key: 'projects', labelKey: 'rpg.bootProjects' },
  { key: 'modules', labelKey: 'rpg.bootModules' },
] as const;

export type RpgBootKey = (typeof RPG_BOOT_ITEMS)[number]['key'];
export type RpgBootItemState = 'pending' | 'done' | 'failed';

export interface RpgBootSnapshot {
  items: readonly { key: RpgBootKey; labelKey: string; state: RpgBootItemState }[];
  done: number;
  total: number;
  /** 有失败项（停住等重试，不假满格）。 */
  failed: boolean;
}

type States = Record<RpgBootKey, RpgBootItemState>;

const initialStates = (): States => {
  const s = {} as States;
  for (const it of RPG_BOOT_ITEMS) s[it.key] = 'pending';
  return s;
};

let states: States = initialStates();
let snap = buildSnap();
const listeners = new Set<() => void>();

function buildSnap(): RpgBootSnapshot {
  const items = RPG_BOOT_ITEMS.map((it) => ({ ...it, state: states[it.key] }));
  const done = items.filter((i) => i.state === 'done').length;
  return { items, done, total: items.length, failed: items.some((i) => i.state === 'failed') };
}

function emit(): void {
  snap = buildSnap();
  for (const l of listeners) l();
}

export const rpgBoot = {
  /** 该项开始（真实请求发出 / 模块装载入口）。 */
  start(key: RpgBootKey): void {
    if (states[key] !== 'pending') states[key] = 'pending';
    emit();
  },
  /** 该项已落定（成功失败都是事实；失败保留态供重试面）。 */
  settle(key: RpgBootKey, ok: boolean): void {
    states[key] = ok ? 'done' : 'failed';
    emit();
  },
  /** 重试前清失败态（回到 pending）。 */
  retry(key: RpgBootKey): void {
    states[key] = 'pending';
    emit();
  },
  snapshot(): RpgBootSnapshot {
    return snap;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
