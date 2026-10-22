# P2 — 问答/审批与资产面

> 批目标：dsh 会话卡在审批或 `ask_user_question` 时，weave 的待答弹窗能答；项目
> `.dsh/skills` 能装能卸；MCP / 插件市场面对 dsh **诚实置灰并说明原因**。
>
> 硬前置：P1 的插件桥已通（作答走同一条桥）、🔬9 已取证。

---

## §1 阻塞面：dsh 的三种「会话在等人」

| dsh 形态 | durable 事实 | 性质 |
|---|---|---|
| **工具审批** | `approval/asked { id, toolName, callId?, reason? }` → `approval/decided { id, outcome }` | approval 记录是 **log-only**（不是 surface 事件），`id` 成对 |
| **结构化提问** | `tool/call` 里 `name = 'ask_user_question'` + `tool/result` | 普通工具调用，工具名是 dsh 知识 |
| **权限策略切换** | `approval/policy { policy, source? }` | 不是「在等」，是切换记录 ⇒ 不当阻塞面 |

与 claude 的根本差异：**dsh 的作答是结构化 API，不是模态框键序**。所以
`keys`/`textFocus`/`textTail`/`submit` 这一整套原子键序在 dsh 上全部不适用——
这是简化，不是缺失：不用猜宿主键位，也不会把键序打歪。

---

## §2 `questions` 槽（`weave-harness/src/dsh/questions.ts`）

`BlockingPromptSpec` 的填法：

```ts
blockingTools: ['ask_user_question'],
permissionNotificationType: null,      // dsh 没有 Notification 事件
silentPermissionModes: [],             // 静默模式名单待 🔬（dsh 的 permission preset）
permissionQuestion(ctx) → 用 approval/asked 的 toolName/reason 合成一个问题面，
                            选项 = 宿主自己的三档（Allow once / Allow always / Deny，🔬 取原文）
parseQuestions(toolName, toolInput) → ask_user_question 的 toolInput 归一化（同 claude 的
                            解析口径，但不产键序，只产「问题 + 选项文案 + 多选」）
eventQuestion(eventType, raw) → eventType === 'approval/asked' 时返回问题面
```

### 需要的两处 driver 扩展（`00` 待裁决清单里的 D4 / D5）

| 编号 | 扩展 | 为什么 |
|---|---|---|
| **D4** | `BlockingQuestionOption.keys` 允许空数组，`BlockingPromptSpec` 加 `answerKind: 'keys' \| 'structured'` | dsh 没有键序；server 的 `MessageDeliverer.answer` 按 `answerKind` 分派：`keys` → 现行为（`composeAnswerAtoms` + `sendKeys`）；`structured` → 把 `answers[]`（questionKey + 选项下标 + 文本）原样经插件桥发过去。**web 侧零改动**（它本来就只发结构化 `answers[]`，键序是服务端的事） |
| **D5** | 收尾的「失败标记」允许来自 payload | dsh 的一轮成败都在**同一个**收尾事件 `turn/end` 上（`reason.kind`），表里 `closeFailed` 只能写事件名，表达不了「同名事件、成败看载荷」。改法 = web 的 `failed` 判据取「`closeFailed` 含该事件 **或** 归一化 payload 带 `failed: true`」（一个通用键，adapter 负责填） |

> D4 的替代方案是「给 dsh 单独一路作答路由」，那会把「作答」变成两套实现——
> 现成路径已经把结构化答案递到服务端了，多一分支比多一条路由便宜。

### 状态机（`QuestionTracker`）

现存的置位/清除判据是 claude 形状（PreToolUse / Notification / 任意非 Notification
清除）。dsh 需要：

- **置位**：`approval/asked`（走 `eventQuestion`）与 `ask_user_question` 的 `tool/call`
  （走 `blockingTools`）；
- **落定**：`approval/decided`（同 `id` 消失）与 `tool/result`（同名工具）。

⇒ `QuestionTracker` 多一条 harness 提供的落定判据（同 D5 一样是「同一事件类型看载荷」的问题，
**建议合并成同一个可选方法 `settlesOn(eventType, raw, phase)`**，一次改完，不要两次形状）。
`seedFromDb` 重放最近 12 事件时，dsh 的判据同样适用（`approval/asked` 无对应 decided
= 仍在等）。

---

## §3 资产面（`weave-harness/src/dsh/assets.ts`）

dsh 的资产落点比 claude 少，但更清楚（`docs/subsystems/skills.md:70-74` 的 rank 表）：

| 面 | 项目级 | 用户级 | weave 怎么用 |
|---|---|---|---|
| **skills** | `<project>/.dsh/skills`（rank 100，dsh 自有） | `$DSH_HOME/skills`（rank 400） | 安装写这两处；`.agents/skills`（rank 200）与 `<agentsHome>/skills`（rank 500）是**多工具共享根**，只读枚举、不写入（同 codex `globalSkillsRoots` 的 [0]=写 / 其余=只读先例） |
| **指令文件** | `AGENTS.md` | `$DSH_HOME/AGENTS.md` | init 的 `AGENTS.md → CLAUDE.md` 链接**已经覆盖**，P2 不动 |
| **command / agent / workflow / rule / output-style** | 无 | 无 | `targetDir()` 抛「无该表面」（`FILE_ASSET_SPECS` 只加 `dsh` 的键到 skills 相关行，其余不加） |
| **MCP** | 无 | 仅 profile 的 `cordis.patch.yml`（一行一个 `mcp-client`） | `mcpScopes() → []`：**置灰并说明「dsh 只在 profile 级声明 MCP，写入会波及该 profile 下所有项目」** |
| **插件市场** | — | dsh 自己的 bundle 体系 | `plugins` 槽不注册、`pluginState` 不注册；weave 的资源市场不接管 dsh 的插件（两套插件模型不该硬并） |

`$DSH_HOME` 必须**运行时读环境变量**（缺省 `~/.dsh`）；`HARNESS_DIRS.dsh.userDir='.dsh'`
只用于展示与「无 env 时的缺省」，不得当成硬路径（`AssetSurface` 的 `homedir` 参数
只是回落基）。

### skills 安装/卸载语义

- 装 = 写 `<target>/<name>/SKILL.md`（+ 附带文件），与现有 `installLinked` 流程一致；
- 卸 = 只删 weave 装的那份（带标记才删，同 `pruneUnreferenced` 的纪律）；
- 重名冲突：dsh 的 rank 决定谁生效（100 压过 200/400/500），weave 只往 rank 100/400 写，
  于是「weave 装的」在 dsh 里必然生效——不给用户「装了但不生效」的假象。

---

## §4 旁路会话 / 状态栏 / 会话控制

| 面 | 结论 |
|---|---|
| `sideQuestion` | **null**（dsh 无 `/btw` 对等物；`unsupportedReasons.sideQuestion` 写明） |
| `statusline` | 槽不注册（dsh 的 statusline 是 web UI 自己画的，没有外部注入面） |
| `HARNESS_SESSION_CONTROL` | `modeNames` 待 🔬（`permission/preset` 的取值表）；`modelNames` 留空（具体模型 id 不进表，同 claude 口径）——先诚实空着，UI 不显示模式/模型切换按钮 |
| `resume` | **null**（没有可起的交互会话，见 `01` §6） |
| `capture` | 脚本面为空；采集健康走 `capture.logs`（R1） |

---

## §5 验收

1. dsh 里触发一次工具审批 → dashboard 会话行出现 amber 问答图标 → 弹窗显示工具名与
   三档选项 → 选「允许」后 dsh 里的回合继续；`approval/decided` 到达后弹窗自动消失。
2. `ask_user_question` 多问题面：多选 + 文本行都能作答；答完 dsh 侧看到的答案与
   dashboard 一致（不是键序模拟的近似）。
3. 同一会话连续两次审批：第二次的 `id` 与第一次不串（同 id 判据单测）。
4. 从资源市场（`LibraryPanel`）把一条 skill 装到该项目，落在
   `.dsh/skills/<name>/SKILL.md`，dsh 的 skill 列表里能看到；卸载后消失，且不误删
   用户自己放的同名目录。
5. MCP 页签对 dsh 置灰，tooltip/说明给「profile 级」的原因；`GET /capabilities` 的矩阵
   与 UI 一致（无第二事实源）。
6. 设置页「状态栏」对 dsh 不显示注入开关。

---

## §6 明确不做

- **不接管 dsh 的插件市场**：`dsh.bundle` / `cordis.patch.yml` 是 dsh 自己的分发体系，
  weave 的资源市场只管 skills/MCP/toolkit，两套不并（要并另立项目）。
- **不写用户的 `cordis.patch.yml` 做 MCP**（除 P1 那一行 weave 桥 bundle，那是
  weave 自己的产物、可摘干净）。
- **不做 dsh 的「团队/子代理」问答面**：`team/*` 全丢（`01` §3），其审批面在 P3 之前不碰。
