/**
 * 终端把「我在哪个 pane」导出的环境变量名（按 preset 分表）——跨端契约表：
 * hook 脚本（生在会话自己的 pane 里，继承这些 env）据此捕获上报，server 侧终端
 * 后端据此把捕获值解析回自己的 pane 表示法。两端同源取用，不各写一份。
 *
 * 键 = 终端 preset 名（与设置里的 preset 同字面）；值是「一起才唯一」的那组键。
 *
 * 新增终端：① 本表加一条；② 该终端后端覆写 `TerminalBackend.locatePane`（env →
 * 本后端 pane id，**必须含存在性校验**，失效即 null 而不是猜）；③ 它还得是
 * `textAddressable` 且覆写 `ownsPaneId`（认领本后端发出的 pane id——击键/文本按
 * id 归后端，故会话的终端操作不随设置里的 preset 变）——定位只为「往这个 pane 打
 * 文本 / 打键序」服务。没有文本通道的 preset 不列：hook 脚本会白捕获一堆永远用
 * 不上的 env。
 *
 * 语义限定：只收「同一台机器上能唯一定位一个 pane」的变量。没有这种变量的终端
 * （如 Windows Terminal 只有窗口级 session id）不列——层② 回落标题+cwd 启发式，
 * 而不是拿一个不唯一的键硬猜。
 */
export const TERMINAL_LOCATOR_ENV = {
  /** wezterm：pane 号 + 该实例的 mux socket（两者一起才唯一）。 */
  wezterm: ['WEZTERM_PANE', 'WEZTERM_UNIX_SOCKET'],
} as const satisfies Record<string, readonly string[]>;

/** 全部 preset 的定位键并集（hook 脚本一次性捕获用；去重保序）。 */
export const TERMINAL_LOCATOR_ENV_KEYS: readonly string[] = [
  ...new Set(Object.values(TERMINAL_LOCATOR_ENV).flat()),
];
