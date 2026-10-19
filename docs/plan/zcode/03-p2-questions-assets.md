# P2：ZCode 问答 + 资产装面

> 目标两件事：①dashboard 能远程回答 zcode 的阻塞模态框（AskUserQuestion / 计划确认 /
> 权限确认）；②MCP 服务器与技能能在 zcode 两个 scope 装卸。
>
> 依赖：R3（MCP 写侧能力化，**硬前置**）、P0、🔬3。

## 一、问答（`weave-harness/src/zcode/questions.ts`）

### 1.1 三类交互在 ZCode 上的形状

| 交互 | claude 的信号 | **zcode 的信号** |
|---|---|---|
| AskUserQuestion | `PreToolUse(AskUserQuestion)`，toolInput 带全问题面 | 同一工具名（`ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion"`）、同一 input 形状（`contracts/src/tools/ask-user-question.ts`，含 `preview`） |
| 计划确认 | `PreToolUse(ExitPlanMode)`，**toolInput 恒空** → 合成三选项 | 同一工具名，但 **`ExitPlanModeInputSchema` 要求 `plan` 字段**（`contracts/src/tools/plan-mode.ts:55`）⇒ toolInput **不空** |
| 权限确认 | `Notification` 事件 + `raw.notification_type === 'permission_prompt'` | **`PermissionRequest` 事件**，且**自带工具面**（`toolName` / `toolInput` / `riskLevel` / `reason` / `requestId`） |

结论：ZCode 的三个信号都不比 claude 弱，权限那条还更强（精确事件 + 直接带工具面）。

### 1.2 权限确认的落法：用 `eventQuestion`，**不扩抽象**

`BlockingPromptSpec`（`driver.ts:313-345`）现有的权限入口是
`permissionNotificationType`（`Notification` 的 `raw.notification_type`），ZCode 没有
`Notification` 事件 ⇒ 该字段填 `null`。

但要能置位，所以用**同一个规格里已有的** `eventQuestion`：

```ts
permissionNotificationType: null,
eventQuestion(eventType, raw) {
  if (eventType !== 'PermissionRequest') return null;
  return permissionQuestionFrom(raw);   // 用 PermissionRequestHookInput 的工具面直算
},
```

为什么这是合法的而不是硬凑：`eventQuestion` 的契约原文是「**不是工具、也非权限提醒**
的对话框」——ZCode 的 `PermissionRequest` 是宿主主动问人、带完整工具面、答案会被宿主
消费的一个**事件级**模态框，生命周期语义（事件到达即置位、后续任何非 Notification
事件即了结）与 `eventQuestion` 的既有实现完全一致，故复用它**零抽象改动**。

同时必须写清的两条（写进 `docs/DECISIONS.md`，因为是 harness 事实而非计划）：

- **不登记"静默模式"名单里的猜**。`silentPermissionModes` 只放**结构上不可能弹框**的
  模式。ZCode 的模式词表 = `plan | build | edit | yolo | guarded | auto`
  （`contracts/src/interfaces/session.port.ts:32`）。今天只能确定 `yolo`
  （不限制、不问）结构上不弹 ⇒ `['yolo']`；`auto`（风险分类器）**可能仍落到人**，
  不进名单。其余三档都会问。🔬3 复核。
- **不做 claude 那条 6 秒噪声闸**。claude 的 `Notification(permission_prompt)` 是
  阻塞工具 `PreToolUse` 之后 ~6s 补发的，所以要丢；ZCode 的 `PermissionRequest`
  是**独立、及时**的置位信号，没有这个噪声问题。别把 claude 的闸搬过来——搬了会
  把真对话框丢掉。

### 1.3 问题面解析

`parseQuestions(toolName, toolInput)` 的 zcode 实现与 claude **同形不同源**
（harness 知识各写一份，不互相 import —— 两家的 TUI 键位是独立事实）：

- `AskUserQuestion`：解析 `questions[]` 的 `question` / `header` / `options[].label`
  / `description` / `multiSelect` / `preview`。ZCode 的 schema 是 `.strict()` 且
  `preview` 有自校验（`validateAskUserQuestionPreview`），故非法预览不会出现在
  toolInput 里 —— 归一化逻辑（超长/隐形字符 → withhold）仍需保留，判据与 claude
  同值（2000 字符、`INVISIBLE_CHARS` 集）。
- **预览形态**判据相同：单选 && 任一选项带 `preview` ⇒ 左右分栏形态（数字只挪高亮、
  回车提交、`n` 进备注框）。
- `ExitPlanMode`：toolInput **带 `plan`**（不像 claude 恒空）⇒ **先把 `plan` 文本
  放进问题面**（`question` = plan 摘要或首行 + `header: 'Plan approval'`），
  选项仍合成三条（ZCode 的 TUI 选项行待 🔬3 定，暂沿用 claude 的三条文案）。
- 解析不出任何问题 → `OPAQUE` 兜底（「看得见阻塞、无远程作答面」），不猜。

### 1.4 键序：唯一需要实机取证的地方（🔬3）

`composeAnswerAtoms`（server，`hooks/answer-keys.ts`）把「整份 answers」拼成
**原子键序**，然后经层② 终端的 `sendKeys` 打进 pane。它能拼对的前提是
**host TUI 的键位表**——而那是 harness 事实：

- 数字 = 选中即推进 / 只勾选（单选 vs 多选）；
- Tab = 下一个 tab；收尾屏 Submit 的进入方式；
- Other 行（`n+1`）与 Chat 行（`n+2`）的走位键；
- 预览形态的 `commit` 回车。

claude 那张表是 2.1.296 实机验出来的。**ZCode 的 TUI 是另一套实现**（`packages/tui/`），
不能假定相同。⇒ **🔬3 是 P2 的硬前置**：在真终端里把一张哑表验一遍
（无头窗口 + `sendKeys` 逐键 + 截图/转录确认落点），把结论写进
`weave-harness/src/zcode/questions.ts` 的顶部注释，再实现。

**若 🔬3 证明键位与 claude 相同**：`zcode/questions.ts` 直接按 claude 的表实现。
**若不同**：只改 zcode 模块里的键常量，**不动 server 的 `composeAnswerAtoms`**
（它是「按原子下发」的通用拼装器，键语义来自 spec 产出的 `options[].keys`）。

### 1.5 降级面（P2 不做）

- `eventQuestion` 的 claude 分支（`PreModelSwitch` → 「Switch model?」）在 zcode 上
  没有对应事件 ⇒ zcode 实现里不出现。
- `question.pending` 帧、三腿提醒（toast / 浏览器通知 / Web Push）、作答入口
  （会话行图标 / 组头 tag / 事件链 tag / 对话窗尾部「回答」）**全部复用**，
  零 web 改动——它们都按「待答面在场」判，不认 harness。
- `HARNESS_LIFECYCLE.zcode.questionTools` 已由 P0 落，`BlockingPromptSpec.blockingTools`
  **引用同一张表**（谁是问答工具只说一处）。

## 二、资产装面（`zcode/assets.ts` 补 mcp 读写）

### 2.1 ZCode 是第一个「非 claude 且有项目级 MCP」的 harness

| scope | 落点 | 出处 |
|---|---|---|
| project | `<project>/.zcode/config.json` 的 `mcp.servers` | `adapters/src/config/schema.ts:112`（`mcpSchema = z.object({ servers: z.record(...) })`）+ 项目配置发现候选 `zcode.json` / `.zcode/config.json`（`shared/src/workspace-hook-config.ts:176-177`） |
| user | `~/.zcode/cli/config.json` 的 `mcp.servers` | `file-config.adapter.ts:61-62` |

⇒ `mcpScopes()` = `['project','user']`。这一条**正是 R3 的价值证明**：codex 只能
user（TOML、单一落点），claude 两档 JSON 分文件，zcode 两档同形 JSON、**同一份
schema 服务两个文件**。三家的形状真的三家不同——写死二分在加 zcode 时必然爆。

### 2.2 实现（R3 的能力方法）

```ts
// weave-harness/src/zcode/mcp.ts
export async function readZcodeMcp(file: string): Promise<Record<string, McpServerConfig>>
export async function upsertZcodeMcp(file: string, name: string, cfg: McpServerConfig): Promise<void>
export async function removeZcodeMcp(file: string, name: string): Promise<boolean>
```

表示法：`ZCodeConfigFileSchema` 是 `.passthrough()`，`mcp` 是 `.strict()` 的
`{ servers }` ⇒ **只改 `mcp.servers` 这一个键、其余原样保留**（与 weave 改
`.claude/settings.json` 的纪律同款：读全文 → 只动自己那一支 → 写回）。
`McpServerConfig` 的 `{command,args?,env?}` 形状对 ZCode 的 stdio server 成立；
远端 `url` 型 server 不在 weave 的装面里（claude/codex 同样只做 stdio）。

`AssetSurface` 三方法：

```ts
mcpRead(scope, projectPath, homedir)  → readZcodeMcp(mcpFileOf(scope, projectPath, homedir))
mcpWrite(scope, projectPath, homedir, name, cfg) → upsertZcodeMcp(…)
mcpRemove(scope, projectPath, homedir, name)     → removeZcodeMcp(…)   // false → 404
```

`mcpDest(scope, homedir)`：project → `.zcode/config.json`（项目内相对路径，posix）；
user → `~/.zcode/cli/config.json` 绝对路径。web 按行渲染提示、不自拼。

### 2.3 技能与其它 file asset

| 面 | 落法 | 出处 |
|---|---|---|
| 项目 skills | `.zcode/skills` | `adapters/src/skills/roots.ts` 的 `skillRootsForBase` → `<base>/.zcode/skills` |
| 全局 skills | `[~/.zcode/skills]`，只读遗留根 = `~/.agents/skills`（同 `skillRootsForBase` 的第二项） | 同上 |
| 裸表面包的 commands/agents | **P2 不做**，🔬 后另议 | ZCode 有 `~/.zcode/commands`（`packages/ui/src/settings/commandsSettingsShared.ts:22`）与 `.zcode/agents/*.md`（`packages/services/src/subagents/subagentMarkdown.ts:104`），但**项目级是否存在、文件名约定、frontmatter 契约**都未取证 |

⇒ `targetDir()` 对 `command` / `agent` / `workflow` / `rule` / `output-style` 一律抛错
（= 无该面）。R4 的 toolkit 循环因此会自然跳过 zcode 的那几个类别——**这就是 R4 的
价值**：不写死 claude，多一个 harness 也不用改 toolkit。

### 2.4 插件市场：留位，不实现

ZCode 有 `plugins` 配置面与 `.zcode-plugin/plugin.json`（`bootstrap/src/app/bundled-plugins.ts:360`），
体量与 claude 的 `.claude-plugin/` 同级但**格式不等同**。P2 不接：
`PluginSurface` = null、`PluginStateSurface` = null。
R4 里那批 `isCcPluginPack(pack) && targets.includes('claude')` 的判断**因此保持不动**
（它们判断的是「这个包是 CC 插件」= claude 独有机制，不是「是不是 claude」）。

## 三、验收

### 问答

1. 起一个 zcode 会话，让它调 `AskUserQuestion`（两问、第二问多选）→
   dashboard 会话行出提问角标、组头「问答 ×n」计数 +1；弹窗逐问渲染、未答完禁用提交；
   提交后键序打进 TUI，宿主模态框按所选推进，会话继续。
2. 单选一问 → 弹窗不出收尾屏、点行即答（`n≥2 || 多选` 才有收尾屏）。
3. 带 `preview` 的单选问 → 左右分栏形态、点行只挪高亮、底部发送键提交。
4. 权限确认：让工具触发权限框 → `PermissionRequest` 到达即出问题面、带工具名；
   选「拒绝」后宿主不再执行该工具（**不是**把「别再问」打成「拒绝」）。
5. `ExitPlanMode` → 弹窗显示 plan 文本 + 三选项（🔬3 定了就按定的）。
6. pane 找不到（关窗口）→ 409「Session pane not found」，不误注入。
7. `markAnswered` 后模态框已关：PostToolUse 到达整条清除，无残留问题。

### 资产

8. 项目档装一个 MCP server → `.zcode/config.json` 的 `mcp.servers` 多一条、
   **文件其余键逐字不变**；`zcode` 起会话能用该 server。
9. 用户档装同一个 → `~/.zcode/cli/config.json`，不影响项目档；两档同名互不覆盖。
10. 卸载 → 该条消失、返回 200；再卸一次 → 404。
11. `GET /assets` 里 zcode 的 MCP 行 `installScopes === ['project','user']`，
    web 的 scope 选择器两档都可选（**这是 R3 后的表驱动结果**，web 无 zcode 字面量）。
12. 全局技能装/卸 → 落 `~/.zcode/skills`，软链形态与 claude 同款。

## 四、提交切分

| 提交 | 内容 | 前置 |
|---|---|---|
| P2-1 | `zcode/assets.ts` 的 `mcpScopes/mcpDest` + `zcode/mcp.ts` 三个表示法函数 + 单测（纯文本层） | R3 完成 |
| P2-2 | `AssetSurface.mcpRead/Write/Remove` 的 zcode 实现 + server 侧表调用打通（应零 server 改动） | P2-1 |
| P2-3 | `zcode/questions.ts` 的 `parseQuestions` + 权限面（`eventQuestion` 复用）+ spec 注册 | 🔬3 |
| P2-4 | 🔬3 结论落地：键位表（如需改只改 zcode 模块）+ 顶部注释记录实测 | P2-3 |
| P2-5 | `zcode/assets.ts` 的 skills 面（`targetDir` / `globalSkillsRoots`）+ 全局技能链路 | — |

🔬3 的实测记录与裁决写 `docs/DECISIONS.md`（带日期 + 宿主版本号）。
