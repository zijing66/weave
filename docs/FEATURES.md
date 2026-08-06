# Weave Harness — 完整功能范围

> 版本：0.1.0 | 更新日期：2026-08-07
> 参考实现：ruflo (claude-flow v3.34.0)

Weave 是一个 Claude Code harness 工具，可对任意已有项目执行 `weave init`，注入 Claude Code 插件能力。设计理念来自 ruflo，但聚焦于 harness 层而非完整的 agent 编排平台。

---

## A. Harness 注入（`weave init` 核心）

### A1. 目录结构注入 — P0

**描述**：在目标项目中创建 `.claude/` 目录树，作为 Claude Code 的工作空间结构。

**目标目录**：
```
.claude/
├── skills/          # 技能定义
├── commands/        # slash commands
├── agents/          # 代理角色定义
└── helpers/         # 辅助脚本
```

**ruflo 参考**：`v3/@claude-flow/cli/src/init/executor.ts` — `executeInit()` 的 Step 2

**预期产出**：
- `ensureDir` 工具函数，递归创建目录
- 跳过已存在的目录（除非 `--force`）
- 返回已创建/已跳过的目录清单

---

### A2. settings.json 生成 — P0

**描述**：生成 `.claude/settings.json`，配置 Claude Code 的行为。

**配置项**：
- `hooks`：PreToolUse、PostToolUse、UserPromptSubmit 等事件钩子（指向 helpers/ 下的脚本）
- `permissions.allow`：允许的操作列表（如 `Bash(npx weave*)`）
- `permissions.deny`：禁止的操作列表（如 `Read(./.env*)`）
- `env`：环境变量注入
- `model`：默认模型配置
- `statusLine`：状态栏配置

**ruflo 参考**：`v3/@claude-flow/cli/src/init/settings-generator.ts`

**预期产出**：
- `generateSettingsJson(options): Record<string, unknown>` 纯函数
- 合并已有 settings（不覆盖用户自定义项）
- hooks 块仅在 helpers 组件同时启用时生成

---

### A3. MCP 配置生成 — P1

**描述**：生成 `.mcp.json`，注册 MCP (Model Context Protocol) server。

**配置结构**：
```json
{
  "mcpServers": {
    "weave": {
      "command": "npx",
      "args": ["weave", "mcp", "start"],
      "env": {}
    }
  }
}
```

**ruflo 参考**：`v3/@claude-flow/cli/src/init/mcp-generator.ts`

**预期产出**：
- `generateMcpJson(options): Record<string, unknown>` 纯函数
- 平台感知（Windows 用 `cmd /c npx`，Unix 用 `npx`）
- 合并已有 `.mcp.json`（不覆盖其他 server 配置）

---

### A4. CLAUDE.md 生成 — P0

**描述**：在项目根目录生成 `CLAUDE.md`，作为 Claude Code 的项目级指令文件。

**模板类型**：
| 模板 | 说明 |
|------|------|
| `minimal` | 最小配置，仅项目简介和基本规则 |
| `standard` | 标准配置，含行为规则、文件组织、开发流程 |
| `full` | 完整配置，含安全策略、性能指南、agent 协作协议 |

**内容段落**：
- 项目概述与技术栈
- 行为规则（编码规范、提交规范）
- 文件组织规则
- 测试要求
- 安全约束

**ruflo 参考**：`v3/@claude-flow/cli/src/init/claudemd-generator.ts`

**预期产出**：
- `generateClaudeMd(options): string` 纯函数
- 段落可组合（各段落独立函数，按模板拼接）
- 不覆盖已存在的 CLAUDE.md（除非 `--force`）

---

### A5. Runtime 配置 — P1

**描述**：生成 `.weave/config.yaml`，存储 harness 的运行时状态。

**配置内容**：
- 初始化时间戳
- 使用的 preset 名称
- 已启用的组件清单
- weave 版本号

**ruflo 参考**：`v3/@claude-flow/cli/src/init/executor.ts` — runtime config 写入步骤

**预期产出**：
- `.weave/config.yaml` 文件
- 用于 `weave status` 和 `weave doctor` 读取状态

---

## B. 插件内容模板

### B1. Skills 技能系统 — P0

**描述**：SKILL.md 文件定义特定任务的技能，放置在 `.claude/skills/` 下。Claude Code 启动时自动加载。

**内置技能（初始集）**：

| 技能名 | 功能 |
|--------|------|
| `code-review` | 代码审查流程指引 |
| `project-navigation` | 项目结构导航与代码定位 |
| `testing` | 测试编写规范与策略 |
| `refactoring` | 重构方法论与安全步骤 |

**ruflo 参考**：ruflo 内置 8+ core skills、17+ 领域 skills

**预期产出**：
- `src/templates/skills/<name>/SKILL.md` 模板文件
- 模板注册表记录每个 skill 的元数据
- 支持 `weave add skill <name>` 动态添加

---

### B2. Commands 命令系统 — P1

**描述**：命令 `.md` 文件定义 Claude Code 的 slash commands，放置在 `.claude/commands/` 下。

**内置命令（初始集）**：

| 命令名 | 功能 |
|--------|------|
| `/review` | 触发代码审查流程 |
| `/scaffold` | 脚手架生成（组件、模块） |
| `/explain` | 代码解释与文档生成 |
| `/test` | 测试生成与运行指引 |

**ruflo 参考**：ruflo 内置 100+ commands 跨 18 个分类

**预期产出**：
- `src/templates/commands/<name>.md` 模板文件
- 模板注册表记录每个 command 的元数据

---

### B3. Agents 代理系统 — P1

**描述**：Agent 定义 `.md` 文件定义专用代理角色，放置在 `.claude/agents/` 下。

**内置代理（初始集）**：

| 代理名 | 角色 |
|--------|------|
| `coder` | 编码执行者，专注实现 |
| `reviewer` | 代码审查者，专注质量 |
| `researcher` | 研究者，探索与分析 |
| `planner` | 规划者，方案设计 |

**ruflo 参考**：ruflo 内置 60+ agents 跨 25+ 分类

**预期产出**：
- `src/templates/agents/<name>.md` 模板文件
- 每个 agent 定义包含：角色描述、能力范围、行为约束

---

### B4. Helpers 辅助脚本 — P1

**描述**：CJS/MJS 辅助脚本，放置在 `.claude/helpers/` 下，为 hooks 和 statusline 提供运行时支持。

**内置脚本**：

| 脚本名 | 功能 |
|--------|------|
| `hook-handler.cjs` | 通用 hook 处理器，接收 JSON stdin，分发事件 |
| `statusline.cjs` | 状态栏渲染脚本 |
| `pre-commit.sh` | Git pre-commit 钩子 |
| `post-commit.sh` | Git post-commit 钩子 |

**ruflo 参考**：`v3/@claude-flow/cli/src/init/helpers-generator.ts`

**预期产出**：
- `generateHookHandler(): string` 纯函数
- `generateStatusline(): string` 纯函数
- 脚本以字符串形式生成，写入文件

---

## C. 生命周期管理

### C1. `weave status` — P0

**描述**：检查当前项目 harness 状态，显示已注入的组件清单。

**输出内容**：
- harness 是否已初始化
- 已注入的 skills/commands/agents 列表
- settings.json 状态（是否存在、是否有修改）
- weave 版本 vs harness 版本

**ruflo 参考**：`init check` 子命令

**预期产出**：
- 读取 `.weave/config.yaml` 和 `.claude/` 目录
- 格式化输出状态表格

---

### C2. `weave doctor` — P1

**描述**：诊断配置问题，提供修复建议。

**检查项**：
- `.claude/settings.json` 是否为有效 JSON
- hooks 脚本是否存在且可执行
- skills/commands/agents 文件完整性
- `.mcp.json` 格式校验
- Node.js 版本兼容性

**ruflo 参考**：`doctor` 命令

**预期产出**：
- 问题清单 + 修复建议
- `--fix` 自动修复可修复的问题

---

### C3. `weave add <type> <name>` — P1

**描述**：动态添加单个插件组件。

**用法**：
```
weave add skill code-review
weave add command review
weave add agent coder
weave add helper hook-handler
```

**ruflo 参考**：`init skills`、`init hooks` 子命令

**预期产出**：
- 从模板注册表查找并复制单个组件
- 不影响其他已有组件

---

### C4. `weave remove <type> <name>` — P2

**描述**：移除已注入的 harness 组件。

**安全措施**：
- 确认提示（除非 `--yes`）
- 不删除用户自定义内容（通过 checksum 区分）

**ruflo 参考**：`eject` 命令

**预期产出**：
- 删除指定组件文件
- 更新 `.weave/config.yaml`

---

### C5. `weave upgrade` — P2

**描述**：更新 helpers/skills 到新版本，保留用户自定义数据。

**策略**：
- 比对文件 checksum，仅更新未修改的模板文件
- 用户修改过的文件标记为冲突，提示手动合并
- `--add-missing` 仅添加缺失组件，不覆盖

**ruflo 参考**：`init upgrade` 子命令 + `helper-refresh.ts`

**预期产出**：
- 版本戳对比
- 增量更新逻辑

---

## D. 进阶功能

### D1. 配置校验系统 — P1

**描述**：Zod schema 配置校验，支持多配置源合并。

**Schema 定义**：
- `InitOptionsSchema`：初始化选项校验
- `SettingsSchema`：settings.json 结构校验
- `McpConfigSchema`：MCP 配置校验
- `WeaveConfigSchema`：runtime 配置校验

**ruflo 参考**：`@claude-flow/shared/src/core/config/schema.ts`

**预期产出**：
- 所有配置类型通过 Zod 定义
- 运行时校验 + 友好的错误提示
- `ConfigLoader` 支持多源合并（默认值 < 文件 < 环境变量 < CLI 参数）

---

### D2. 插件注册表 — P2

**描述**：可扩展的模板/插件注册机制，支持第三方扩展。

**注册类型**：
- Skills 注册
- Commands 注册
- Agents 注册
- Helpers 注册

**ruflo 参考**：`@claude-flow/shared/src/plugin-registry.ts`

**预期产出**：
- `TemplateRegistry` 类，支持动态注册与发现
- 扩展点机制（可挂载新的模板源）
- 第三方可通过 npm 包提供额外模板

---

### D3. Hooks 事件系统 — P2

**描述**：基于 Claude Code hooks 的自动事件响应系统。

**事件类型**：
| 事件 | 触发时机 |
|------|---------|
| `PreToolUse` | 工具调用前 |
| `PostToolUse` | 工具调用后 |
| `UserPromptSubmit` | 用户提交 prompt 时 |
| `SessionStart` | 会话开始时 |
| `Stop` | 会话结束时 |
| `Notification` | 通知触发时 |

**ruflo 参考**：`@claude-flow/shared/src/hooks/registry.ts`

**预期产出**：
- `HookRegistry` 类，管理事件订阅与分发
- hooks 配置写入 settings.json
- hook-handler.cjs 作为通用事件处理器

---

### D4. 项目自动检测 — P1

**描述**：检测当前项目的语言、框架、包管理器，自动选择合适的模板集。

**检测能力**：
| 检测项 | 方法 |
|--------|------|
| 语言 | 文件扩展名统计 + package.json/go.mod/Cargo.toml |
| 框架 | 依赖列表分析（react/vue/angular/express/nest 等） |
| 包管理器 | lock 文件检测（package-lock.json/yarn.lock/pnpm-lock.yaml） |
| 测试框架 | 依赖中的 jest/vitest/mocha/pytest |
| Node 版本 | .nvmrc/.node-version/package.json engines |

**ruflo 参考**：`detectPlatform()` in `types.ts` + Codex auto-detection

**预期产出**：
- `detectProject(targetDir): ProjectInfo` 函数
- 根据检测结果自动选择 preset 和模板集
- 可通过 `--preset` 手动覆盖

---

### D5. 安全策略层 — P2

**描述**：参考 ruflo 的 MetaHarness，提供 MCP 安全策略与危险命令拦截。

**安全能力**：
- MCP 工具调用白名单/黑名单
- 危险命令模式匹配（rm -rf、sudo、git push --force 等）
- 文件访问控制（禁止读取 .env、credentials 等敏感文件）

**ruflo 参考**：`.harness/mcp-policy.json`

**预期产出**：
- `.weave/policy.json` 策略文件
- hook-handler 中集成策略检查
- 默认安全基线（deny 敏感文件、拦截危险命令）

---

## E. 架构支撑

### E1. 自定义 CLI Parser — P0

**描述**：实现自定义命令行参数解析器，支持子命令嵌套、flag 类型、短选项等。

**能力**：
- 长选项（`--preset full`）和短选项（`-f`）
- `--key=value` 语法
- boolean/string/array flag 类型
- `--no-*` 否定语法
- 子命令解析（`weave init --force`、`weave add skill code-review`）
- 多级子命令（最多 3 级）

**ruflo 参考**：`v3/@claude-flow/cli/src/parser.ts`（`CommandParser` 类，约 300 行）

**预期产出**：
- `CommandParser` 类
- 支持命令定义、flag 定义、验证、帮助生成

---

### E2. 模板注册机制 — P0

**描述**：可扩展的模板发现与注册系统，管理所有内置模板的元数据和路径。

**设计**：
```typescript
interface TemplateEntry {
  name: string;
  category: 'skill' | 'command' | 'agent';
  sourcePath: string;    // 包内相对路径
  description: string;
  tags: string[];
}
```

**ruflo 参考**：`v3/@claude-flow/codex/src/templates/index.ts`

**预期产出**：
- `TemplateRegistry` 类
- 硬编码清单（初期），可扩展为目录扫描
- 按 category 查询、按 name 查找

---

### E3. Helper 自动刷新 — P2

**描述**：版本戳机制，CLI 执行时自动检查并更新已注入的 helpers。

**机制**：
- 每个 helper 文件头部嵌入版本戳（`// weave@0.1.0`）
- CLI 执行时对比版本戳，过期则重新生成
- 用户修改过的文件通过 checksum 检测，不自动覆盖

**ruflo 参考**：`v3/@claude-flow/cli/src/init/helper-refresh.ts`

**预期产出**：
- 版本戳读写函数
- 自动刷新逻辑（每次 CLI 命令时触发）

---

### E4. Helper 签名验证 — P2

**描述**：SHA256 完整性校验，确保 helpers 未被篡改。

**机制**：
- 生成时计算 SHA256 hash，写入 `.weave/helpers.manifest.json`
- 加载时校验 hash，不匹配则告警并重新生成

**ruflo 参考**：`v3/@claude-flow/cli/src/init/helper-signing.ts`

**预期产出**：
- `computeHash(content): string` 工具函数
- manifest 文件生成与校验

---

## 优先级汇总

| 优先级 | 功能编号 | 说明 |
|--------|---------|------|
| **P0（核心）** | A1, A2, A4, B1, C1, E1, E2 | 首批实现，跑通 init 流程 |
| **P1（重要）** | A3, A5, B2, B3, B4, C2, C3, D1, D4 | 第二批，完善功能 |
| **P2（扩展）** | C4, C5, D2, D3, D5, E3, E4 | 第三批，进阶能力 |

---

## 技术决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 语言 | TypeScript ESM (ES2022) | 与 ruflo 一致，类型安全 |
| 包管理 | pnpm monorepo | 用户偏好，便于后续分包 |
| CLI 框架 | 自定义 parser | 参考 ruflo，支持子命令嵌套 |
| 校验 | Zod | 配置 schema 运行时校验 |
| 测试 | vitest | ESM 原生，快速 |
| 模板引擎 | 模板字面量 | 内容为静态 markdown/text，无需额外引擎 |
