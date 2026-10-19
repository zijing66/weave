# 实测前置（🔬）

> 本目录里所有「待取证」的地方集中在这里。每条写清：**问什么、怎么问、判据、
> 阻塞哪批、结论写哪**。取证结论不回写本文件（本文件只留方法），按仓库约定
> 写进 `docs/DECISIONS.md`（带日期 + 宿主版本号）。

## 0. 环境准备（一次性）

当前本机**没装 zcode**（`which zcode` 为空、无 `~/.zcode`），所以全部 ZCode 结论都
来自源码静态阅读。开工前先：

1. 装 ZCode CLI，`zcode --version` 记下版本号（写进 DECISIONS），**后续每条取证都
   标注这个版本**。
2. 确认 `zcode` 在 PATH 上的形态：
   ```bash
   which zcode && ls -la "$(which zcode)"   # win32 下是 zcode.cmd shim 还是 .exe
   ```
   ⇒ 决定 `ResumeCommandSpec.bin = 'zcode'`、`promptStdin`、以及「win32 走 shell」
   那套是否要沿用 claude 的处理（claude 的 `.cmd` shim 必须经 shell 启动）。
3. 在一个**测试项目**里跑 `weave init --harness zcode`，不要拿活项目试
   （memory `weave-dbpath-no-override`：冒烟脚本会污染活库）。

## 已结案

### ✅ C1（原 🔬1）ZCode 的项目级 hooks 在 TUI 里跑不跑 —— **不跑**

结论：**TUI / CLI 路径下，项目 `.zcode/config.json` 的 hooks 恒被拒，采集必须写
用户级配置 `~/.zcode/cli/config.json`。**

证据链（静态、三条互证）：

1. `adapters/src/config/config-factory.ts:230`：
   `// Project Hook events stay outside this executable merge. The snapshot above is
   the only Phase 1 side-channel and cannot be consumed by configured-runner.`
2. 项目 hooks 改走信任通道：`core/src/hooks/configured-runner.ts:76-99` 给每条挂
   `admission` 求值器。
3. 求值器在开关未开时直接拒：`core/src/hooks/workspace-hook-runtime-admission.ts:132-140`
   ```ts
   if (!this.activated) return { allowed: false, reasonCode: "workspace_hooks_pending_trust" };
   if (!this.enabled)  return { allowed: false, reasonCode: "workspace_hooks_feature_disabled" };
   ```
   而 `enabled = workspaceHookTrustEnabled === true`，**只有 protocol server 传 true**
   （`bootstrap/src/zcode-protocol/server-operations.ts:3546`）；CLI 不传
   （`bootstrap/src/app/types.ts:219` 可选、`create-app.ts:342` 原样透传）。

⇒ 落法已在 [`01-p0-capture.md`](./01-p0-capture.md) 第 0、1 节定死。
**复核项**：ZCode 升级后重跑一次（它明说是「Phase 1」，后续可能开闸）。
复核通过（项目 hooks 开始生效）时的动作：`weave init` 恢复项目级写入，
用户级条目降级为「兼容存量」。届时的首选仍是**用户级单入口 + 按
`CLAUDE_PROJECT_DIR` 分流**——它一份配置服务全部项目，不需要每次 init 改宿主配置。

## 阻塞 P0

### 🔬2 `Stop` 的 `last_assistant_message` 是不是全量

- **问什么**：对话面板每轮总结取 `raw.last_assistant_message`
  （`createCompatibleHookStdin` 里 `compatible.last_assistant_message =
  input.responseText ?? input.responsePreview`）。`responseText` 是可选字段
  （`contracts/src/hooks/index.ts:127-133`），若宿主只填 `responsePreview`（截断版），
  对话面板的「每轮最终总结」就是残句。
- **怎么问**：起会话让它写一段 > 2000 字的长回答 → 看
  `<dataDir>/hooks/inbox/<shard>.jsonl` 里那条 `Stop` 行的 `raw`，
  比对 `responseText` 有无、长度、是否等于终端里看到的全文。
- **判据**：
  - `responseText` 存在且 ≈ 全文 ⇒ 直接可用，P0 无附加工作。
  - 只有 `responsePreview` ⇒ 面板仍是「有内容但截断」，**不阻塞 P0**
    （降级可接受）；但要在 `docs/DECISIONS.md` 记一句，并且**不要**去猜「从 SQLite
    补全文」——那是扩展，不在 P0~P2。
- **阻塞哪批**：P0（只影响面板质量，不影响列表/事件链）。

## 阻塞 P1

### 🔬4 `zcode -p` 的 stdin 与 TUI 的粘贴/注入面

三小问，一次会话里全测：

1. **`-p` 能不能从 stdin 读 prompt**（决定 `headless` 通道能不能开）：
   ```bash
   echo "say hi" | zcode -p --output-format text
   ```
   出答案即通。注意 `arguments.ts` 里 `-p/--prompt` 是**取值**型参数——若必须带值，
   就只能写 `zcode -p "…"`（命令行含用户内容 ⇒ win32 上不可经 shell 启动 ⇒
   `headless` 保持 null）。判据：**命令行走 stdin 无位置参数时是否工作**。
2. **TUI 认不认 bracketed paste**（决定层② 打原文的配方）：往输入框粘贴一段含换行
   的多行文本，看它是「整段进框、不自动提交」还是「逐行提交」。前者 = 认。
3. **user hook 返回的 `additionalContext` 宿主是否应用**（决定 `inject` 通道）：
   在 `~/.zcode/cli/config.json` 加一条只对 `PostToolUse` 生效的 process hook，
   输出 `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"WEAVE-PROBE"}}`，
   下一轮对话里问模型「上一轮注入的探针字符串是什么」。
   注意 `contracts` 的联合类型**声明**支持（`index.ts:180-183`），但类型不等于实现。
- **判据**：1、3 任一为否 ⇒ 对应通道保持 null（`unsupportedReasons` 写原因），
  P1 验收里的对应条目划掉，**不静默降级**。2 为否 ⇒ 层② 改逐字符写入（现有
  `sendKeys` 那套），并把它记进 `TerminalBackend` 的既有分派，不在 zcode 模块分叉。
- **阻塞哪批**：P1。

### 🔬5 Windows 上的 pane 定位 pid

- **问什么**：`wt` 后端的定位键是 `CLAUDE_PID`（会话进程 pid），ZCode 不导出该键
  （`configured-runner-input.ts:79-85` 只有 session/project/plugin 四类）。
  计划里的回落是 `String(process.ppid)`——但 Windows 上 hook 子进程的父进程
  **可能是 cmd.exe 而不是 zcode 会话进程**。
- **怎么问**：在 Windows Terminal 里起 zcode 会话，用户级 hook 里加一条临时进程
  打印 `process.ppid` / `process.env.WT_PROFILE_ID` / `process.env.WT_SESSION`；
  同时用 `wmic process where processid=<ppid> get name,commandline` 看它是什么。
- **判据**：ppid 的进程名是 zcode/zcode.exe ⇒ 回落成立；是 cmd.exe/powershell.exe
  ⇒ 需要沿父链上溯一次（`wtPanePidFromEnv` 的纯函数里做，pid 须仍存活）。
  🔬 同时确认 `CLAUDE_PID` 真的没有（别假定）。
- **阻塞哪批**：P1（只影响 wt 后端的 pane 定位；wezterm/konsole/iterm 走 env 不涉及）。

## 阻塞 P2

### 🔬3 TUI 阻塞模态框的真实键位表（P2 硬前置）

- **问什么**：数字 / Tab / 回车 / 上下键在 ZCode 的 `AskUserQuestion`、计划确认、
  权限确认、以及**预览形态**分栏里的确切含义。claude 那张表是 2.1.296 实机验的
  （`zcode/questions.ts` 不能照抄），ZCode 的 TUI 是另写的一套（`packages/tui/`）。
- **怎么问**：哑 pane 法（memory `weave-keys-injection-verification`）——
  起一个真实的 zcode 会话让它停在模态框上，用层② 的 `sendKeys` 一次发一个键，
  每发一键看屏幕上光标/高亮/勾选怎么变。要验的最小集：
  1. 单选数字 = 选中即提交整 call？
  2. 多选数字 = 只勾选？提交是 Tab 还是别的？
  3. 多问时 tab 条怎么走、收尾屏是怎么进的；
  4. Other 行（自定义输入）与「Chat about this」行的走位键；
  5. 预览形态：数字只挪高亮？回车提交？`n` 进备注？
  6. 权限框的行数（2 行还是 3 行、第 2 行是「别再问」还是「拒绝」——**这条错了
     会把「批准」打成「拒绝」**）。
- **判据**：得到一张与 claude 对照的键位表。**相同就照抄，不同就改 zcode 模块里的
  键常量**；无论哪种，把表写进 `zcode/questions.ts` 顶部注释 + `docs/DECISIONS.md`。
- **阻塞哪批**：P2（P2-3 之后、P2-4 之前）。

### 🔬7 权限模式里哪些结构上不弹框

- **问什么**：`silentPermissionModes` 要放「结构上不可能弹框」的模式。
  ZCode 词表 = `plan | build | edit | yolo | guarded | auto`
  （`contracts/src/interfaces/session.port.ts:32`）。计划里只敢放 `['yolo']`。
- **怎么问**：每档下让模型执行一条必然被拦的命令（如 `rm -rf /tmp/x`），看有没有
  弹框 / 有没有 `PermissionRequest` 事件。
- **判据**：确实不弹的档才进名单。**宁可少放不可多放**：放多了会把真对话框当噪声丢掉
  （用户看不到、会话卡死）；放少了只是多一条 `PermissionRequest` 被记成问题面。
- **阻塞哪批**：P2（求值 `permissionQuestion`/`eventQuestion` 的噪声闸）。

### 🔬8 项目级 MCP 是否真被宿主读取

- **问什么**：信任门只管 hooks（C1），但要用一次实机确认**项目
  `.zcode/config.json` 的 `mcp.servers` 确实生效**——否则 `mcpScopes()` 就该是
  `['user']`（像 codex 那样）。
- **怎么问**：往测试项目的 `.zcode/config.json` 写一个 stdio MCP server（用一个
  必定能起的小 server），在那个目录里起 zcode，问模型有哪些工具。
- **判据**：工具列表里出现该 server 的工具 ⇒ `['project','user']` 成立。
  不生效 ⇒ `['user']`，P2 的验收第 8、11 条改成 user 单档。
- **阻塞哪批**：P2。

## 不阻塞任何已承诺批次（P3 实验项的前置）

### 🔬6 手写的 mailbox envelope 能否被 drain

- **问什么**：往 `~/.zcode/mailbox/<sid>/unread/` 手写一条
  `{version:1, messageId, fromSessionId, toSessionId, content, createdAt}`，
  宿主在下一个 `UserPromptSubmit` / `PostToolUse` / `Stop` 时会不会 drain 出来、
  变成上下文里的 `<session-message source="mailbox">` 块。
- **怎么问**：见 `adapters/src/mailbox/index.ts:67-83` 的校验（`version===1`、
  六个字段都要有；`fromSessionId` **只查类型不查格式**，故可以填 `weave`）。
  写一条 → 在 TUI 里随便发一句话 → 看模型是否提到该内容；同时看文件是否被
  `rename` 到 `read/`。
- **判据**：能 drain ⇒ P3 可行（但 P3 还要先回答 [`02-p1-messaging.md`](./02-p1-messaging.md)
  §7 提的两个问题：**回执口径**与 **`read/` 增长处置**，否则不做）。
- **阻塞哪批**：无（P3 不在承诺范围）。

## 汇总表

| 编号 | 未知量 | 阻塞 | 现状 |
|---|---|---|---|
| C1 | 项目 hooks 在 TUI 下跑不跑 | P0 | ✅ 已结案（不跑） |
| 🔬2 | `Stop` 的 `last_assistant_message` 是否全量 | P0 | 待测（不阻塞开工） |
| 🔬3 | TUI 模态框键位表 | P2 | 待测（**硬前置**） |
| 🔬4 | `-p` stdin / bracketed paste / `additionalContext` | P1 | 待测 |
| 🔬5 | Windows hook 的 ppid 是否 zcode 进程 | P1 | 待测 |
| 🔬7 | 哪些权限模式结构上不弹框 | P2 | 待测 |
| 🔬8 | 项目级 MCP 是否生效 | P2 | 待测 |
| 0 | `zcode` 安装形态与版本 | P0 | 待装 |
