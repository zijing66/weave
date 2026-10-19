# P0：ZCode 只读看板

> 目标：`weave init` 选了 zcode 的项目，zcode 会话能出现在会话列表、事件链有内容、
> 能点「在终端打开」。**不投递、不问答、不装 MCP**——那些是 P1 / P2。
>
> 依赖：R1（开终端能力化）。实际阻塞项其实是下面这条**信任门结论**。

## 0. 先读这一条：ZCode 的项目级 hooks 在当前发行版里是死的

这条改变了 P0 的整个落法，写在最前面。

- 项目级 `.zcode/config.json` 的 `hooks` **不参与** `configured-runner` 的可执行配置
  合并——`apps/zcode-cli/packages/adapters/src/config/config-factory.ts:230`：
  > `// Project Hook events stay outside this executable merge. The snapshot above is
  > the only Phase 1 side-channel and cannot be consumed by configured-runner.`
- 它们另走「工作区信任」通道：`core/src/hooks/configured-runner.ts:76-99` 为每条
  项目 hook 挂 `admission` 求值器，`admission.evaluateDispatch` 的实现
  `core/src/hooks/workspace-hook-runtime-admission.ts:132-140`：
  ```ts
  if (!this.activated) return { allowed: false, reasonCode: "workspace_hooks_pending_trust" };
  if (!this.enabled)  return { allowed: false, reasonCode: "workspace_hooks_feature_disabled" };
  ```
- `enabled` 来自 `workspaceHookTrustEnabled`，**只有 protocol server 传 true**
  （`bootstrap/src/zcode-protocol/server-operations.ts:3546`）；CLI / TUI 路径不传
  （`bootstrap/src/app/types.ts:219` 为可选，`create-app.ts:342` 原样透传）⇒ 缺省
  `false` ⇒ 项目 hooks 恒 `allowed: false`。

⇒ **P0 必须把采集入口写在用户级配置**：`~/.zcode/cli/config.json`
（`adapters/src/config/file-config.adapter.ts:61-62`：`DEFAULT_BASE_DIR = "~/.zcode/cli"`,
`DEFAULT_CONFIG_FILE = "config.json"`；无路径 env 覆盖）。

这也是一个**新的 init 形状**：codex 无 hook 面、claude 的 hook 在项目
`.claude/settings.json`（项目级）；zcode 是第一个「hook 只能用户级、但要按项目分流」
的 harness。落法见下面第 3 节。

## 1. 采集形状：一条用户级 hook → 项目级 shard

ZCode 给 hook 子进程导出的环境里**已经有** `CLAUDE_PROJECT_DIR` 与
`CLAUDE_CODE_SESSION_ID`（`core/src/hooks/configured-runner-input.ts:74-85`），
而 weave 的采集脚本第一句就是
`var projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();`
（`weave-harness/src/claude/capture.ts:306`），随后从 `<projectDir>/.weave/token`
算 shard。

⇒ **生成的脚本可以原样复用**：用户级配置里那一条 hook 指到一份**全局脚本副本**，
脚本自己按 `CLAUDE_PROJECT_DIR` 找到当前项目、读它的 `.weave/token` 算 shard；
不是 weave 项目（无 token）→ 什么都不写、退出 0（现有行为）。

脚本副本落点：`<configDir>/weave/hooks/zcode/hook-handler.cjs`
（`configDir()` 即脚本里已有的 win32=APPDATA / darwin=Library/Application Support /
其他=XDG_CONFIG_HOME 口径）。**必须放 dataDir 侧、不放项目内**：用户级配置只有一份，
指到某个项目的绝对路径就会在多项目之间互相覆盖。

配套影响：
- `weave doctor` 的采集脚本健康检查（`CaptureSurface.scriptHealth`）要认识
  zcode 的这个落点，不能只在项目 `.claude/helpers/` 下找。**改法**：落点由
  `CaptureSurface` 自己声明（已有槽），server 不写路径。
- 重写判据仍是文件里含 `@version weave@` 子串（与版本号无关），所以 `weave init`
  在任一 zcode 项目里重跑都会刷新这份全局脚本——与 claude 的「重跑 init 即修」同口径。

### 需要写进 `~/.zcode/cli/config.json` 的内容

```jsonc
{
  "hooks": {
    "enabled": true,                  // 缺省 false，不写就完全不跑（create-app.ts:349）
    "timeoutMs": 5000,
    "events": {
      "SessionStart":     [{ "hooks": [{ "type": "process", "command": "node", "args": ["<abs>/zcode/hook-handler.cjs"] }] }],
      "UserPromptSubmit": [{ "hooks": [ /* 同上 */ ] }],
      "PreToolUse":       [{ "hooks": [ /* 同上 */ ] }],
      "PostToolUse":      [{ "hooks": [ /* 同上 */ ] }],
      "PostToolUseFailure":[{ "hooks": [ /* 同上 */ ] }],
      "PermissionRequest":[{ "hooks": [ /* 同上 */ ] }],
      "Stop":             [{ "hooks": [ /* 同上 */ ] }]
    }
  }
}
```

形状出处：`adapters/src/config/schema.ts:262-285`（`hookMatcherSchema`
`{ matcher?: string, hooks: [...] }`、`hookProcessSchema`
`{type:'process', command, args?, enabled?, timeoutMs?, statusMessage?}`）。

**合并纪律**：沿用 weave 既有的「用户文件只追加/合并、不覆写」策略（memory
`weave-init-write-policy`）——只增补 weave 自己的条目（按 `command` 里的
`weave/hooks/zcode/hook-handler.cjs` 识别），不动用户已有 hook。

## 2. core 四表 + 两张附加表

`packages/weave-core/src/harness.ts`：

```ts
HARNESS_NAMES = ['claude', 'codex', 'zcode'] as const;

HARNESS_EVENTS.zcode = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'UserPromptSubmit', 'SessionStart', 'PermissionRequest', 'Stop',
] as const;   // 出处：contracts/src/hooks/index.ts:8-16 的 HookEventName

INJECTABLE_EVENTS.zcode = [
  'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'SessionStart', 'Stop',
] as const;   // 出处：contracts/src/hooks/index.ts:174-194 的 HookSpecificOutput 联合

TITLE_EFFECTIVE_EVENTS.zcode = [] as const;
// ZCode 的 HookSpecificOutput 没有 sessionTitle 字段 → 无改名通道

HARNESS_DIRS.zcode = { projectDir: '.zcode', userDir: '.zcode' };

HARNESS_INSTRUCTION_FILES.zcode = ['AGENTS.md'] as const;
// adapters/src/context/index.ts:24 DEFAULT_PRIORITY_FILES = ["AGENTS.md"]
// 与 codex 同名 → weave init 的 instruction-link 已把 AGENTS.md 链到 CLAUDE.md，
// zcode 白拿；本表只为派生卸载清扫与提交候选。

HARNESS_LIFECYCLE.zcode = {
  open: 'UserPromptSubmit',
  close: ['Stop'],
  closeFailed: [],
  sessionMarkers: ['SessionStart'],
  subagentStop: '',            // ZCode 无 SubagentStop 事件
  questionTools: ['AskUserQuestion', 'ExitPlanMode'],
  sessionExit: null,           // ZCode 无 SessionEnd 事件
};

HARNESS_COMPACTION.zcode = {
  start: null,                 // 无 PreCompact → 没有「正在压缩」实时态
  end: 'SessionStart',
  endSource: 'compact',        // SessionStartHookInput.source 含 'compact'
};
```

三个「空」是本轮**有意诚实不实现**的地方，不是漏项：

| 项 | 后果 | 为什么不硬凑 |
|---|---|---|
| `subagentStop: ''` | 子代理收尾不单独成组 | ZCode 没有该事件；`Stop` 已关组 |
| `sessionExit: null` | 会话退出不出盘 inbox 凭据、不清 pane 定位 | ZCode 无 `SessionEnd`；且 zcode 的 inbox 面本来就不在（见 P1） |
| `compaction.start: null` | 没有「压缩会话中…」实时态，只有事件链上那一笔「压缩会话」tag | ZCode 不发前置事件，只能看见收尾笔 |

`HARNESS_SESSION_CONTROL.zcode` 两表留空（`modeNames: []`, `modelNames: []`）
——空 = 该 harness 无切换概念，UI 不提供切换入口。**ZCode 的 `mode` 仍能显示**：
它由 hook payload 的 `mode` 直给（`BaseHookInput.mode`）。切换面待 🔬3 之后另开
（TUI 里 `/model` 是否存在、键序如何，属于 P2 之后的扩展，本轮不承诺）。

## 3. `weave-harness/src/zcode/` 模块清单

照 codex 的目录形状（一个 harness 一个目录、`index.ts` 组装 driver）：

| 文件 | 内容 | 本轮 |
|---|---|---|
| `index.ts` | `ZCODE_DRIVER`：`id:'zcode'`，`capabilities: ['assets','detect','capture']` + 各槽装配 | ✅ |
| `capture.ts` | `CaptureSurface`：`generateHookHandler(version,'zcode')` 的**生成物内容**（复用 claude 的实现，见下）、脚本落点、`scriptHealth`、采集开关名单 | ✅ |
| `detect.ts` | `Detector`：marker 只认 `.zcode`（**不加 `AGENTS.md`**——那是 codex 的 marker，见 CLAUDE.md「不用 marker 探测」条；探测只答「目录像不像」） | ✅ |
| `resume.ts` | `ResumeCommandSpec`：`bin:'zcode'`，`args:(id)=>['--resume',id,'-p']`，`promptStdin:true`，`openArgs:(id)=>['--resume',id]` | ✅ |
| `assets.ts` | `AssetSurface`：`projectSkillsDir:'.zcode/skills'`（`adapters/src/skills/roots.ts` 的 `skillRootsForBase`）、`globalSkillsRoots`、`userConfigFile:'~/.zcode/cli/config.json'`、`mcpScopes:['project','user']`、`mcpDest`、`classify`/`ignore` | ✅（`mcpRead/Write/Remove` 留 P2） |
| `messaging.ts` | `MessagingSurface`：全 null + `unsupportedReasons` | ✅（实现留 P1） |
| `questions.ts` | `BlockingPromptSpec` = null | ✅（实现留 P2） |
| `event-source.ts` / `plugin-state.ts` | null | ✅ |
| `init.ts`（在 `weave-cli/src/init/harnesses/zcode.ts`） | `ZcodeInitTemplate extends InitPipeline` | ✅ |

### `capture.ts` 怎么复用 claude 的生成器

`generateHookHandler(version)`（`weave-harness/src/claude/capture.ts:24`）已经产出
「依赖零、无网络、永不阻塞」的脚本。ZCode 侧要的差异只有三处，**参数化即可**：

1. `OWN_HARNESS`（R2 加的参数）——镜像文档过滤；
2. 头部注释里的宿主名与落点说明；
3. `CLAUDE_PID` 可能不存在 → 终端定位的 pid 回落 `process.ppid`（见下）。

⇒ 把签名定为 `generateHookHandler(version, harness)`，内部按 harness 组装这几处；
claude 与 zcode 共用一份实现，**不复制粘贴**。R2 已经把 `harness` 参数引入，
P0 只补齐注释与 pid 回落。

**终端定位（层② 的前置）**：locator 键表（`TERMINAL_LOCATOR_ENV`，core）里
wezterm/konsole/iterm 的键都由会话进程继承下来，zcode 的 hook 子进程照样继承。
只有 `wt` 的 `CLAUDE_PID` 没有——zcode 不导出（`configured-runner-input.ts:79-85`
只有 session/project/plugin 四类键）。落法：脚本里 pid 字段取
`process.env.CLAUDE_PID || String(process.ppid)`。🔬（见
[`04-empirical-checks.md`](./04-empirical-checks.md) 的 🔬5：Windows 上 ppid 是否
就是 zcode 会话进程本身、还是夹了一层 shell）。

## 4. 采集脚本对 zcode 要关掉的部分

同一份脚本里有些段落是 claude 专有机制，zcode 上不生效也**不能生效**：

- `messagingEnv()`（inbox socket 凭据）→ zcode 无对应 env → 返回 null，天然不报。
- `sessionTitle` 改写 → `TITLE_EFFECTIVE_EVENTS.zcode = []` ⇒ 脚本里
  `TITLE_EVENTS` 为 `[]`，永不尝试。
- `SubagentStop` / `PreCompact` / `SessionEnd` 分支 → 事件名不在
  `HARNESS_EVENTS.zcode` 里，zcode 永不发。

⇒ 生成时把上面三项按 harness 参数置空，**不要靠运行时判断**（脚本要尽快退出）。

## 5. init 模板（`weave-cli/src/init/harnesses/zcode.ts`）

`ZcodeInitTemplate extends InitPipeline`，与 `CodexInitTemplate` 同形状，
但要实现 codex 直接 `skipNoFace` 掉的那几步：

| 步骤 | claude | codex | **zcode** |
|---|---|---|---|
| `ensureDirs` | `.claude/{helpers,skills,…}` | `.codex/skills` | `.weave/*` + `<dataDir>/weave/hooks/zcode/` |
| 生成 hook 脚本 | `.claude/helpers/hook-handler.cjs` | skip | **`<dataDir>/weave/hooks/zcode/hook-handler.cjs`** |
| 宿主配置注入 | 合并 `.claude/settings.json` 的 `hooks` | skip | **合并 `~/.zcode/cli/config.json` 的 `hooks`**（见第 1 节） |
| 指令文件合一 | CLAUDE.md 主名 | AGENTS.md→CLAUDE.md | 无新增（AGENTS.md 已被 codex 那条链好；若项目只装 zcode，则由 `HARNESS_INSTRUCTION_FILES` 表驱动合一，主名为 AGENTS.md） |
| 可裁剪组件开关 | `hooks.preCompact` 等 | 无 | 无（zcode 的 7 个事件全要） |

**注意**：`hooks.sessionEnd` / `hooks.preCompact` 这两个开关对 zcode 无意义
（事件不存在），模板里不要把它们降级成「跳过提示」，直接不出现。

`init/wiring.ts` 的 `HARNESS_INIT_TEMPLATES` 加 `zcode` 一项——`buildInitRegistry()`
的表驱动意味着这一步漏了 zcode 就永远 init 不出来，**也是 `satisfies Record<Harness,…>`
会催补的地方**。

## 6. web 元数据

`web/src/lib/harness-meta.ts` 的 `HARNESS_UI` 加一行：

```ts
zcode: {
  label: 'ZCode',
  tooltip: '…',
  badge: 'ZCode',
  dotDir: '.zcode',
  source: '…',
  icon / iconRunning / iconIdle / runAnimation,
},
```

`HARNESS_ORDER = Object.keys(HARNESS_UI)` 自动跟随，页签/筛选不用另改。
图标沿用现有 `lucide` 集合里的一枚（选与其他两家明显可辨的）。

`web/src/lib/tasks/lifecycle.ts` 的常量镜像补 `zcode` 三项（事件表 / 生命周期 /
压缩表），与 core 同值——这个文件是**镜像**，不是第二真源，改完加一行注释指向 core。

## 7. 已知降级项（P0 就接受，不做补救）

1. **「已中断」态不出现**：ZCode 无转录可读（会话在 SQLite，hook 的
   `transcript_path` 是每次现造的临时 1 行假文件），`interruptMarkerAt` 无输入。
   但 ZCode 有更直接的信号 `PostToolUseFailure.isInterrupt`
   （`contracts/src/hooks/index.ts:116`）——**只覆盖「工具调用进行中被中断」**，
   纯生成阶段被中断无事件。⇒ 打断后 `turnOpen` 仍开着，web 停在「生成中」，
   直到下一条 `UserPromptSubmit`/`Stop`。停止按钮因此会一直露着（`canInterrupt`
   判 `turnOpen` 未知时按 `isSessionBusy` 兜底 → 仍可再按，无害）。
   补救留扩展（读 SQLite 会话库），不在 P0~P2 承诺内。
2. **无「压缩会话中…」实时态**（见第 2 节表格）。
3. **`transcriptPresent` 恒 null**：`SessionProbe` 只在 claude 的 hook 事件里拿到
   `transcriptPath`。zcode 不报 → `null` → 列表不禁用「在终端打开」，501 校验那一步
   也不会因转录误拒（它只在 `=== false` 时拒）。这是**正确**行为：zcode 的 resume
   只要能连 SQLite 里的会话行，会话行是我们采集出来的、必然存在。
4. **模型标签**：`SessionStart.model?` 与 `PostModelSwitch` 都没有模型切换事件；
   ZCode 的 `SessionStartHookInput.model` 可选，实机是否填 🔬。填了就有标签，
   没填就空着，不做假。

## 8. 验收

一串可执行检查，按序跑：

1. `weave init --harness zcode` 在一个真项目里跑通；`~/.zcode/cli/config.json`
   出现 `hooks.enabled: true` 与 7 个事件条目；`<dataDir>/weave/hooks/zcode/hook-handler.cjs`
   存在且含 `@version weave@`。
2. 在该项目里起一个 zcode TUI 会话、说一句话：
   - `<dataDir>/hooks/inbox/<shard>.jsonl` 出现行（先证采集通）；
   - dashboard 会话列表出现该会话、`harness` 标签为 ZCode；
   - 事件链有 `SessionStart` → `UserPromptSubmit` → `PreToolUse`/`PostToolUse…` → `Stop`；
   - 回合状态「生成中」→ 收到 `Stop` 后收合；**停止按钮随之消失**（这是 `close` 生效的证据）。
3. 点「在终端打开」→ 新窗里起 `zcode --resume <id>`，能接着聊（**R1 生效的证据**）。
4. 关掉 daemon、再来一轮对话、重开 daemon：事件不丢（采集脚本无网络依赖）。
5. `weave doctor` 的采集脚本一节对 zcode 项目报「weave 生成」。
6. 非 weave 项目里起 zcode 会话：脚本退出 0、不写任何文件（`weave init` 未跑过
   的项目不该被污染）。

## 9. 风险与回滚

| 风险 | 处置 |
|---|---|
| 用户级配置合并把用户已有 hook 弄坏 | 只按 `weave/hooks/zcode/hook-handler.cjs` 子串识别自己的条目增删；JSON 解析失败一律不改、只告警（同 `.claude/settings.json` 现有纪律） |
| ZCode 后续版本打开工作区信任开关 | 那时用户级入口照旧工作（两条路都能跑）；是否改回项目级另议，届时跑 C1 的复测 |
| `hooks.enabled: true` 是全局开关，会连带启用用户自己的全部 hook | 这正是用户预期（他们要自己的 hook 跑）；weave 只在缺省缺失时写 true，已有值不覆盖 |
| 事件量大（`PostToolUse` 每次工具） | 脚本已有 `INBOX_MAX_BYTES`(4MB) / `INBOX_MAX_LINES`(1000) 上限与去重窗；zcode 侧无需另设 |
| 名字撞车 `zcode` vs `codex` | 全仓判断都是精确相等（无子串匹配）；R3 清零 server 的 `=== 'codex'` 分支后更干净。加表时**逐处**核 `codex` 有没有被漏改 |

回滚 = 从 `HARNESS_NAMES` 去掉 `zcode`（`satisfies` 会催补全部表，编译期就能确认
改全了），再从用户配置里摘掉 weave 的 hook 条目。部署上是一次 init 的事。

## 10. 提交切分

| 提交 | 内容 | 可独立验收 |
|---|---|---|
| P0-1 | core 六张表的 `zcode` 行 + `HARNESS_NAMES` + 空的 harness 目录（driver 只注册 assets/detect/capture 的空壳） | 编译通过、全测试绿、无 zcode 项目可 init |
| P0-2 | `zcode/{detect,resume,assets}.ts` + `init/harnesses/zcode.ts` + `wiring.ts` | `weave init --harness zcode` 能落盘 |
| P0-3 | `generateHookHandler(version,'zcode')` 参数化 + `capture.ts` + 用户级配置合并 | 采集通（验收 1、2、4、6） |
| P0-4 | web `HARNESS_UI.zcode` + `tasks/lifecycle.ts` 镜像 + 图标 | 列表/事件链/页签渲染正确，开终端按钮出现（验收 2、3） |
| P0-5 | `weave doctor` 对 zcode 脚本落点的识别 | 验收 5 |
