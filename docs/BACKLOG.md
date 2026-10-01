# Weave Backlog — 待完善计划

本文件记录 Claude Code × Codex 双 harness 支持的调研结论：**低难度共性功能已全部实现**（见文末「已完成」），高难度或依赖外部 schema 稳定的功能列入此处，按优先级与前置条件排列。

调研基线：2026-08 官方文档（Claude Code settings/skills/plugins 文档、Codex config.toml 与 AGENTS.md 标准）。

---

## 2. Codex hooks（config.toml 实验性）

**目标**：把 weave 的 hook-handler 接入 Codex 的事件系统。

**为什么难**：Codex hooks 是实验特性，config.toml schema 仍在演进（事件名、payload 结构、退出码语义都可能变）。

**建议方案**：等官方 schema 稳定后再接入；届时在 `packages/weave-server/src/hooks/adapter.ts` 旁边新增 `codex-adapter.ts`，走与 `ClaudeCodeAdapter` 相同的 `HookAdapter` 接口。不预先实现，避免追着 schema 改。

---

## 3. Claude plugins marketplace 深度管理（P2）

**现状**：已实现插件扫描 + 双端 enable 切换（Claude `settings.json` / Codex `config.toml`），即 `readGlobalSkills` 的四个分组 + `plugins/enabled` 路由。

**待完善**：
- marketplace 的添加/移除（`plugin marketplace add <git-url>` 等价操作）
- 插件的安装/卸载/更新（当前只管理已有插件的 enable 状态）
- `.claude/plugins/` 缓存目录的清理

**为什么难**：插件安装涉及 git clone 与 marketplace 信任链，需要安全策略层（见第 6 项）先行。

---

## 4. LSP 配置注入（`.lsp.json`）

**目标**：init 时生成 `.lsp.json`，为项目注入语言服务器配置。

**为什么难**：需要按项目技术栈（package.json / pyproject.toml / go.mod 探测）选择 server 与启动参数，本质是「项目类型检测 + 模板」的组合，检测矩阵大。

**建议方案**：扩展 `weave-core/src/platform.ts` 的检测器（`detectProjectStack()`），模板放 `weave-templates`，与 skills 同管线安装。P2 之后。

---

## 5. `AGENTS.override.md`（Codex 特性）

**目标**：支持 Codex 的子目录级指令覆盖文件（`<dir>/AGENTS.override.md` 强制覆盖父级）。

**为什么难**：weave 的 AGENTS.md 生成遵循「用户文件仅追加合并」策略（`weave:start/end` 标记块），override 文件的语义是完全替换，两套合并语义并存容易混淆；且官方对该文件的支持仍在演进。

**建议方案**：暂不生成，仅在 status/doctor 中识别并提示其存在。

---

## 6. 安全策略层（P2，路线图遗留）

- MCP 安装白名单（`mcp-policy.json`，参考 ruflo 的 `.harness/mcp-policy.json`）
- 插件 marketplace 信任链
- Helper 脚本签名验证（`helper-signing`）

见 `CLAUDE.md` Phase 3 路线图，此处不重复。

---

## 7. statusline 脚本内嵌 Ink（已裁决，搁置）

**结论**：statusline 生成脚本保持**零依赖单文件**（`statusline.cjs` 由 `generator.ts` 生成，stdin JSON → stdout ANSI，一次性执行）。Claude Code 的更新由其自身机制驱动：每次 assistant response 后重跑（~300ms debounce）+ `refreshInterval`（默认 10s）空闲定时重跑。

**为什么不内嵌 Ink**：statusline 脚本由 Claude Code 每次交互重新 spawn，React reconciler 的启动开销（~200ms+）会显著拖慢每次交互的渲染；且 `node_modules` 依赖破坏脚本的零依赖可移植性。

**已落地的替代**：`weave statusline preview`（`packages/weave-cli/src/statusline/preview.tsx`）用 Ink 做交互式 TUI 预览——运行**真实生成脚本**、解析其 ANSI 输出重渲染，`w` 一键写回配置。

---

## 7b. statusline 渲染对齐 ccstatusline（已完成的部分）

调研 `D:\GitRepo\public\ccstatusline`（v2.2.12，MIT）的渲染机制后落地的调整：

| 借鉴点 | weave 实现 |
|--------|-----------|
| Powerline 桥接配色（join glyph 的 fg = 前块 bg、bg = 后块 bg；相邻同色时用前块 fg 保持视觉合并） | `generator.ts` `renderLine` |
| 行首/行尾 cap（`` / ``，fg = 首/末块 bg、背景透明） | `generator.ts` `renderLine` |
| merge 段与主块真正无缝（修复了原先两方向插错分隔符的问题） | `generator.ts` `renderLine` |
| `settings.json` 写 `padding: 0`（不让 Claude Code 自加内边距，渲染内容占满宽度） | `manager.ts`、`settings-gen.ts` |
| 行首 `\x1b[0m`（抵消 Claude Code 对 statusline 区域的 dim 设置） | `generator.ts` 输出循环 |
| `git --no-optional-locks status`（不抢 repo index 锁） | `generator.ts` changes 段 |
| 对齐时预留 6 列安全边距（ccstatusline flexMode 的 margin 思路） | `generator.ts` `alignLine` |

ccstatusline 本身不做 powerline 之外的事时的结构也值得知道：一次性进程（非常驻、无 daemon）+ 文件 TTL 缓存（usage 180s / PR 30s / 5h block 5h）+ 进程内 git 命令去重 + 「先收集 widget 清单再统一预渲染」两段式管线 + 按需计算（没有对应 widget 就完全跳过昂贵数据）。

## 7c. statusline 后续优化（按价值排序）

1. **超宽截断（ANSI 保留式）**：内容超出终端宽度时按 grapheme cluster 计宽截断、保留转义序列（ccstatusline `src/utils/ansi.ts:397-476` 的 `truncateStyledText`）。weave 目前超宽会换行挤压。**宽度探测调研结论（2026-09）**：Claude Code 的 statusline stdin JSON 不含宽度字段（社区请求 anthropics/claude-code#52125、#22115 均未实现）；ccstatusline 的 Unix 方案是逐级 spawn `ps`/`stty`（每次渲染 ~100ms 额外开销）、**win32 直接放弃**，Node 亦无轻量 CONOUT 查询途径（无内置 FFI）。唯一可行路径是官方 JSON 加宽度字段——继续搁置，等上游。
2. **flex 分隔符**：一行内左右两端对齐（剩余空间均分给占位分隔符），宽度不可用时降级为普通分隔符（`src/utils/renderer.ts:852-897`）。依赖 1 的宽度探测，同样搁置。
3. **昂贵数据 TTL 文件缓存**：git status 每次渲染都 spawn（~50ms+）。可把 ccstatusline 的轻量 JSON TTL 模式（`~/.cache/` 下 mtime 判断）搬进单文件脚本，把 changes 段降到 TTL 一次。注意 weave 已有 daemon/sqlite，但 statusline 脚本按裁决保持零依赖、不依赖 daemon 存活。
4. ~~**powerline glyph 可配置**~~（**已落地，2026-09**）：`powerline.separator/startCap/endCap` 三字段（`undefined` = 经典三角集、`''` = 禁用 cap），面板 GlyphPicker 预设按钮 + 预览 glyph 桥接渲染（`StatuslinePanel.tsx`）、preview TUI `g` 键循环（`preview.tsx`）、生成脚本从 CONFIG 读取（`generator.ts`）、mergeDefaults spread 保留（`manager.ts`）。
5. **空格转 NBSP**：防 VSCode 等终端 trim 行尾（`src/ccstatusline.ts:208-211`）。不做的原因：会波及 preview round-trip 测试断言与面板显示，且 weave 主场景（Claude Code TUI）无此问题。

---

## 8. Codex prompts 全局面管理

**现状（已结案）**：`~/.codex/prompts/` 不是「deprecated」而是**已被删除**——Codex 源码里 `custom_prompts.rs` 在 `rust-v0.44.0` 存在、`rust-v0.120.0` 起已无，现在全仓库没有任何 `join("prompts")`。它的替代是 plugin `commands/` 目录，而 Codex 加载插件时会把这些命令**自动迁移成 skills**（`core-plugins/src/command_migration/`）。

**结论**：weave 不再往那里装（`FILE_ASSET_SPECS.command.codexUserDir` 已移除），命令类资产的 Codex 路径留给「插件 commands → skills」这条官方迁移路径，不自行建设。

---

## 已完成（本轮 Claude × Codex 共性矩阵）

| 能力 | 实现位置 |
|------|---------|
| MCP → Codex `config.toml`（增量 TOML 编辑器：保留注释/键序，weave key 刷新、未知 key 保留，merge 验证 + clean replace 二级回退；前端 Codex tab 真实网格 + 安装目标切换） | `weave-server/src/install/codex-toml.ts`、`server.ts`、`apply-update.ts`、`updates.ts`、`weave-web/src/components/`（`McpGrid`、`CategoryDetail`、`LibraryPanel`） |
| 指令文件生成（CLAUDE.md / AGENTS.md 合并为一份 + 软连接，跨平台降级为报错退出） | `weave-cli/src/init/claudemd-gen.ts`、`instruction-link.ts` |
| `.codex/` 项目目录监听（skills/config.toml） | `weave-server/src/watch/watch-service.ts` |
| skills 双端安装/卸载/更新（`.claude/skills` + `.codex/skills`，四表面扫描） | `weave-server/src/install/installer.ts`、`updates.ts` |
| 单文件资产管线：commands / agents / workflows / rules / output-styles | `weave-server/src/install/file-assets.ts`（单一事实来源，表驱动） |
| 文件资产模板扫描（库内 `commands/`、`agents/` 等目录） | `weave-server/src/install/scanner.ts` |
| 前端 agent 分区切换（Claude / Codex / 全部）+ 新类别网格 | `weave-web/src/components/`（`FileAssetGrid`、`SkillGrid`、`LibraryPanel`） |
| Instructions 查看（CLAUDE.md / AGENTS.md） | `CategoryDetail.tsx` commands 分类 |
| statusline 预览 TUI（Ink，真实脚本回放） | `weave-cli/src/statusline/preview.tsx` |
| statusline powerline 桥接渲染 + `padding: 0` + `--no-optional-locks`（对齐 ccstatusline） | `weave-server/src/statusline/generator.ts` |
| statusline refreshInterval 默认 10s（事件驱动为主，定时为辅） | `weave-server/src/statusline/config.ts` |
| statusline 全自定义：`label`/`format` 模板、256 色与 hex 真彩、可配进度条、`changes` 的 `(+N, -N)`、`tokens` 的会话累计（transcript 按 `message.id` 去重 + 增量缓存） | `weave-server/src/statusline/{config,generator,manager}.ts`、`weave-cli/src/statusline/{preview.tsx,ansi.ts}`、`weave-web/src/components/StatuslinePanel.tsx` |
| `weave init` 产出真实 statusline 脚本（原先只写占位 stub）+ 嵌套自忽略 `.gitignore` | `weave-cli/src/init/executor.ts` |
| harness 健康检查（软连接未落盘 / 指令文件重复 / 悬挂软连接 / statusLine 绝对路径失效） | `weave-cli/src/init/harness-checks.ts`，由 `weave status` 输出 |
| `weave dashboard` 启动 daemon 并打开 web 控制台；前端改从 `?token=` 取 token（此前只有构建期烘入的固定值，与 `weave daemon start` 的随机 token 不匹配会 401） | `weave-cli/src/commands/dashboard.ts`、`weave-web/src/lib/api.ts` |

---

## 9. statusline 后续项
**1. `alignLine` 用 `plain.length`（UTF-16 码元）计宽**：emoji（代理对计 2）与 Nerd-Font PUA 字形会让 right/center 对齐偏移，开启 powerline 后更明显。修法是用 `string-width` 之类的显示宽度估算；会波及现有 `align` 测试的断言，故本轮未动。

**2. statusline 类型在 web 端有一份手抄副本**：`weave-web/src/lib/api.ts` 镜像了 `weave-server/src/statusline/config.ts` 的 `StatuslineConfig` 等类型（web 不依赖 `@weave/server`），改动必须两侧同步。长期应下沉到 `@weave/core`。

**3. 提交软连接的跨平台风险无法根治**：`core.symlinks` 是本机 git 配置、不随仓库传播。未开 Windows 开发者模式的队友 clone 后，`AGENTS.md` 会被检出成内容为 `CLAUDE.md` 的普通文件。`weave status` 能检测并告警，但根治只能靠不提交软连接（用根 `.gitignore` 忽略 `AGENTS.md`，代价是队友 clone 后需自己跑 `weave init`）。

**4. 版本号仍是手写常量**：`weave-server/src/version.ts` 的 `WEAVE_VERSION` 是各处版本戳的单一来源（statusline 的 logo、helper 脚本的 `@version`、`DAEMON_VERSION`、init 记录的 `initVersion`），但它本身仍需与各 `package.json` 的 `version` 手工保持一致。修法是构建时从 package.json 注入。

**5. 默认布局变更会影响存量项目**：`DEFAULT_STATUSLINE_CONFIG` 现在就是参考图那套（双行 powerline、文字标签、方括号进度条）。`apply-update` 的 `refreshStatusline()` 会用「follow global 且本机无全局模板」的项目的默认值重刷脚本，因此升级后这些项目会一起换肤——这是刻意的产品决定，但发布说明里要写明。已有 `.weave/statusline.json`（`source: custom`）或配了 `~/.weave/statusline.json` 的项目不受影响。

---

## 10. Harness 表面：已确证但未实现的差距

调研方法：本机安装的 Claude Code CLI v2.1.286 原生二进制（搜字符串常量与路径拼接）+ openai/codex main 源码 + anthropics/claude-code 的 CHANGELOG。**不要用「官方文档没写」推断功能不存在**——plugin-dev 的组件文档至今没列 output styles，而 CHANGELOG 2.0.41 早就写明了。

### 已修（本轮）
- ~~`command.codexUserDir: '.codex/prompts'`~~：Codex 已删除 custom prompts（`custom_prompts.rs` 在 `rust-v0.44.0` 存在、`rust-v0.120.0` 已无），该目录无人读取。
- ~~Codex 用户级 skills 读写 `~/.codex/skills`~~：Codex 的 `host_roots.rs` 注释其为 "Deprecated user skills location"；现写入改为 `~/.agents/skills`，读取同时兼容旧位置（当前位置优先）。

### 待做

**1. `workflow` / `rule` 缺 `userDir`**（`install/file-assets.ts`）
Claude Code 的用户级目录白名单（二进制原串）含 `workflows` 与 `rules`，且 CHANGELOG 2.1.178 明确「project-scope workflow saves … closest existing `.claude/workflows/`」、2.1.208 有 user-scope。两者都该补 `userDir: '.claude/workflows'` / `'.claude/rules'`，否则全局安装会抛 "project-scoped only"。`file-assets.test.ts` 里已用 KNOWN GAP 标注。

**2. `routines` 完全未建模**
二进制中 135 次命中，出现在用户级白名单与 `--project-config-root` 帮助文本（"commands, agents, skills, workflows, routines, output-styles"）里。是一个真实但尚无文档的表面，需要先弄清文件格式再决定是否建模。

**3. Codex subagents（`.toml`）**
Codex 有 agent roles：`~/.codex/agents/*.toml` + `<project>/.codex/agents/*.toml`，且官方提供 `.claude/agents/*.md` → `.codex/agents/*.toml` 的转换器。weave 目前把 agents 当 Claude 专属。格式不同，不能直接复制，需要转换器。

**4. Codex statusline 形态不同**
Codex 的 `/statusline` + `tui.status_line = [...]` 只能选内置条目，不支持任意 shell 命令。weave 的 statusline 工作是 Claude 专属，这是正确的，但 UI 上不该暗示 Codex 有对等物。

**5. `project_doc_fallback_filenames` 是软连接的官方替代**
Codex 支持声明额外回退文件名，把 `CLAUDE.md` 列进去即可让 Codex 直接读，无需软连接——也就没有「Windows 队友 checkout 成普通文件」的风险。值得作为 `weave init` 的可选方案评估。

**6. §2「Codex hooks 是实验特性」的前提可能已过时**
Codex 源码里是 11+ 事件的完整体系（`PreToolUse`/`PostToolUse`/`PermissionRequest`/`SubagentStart`/`SubagentStop`/`Interrupt`/`PreCompact`/`PostCompact`/`SessionStart`/`SessionEnd`/`UserPromptSubmit`/`Stop`），handler 类型还多出 `McpTool` 与 `Agent`。重新评估是否值得接入。

---
