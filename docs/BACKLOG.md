# Weave Backlog — 待完善计划

本文件记录 Claude Code × Codex 双 harness 支持的调研结论：**低难度共性功能已全部实现**（见文末「已完成」），高难度或依赖外部 schema 稳定的功能列入此处，按优先级与前置条件排列。

调研基线：2026-08 官方文档（Claude Code settings/skills/plugins 文档、Codex config.toml 与 AGENTS.md 标准）。

---

## 1. MCP → Codex `config.toml`（优先级 P1，难度高）

**目标**：安装 MCP server 时，除写入 `.mcp.json`（Claude Code）外，同步写入 `~/.codex/config.toml` 的 `[mcp_servers.<name>]` 段。

**为什么难**：
- TOML 的 parse → stringify 往返会**丢失用户手写的注释与键序**。`~/.codex/config.toml` 是用户深度定制的文件（sandbox、approvals、model 等），不可整文件重写。
- Codex 的 MCP schema 演进中（user 层与 project 层 `.codex/config.toml` 双层语义有差异）。

**建议方案**：
- 实现一个**增量 TOML 编辑器**：按 section 定位 `[mcp_servers.<name>]`，仅插入/替换该 section 的行，其余内容按原行序保留。
- 落点：`packages/weave-server/src/install/codex-toml.ts`（新文件），仿照 `settings-gen.ts` 的「weave key 可刷新、其余原样保留」合并策略。
- 前端 MCP 分类 Codex tab 由占位符改为真实网格（`McpGrid` 复用 + uninstall 走 TOML 编辑器）。

**前置条件**：无（独立模块）。

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

## 7c. statusline 后续优化（未落地，按价值排序）

1. **超宽截断（ANSI 保留式）**：内容超出终端宽度时按 grapheme cluster 计宽截断、保留转义序列（ccstatusline `src/utils/ansi.ts:397-476` 的 `truncateStyledText`）。weave 目前超宽会换行挤压。需要先解决宽度探测：Claude Code spawn 脚本时 stdout 非 TTY，`process.stdout.columns` 为 undefined；ccstatusline 在 Unix 向上遍历父进程找 PTY、**win32 直接放弃**——weave 主战场是 Windows，可试 `CONOUT` 查询或接受 stdin JSON 提供的宽度字段。
2. **flex 分隔符**：一行内左右两端对齐（剩余空间均分给占位分隔符），宽度不可用时降级为普通分隔符（`src/utils/renderer.ts:852-897`）。依赖 1 的宽度探测。
3. **昂贵数据 TTL 文件缓存**：git status 每次渲染都 spawn（~50ms+）。可把 ccstatusline 的轻量 JSON TTL 模式（`~/.cache/` 下 mtime 判断）搬进单文件脚本，把 changes 段降到 TTL 一次。注意 weave 已有 daemon/sqlite，但 statusline 脚本按裁决保持零依赖、不依赖 daemon 存活。
4. **powerline glyph 可配置**：当前硬编码 ``/``（U+E0B2/U+E0B0）。ccstatusline 提供 12 种 glyph（圆角 ``、斜切 `` 等，`src/tui/components/PowerlineSeparatorEditor.tsx:54-71`）。做成 `powerline.separator` 字段 + 面板/preview 选项即可。
5. **空格转 NBSP**：防 VSCode 等终端 trim 行尾（`src/ccstatusline.ts:208-211`）。不做的原因：会波及 preview round-trip 测试断言与面板显示，且 weave 主场景（Claude Code TUI）无此问题。

---

## 8. Codex prompts 全局面管理

**现状**：`.codex/prompts/` 作为文件资产已支持全局安装（`FILE_ASSET_SPECS.command.codexUserDir`），但未提供列表/卸载 UI（官方已将 custom prompts 标记 deprecated，方向是 skills）。

**建议**：跟随官方方向，把 Codex 全局 prompts 的展示并入 skills 分类的 Codex tab（列为「prompts (deprecated)」分组），不再单独建设。

---

## 已完成（本轮 Claude × Codex 共性矩阵）

| 能力 | 实现位置 |
|------|---------|
| AGENTS.md 生成（Codex 指令文件，镜像 CLAUDE.md 合并策略） | `weave-cli/src/init/agentsmd-gen.ts` |
| `.codex/` 项目目录监听（skills/config.toml） | `weave-server/src/watch/watch-service.ts` |
| skills 双端安装/卸载/更新（`.claude/skills` + `.codex/skills`，四表面扫描） | `weave-server/src/install/installer.ts`、`updates.ts` |
| 单文件资产管线：commands / agents / workflows / rules / output-styles | `weave-server/src/install/file-assets.ts`（单一事实来源，表驱动） |
| 文件资产模板扫描（库内 `commands/`、`agents/` 等目录） | `weave-server/src/install/scanner.ts` |
| 前端 agent 分区切换（Claude / Codex / 全部）+ 新类别网格 | `weave-web/src/components/`（`FileAssetGrid`、`SkillGrid`、`LibraryPanel`） |
| Instructions 查看（CLAUDE.md / AGENTS.md） | `CategoryDetail.tsx` commands 分类 |
| statusline 预览 TUI（Ink，真实脚本回放） | `weave-cli/src/statusline/preview.tsx` |
| statusline powerline 桥接渲染 + `padding: 0` + `--no-optional-locks`（对齐 ccstatusline） | `weave-server/src/statusline/generator.ts` |
| statusline refreshInterval 默认 10s（事件驱动为主，定时为辅） | `weave-server/src/statusline/config.ts` |
