# ZCode 接入 harness：总览与优先级

> 计划状态：待执行。本目录是可落档的执行计划，按优先级排序；每一批都能独立开工、
> 独立提交、独立验收。标注 🔬 的条目是**必须先实机取证**的未知量（见
> [`04-empirical-checks.md`](./04-empirical-checks.md)）。

## Context

用户要求：把 `D:\GitRepo\AIRepo\ZCode`（ZCode CLI，v3.16.1，Apache-2.0）接成 weave 的
第三个 harness，并**先体检抽象适配层、优先修复缺口**。裁决两条：

1. MCP 写侧（唯一需要扩抽象的缺口）**扩 `AssetSurface` 加写方法**，不新开第 11 个槽；
2. 接入深度**全量推进 P0~P2**（只读看板 → 投递 → 问答/资产），P3 的 mailbox 直投
   仍作实验项，不在本计划承诺范围内。

## 为什么值得接（结论回顾）

ZCode 本身是 **Claude Code 的兼容实现**，不是"另一家 agent"：

- 7 个 hook 事件名**全部落在 claude 的事件表里**（`PreToolUse` / `PostToolUse` /
  `PostToolUseFailure` / `UserPromptSubmit` / `SessionStart` / `PermissionRequest` /
  `Stop`）——是子集，但不含任何新名字；
- hook stdin **主动补 Claude 的 snake_case 别名** + 注入 `CLAUDE_CODE_SESSION_ID` /
  `CLAUDE_PROJECT_DIR`（`apps/zcode-cli/packages/core/src/hooks/configured-runner-input.ts:74-100`）；
- `AskUserQuestion`（含 `preview`）/ `ExitPlanMode` / Claude 插件目录格式逐项对标。

⇒ weave 的 `claude/` 实现有相当一部分可以参数化复用（采集脚本就是），而不是从
codex 那种空面起步。

**但几处结构性差异必须按 ZCode 自己的形状写，不能照抄 claude**：

| 差异 | claude | zcode |
|---|---|---|
| **hooks 落点** | 项目 `.claude/settings.json` | **只能用户级 `~/.zcode/cli/config.json`**——项目级 hooks 在当前发行版的 TUI 里被工作区信任门恒拒（已结案，见下方 C1） |
| 会话存储 | JSONL 转录（`transcript_path` 可尾读） | SQLite；`transcript_path` 是每次 hook 现造的临时假文件 |
| 中断信号 | 转录里的中断标记（`interruptMarkerAt`） | `PostToolUseFailure.isInterrupt`（只覆盖工具阶段被中断，纯生成阶段无事件） |
| 权限确认 | `Notification` 事件 + `notification_type='permission_prompt'` | `PermissionRequest` 事件，**自带工具面**（更强） |
| 跨会话消息 | `SendMessage` 寻址 peer 注册表 | **没有**；`SendMessage` 这个工具名只发给本会话的子 agent |
| 配置形状 | `hooks.<Event>` 数组 | `hooks.{enabled, events: {<Event>: [{matcher, hooks: [...]}]}}`，**默认 `enabled: false`** |
| MCP | 两档、两份 JSON | 两档、**同一份 schema**（`mcp.servers`） |

## 独立于 zcode 的两个关键结论

**C1 — 项目级 hooks 是死的**（已用源码三处互证结案，细节见
[`01-p0-capture.md`](./01-p0-capture.md) §0 与 `04` 的「已结案」节）：ZCode 把项目
hooks 走「工作区信任」通道，而 `workspaceHookTrustEnabled` 只有 protocol server 传
true，CLI/TUI 不传 ⇒ 恒 `allowed: false`。**P0 的采集入口必须写用户级配置。**

**P1 没有层①**：ZCode 的 `SendMessage` 不是 peer 消息（收件人是 `agent_<uuid>`
子代理），`PromptRelaySpec` 无处可依。手动面因此是「层② 终端 + 层③ 队列」两段
（详见 [`02-p1-messaging.md`](./02-p1-messaging.md) §3）。

## 优先级与依赖

```
R1 会话行开终端能力化 ─┐
R2 inject 镜像表驱动  ─┤
R4 toolkit 写死清理   ─┼─→ P0 只读看板 ─→ P1 投递 ─→ P2 问答/资产
R3 MCP 写侧能力化 ─────┘                     （R3 是 P2 的硬前置）
```

- **R 批次与 ZCode 解耦**：修的是"第三个 harness 会撞到、且存量也有小毛病"的地方，
  先落可以先受益，也把 P0 的改动面压小。
- **P0 不依赖 R3**：MCP 装面是 P2 的事。
- **P1 依赖 R2**：ZCode 支持 `additionalContext`，inject 规则必须能进镜像。

## 批次总表

| 批 | 目标 | 主要改动面 | 依赖 | 工作量 | 可验信号（摘要） |
|---|---|---|---|---|---|
| **R1** | 会话行「在终端打开」不再写死 claude | server `/sessions` 行 +1 字段；web 一处门控 | — | 0.5 天 | 非 claude harness 注册 `openArgs` 后按钮出现 |
| **R2** | inject 镜像按表判定，不再写死 claude | `hooks/mirror.ts` 逐条盖章 + 生成脚本按票过滤 | — | 0.5 天 | 同一项目里 claude 与 zcode 的 inject 规则互不串台 |
| **R3** | MCP 读写能力化（`AssetSurface` 扩三方法） | harness driver + claude/codex 两个表示法实现 + server 5 处 + web 1 处 | — | 1.5~2 天 | 三 harness 装卸都走同一条表调用；存量行为零变化 |
| **R4** | toolkit 写死 claude 的裸表面落盘按 target 走 | `hooks/toolkit.ts` 一处循环 | — | 0.5 天 | manifest `targets` 含非 claude 时不再落到 claude 路径 |
| **P0** | ZCode 只读看板（会话可发现、有事件链、能开终端） | core 六张表 + `weave-harness/src/zcode/` + cli init + 用户级 hook 注入 + web 元数据 | R1、🔬2、安装 | 2~3 天 | zcode 会话出现在列表、事件链有内容、停止按钮按 `Stop` 收合 |
| **P1** | 投递（层② 终端 / 层③ 队列 / inject） | `weave-harness/src/zcode/messaging.ts` + 生成脚本 pid 回落 | P0、R2、🔬4、🔬5 | 1~1.5 天 | 手动面消息经终端打进 zcode pane 并被 UPS 回执核销 |
| **P2** | 问答 + MCP 装面 | `zcode/questions.ts`、`zcode/assets.ts` + `zcode/mcp.ts` | P0、R3、🔬3、🔬7、🔬8 | 2~3 天 | 远程作答能把键序打进 TUI 模态框；zcode MCP 双档可装可卸 |
| P3（不承诺） | mailbox 直投实验 | 开关 + 写 `<root>/<sid>/unread/` | P1、🔬6 | 1 天 | 直投 < 1s 到达、不误触暂停闸、`read/` 增长有处置 |

## 实测前置（🔬）

全部方法与判据见 [`04-empirical-checks.md`](./04-empirical-checks.md)。摘要：

| 编号 | 未知量 | 阻塞哪批 | 现状 |
|---|---|---|---|
| C1 | 项目 `.zcode/config.json` 的 hooks 在 TUI 下是否真 fire | P0 | ✅ **已结案：不跑** ⇒ 走用户级配置 |
| 🔬2 | `Stop` 的 `last_assistant_message` 是否全量 | P0（面板质量） | 待测，不阻塞开工 |
| 🔬3 | TUI 阻塞模态框的真实键位表 | P2 | 待测（**硬前置**） |
| 🔬4 | `-p` 能否读 stdin / TUI 认不认 bracketed paste / user hook 的 `additionalContext` 是否生效 | P1 | 待测 |
| 🔬5 | Windows 上 hook 子进程的 ppid 是否就是 zcode 会话进程 | P1 | 待测 |
| 🔬7 | 哪些权限模式结构上不弹框 | P2 | 待测 |
| 🔬8 | 项目级 MCP 是否真被宿主读取 | P2 | 待测 |
| 0 | `zcode` 的安装形态与版本探测（决定 `resume.bin` 与 shell 启动） | P0 | 本机未装 |

## 文档索引

| 文件 | 内容 |
|---|---|
| [`00-abstraction-gaps.md`](./00-abstraction-gaps.md) | R1~R4 四批抽象缺口：现状证据 / 目标 / 验收 / 风险 / 提交切分 |
| [`01-p0-capture.md`](./01-p0-capture.md) | P0 只读看板：core 六表、zcode 模块清单、用户级 hook 注入、已知降级项 |
| [`02-p1-messaging.md`](./02-p1-messaging.md) | P1 投递：通道裁决表、为什么没层①、层② 落地细节、为什么不并 mailbox |
| [`03-p2-questions-assets.md`](./03-p2-questions-assets.md) | P2 问答 + 资产：三类模态框形状、权限用 `eventQuestion`、MCP 双档 |
| [`04-empirical-checks.md`](./04-empirical-checks.md) | 全部 🔬 的手法与判据 + 已结案的 C1 证据链 |

## 与既有文档的关系

- 本目录只写"怎么接 ZCode"与"接之前先修什么"，**不重复** `docs/ARCHITECTURE.md`
  的十槽口径；槽清单仍以 `driver.ts` 的 `HarnessCapability` 为唯一权威。
- 落地过程中产生的**带日期裁决**（例如"为什么 zcode 不注册 `promptInbox`"、
  "TUI 键位表实测结果"、"C1 复核结论"）按仓库约定写进 `docs/DECISIONS.md`，
  不留在本目录。
- 抽象缺口（R 批次）修完后，`CLAUDE.md` 的 Architecture 节需要补两处：
  ①`AssetSurface` 兼管 MCP 读写；②`generateHookHandler` 按 harness 参数化、
  上下文里「hooks 只能用户级」这类 zcode 事实各归各句。**只在 R/P 批次落完时**改，
  计划期不动 `CLAUDE.md`。
- **不新增抽象**：本计划全程不需要第 11 个能力槽、也不需要新的抽象类。唯一"扩"的
  是 `AssetSurface` 加三个方法——这一条已经项目所有者裁决。
