# Weave

Weave 是一个 Claude Code harness 工具，对任意已有项目执行 `weave init`，注入 Claude Code 插件能力（skills、commands、agents、helpers、settings.json、MCP 配置）。

设计理念来自 [ruflo](../ruflo) (claude-flow v3.34.0)，聚焦于 harness 层而非完整的 agent 编排平台。

---

## 技术栈

- **语言**：TypeScript 5.x, ESM, ES2022 target
- **运行时**：Node.js 20+
- **包管理**：pnpm monorepo (workspaces)
- **CLI**：自定义 CommandParser（参考 ruflo 的 `parser.ts`）
- **校验**：Zod（配置 schema 运行时校验）
- **测试**：vitest（ESM 原生）
- **构建**：tsc（TypeScript compiler）

---

## 目录结构（规划）

```
weave/
├── packages/
│   ├── weave-core/          # 核心库：类型定义、schema、工具函数
│   │   ├── src/
│   │   │   ├── types.ts           # Zod schema + TS 类型导出
│   │   │   ├── platform.ts        # 平台/项目检测
│   │   │   └── utils/
│   │   │       ├── fs.ts          # 文件系统工具
│   │   │       └── logger.ts      # 日志输出
│   │   └── package.json
│   │
│   ├── weave-cli/           # CLI 入口：parser、commands、executor
│   │   ├── src/
│   │   │   ├── cli.ts             # CLI 应用入口
│   │   │   ├── parser.ts          # 自定义参数解析器
│   │   │   ├── commands/
│   │   │   │   ├── init.ts        # init 命令
│   │   │   │   ├── status.ts      # status 命令
│   │   │   │   ├── doctor.ts      # doctor 命令
│   │   │   │   └── add.ts         # add 命令
│   │   │   └── init/
│   │   │       ├── executor.ts    # 初始化编排器（InitOrchestrator）
│   │   │       ├── settings-gen.ts
│   │   │       ├── mcp-gen.ts
│   │   │       ├── claudemd-gen.ts
│   │   │       └── helpers-gen.ts
│   │   ├── bin/
│   │   │   └── cli.js             # Shebang 入口
│   │   └── package.json
│   │
│   ├── weave-harness/        # @weave/harness：能力接口与注册表（仅依赖 @weave/core）
│   │   ├── src/
│   │   │   ├── driver.ts          # HarnessDriver 五能力接口 + HarnessRegistry
│   │   │   ├── init/pipeline.ts   # abstract InitPipeline（init 模板方法）
│   │   │   ├── registry-wiring.ts # registerRuntimeDrivers 运行时装配
│   │   │   ├── claude/            # Claude 接入模块（events/assets/resume/detect）
│   │   │   └── codex/             # Codex 接入模块（assets/detect）
│   │   └── package.json
│   │
│   ├── weave-server/         # daemon 服务端：hooks/watch/install/装配 + HTTP 路由
│   │   ├── src/
│   │   ├── web/              # web 源码（原 weave-web 整包并入，不再单独成包）
│   │   └── package.json
│   │
│   └── weave-templates/     # 模板库：skills、commands、agents
│       ├── src/
│       │   ├── index.ts           # TemplateRegistry
│       │   └── templates/
│       │       ├── skills/
│       │       │   ├── code-review/SKILL.md
│       │       │   ├── project-navigation/SKILL.md
│       │       │   ├── testing/SKILL.md
│       │       │   └── refactoring/SKILL.md
│       │       ├── commands/
│       │       │   ├── review.md
│       │       │   ├── scaffold.md
│       │       │   ├── explain.md
│       │       │   └── test.md
│       │       └── agents/
│       │           ├── coder.md
│       │           ├── reviewer.md
│       │           ├── researcher.md
│       │           └── planner.md
│       └── package.json
│
├── docs/
│   └── FEATURES.md          # 完整功能范围文档
├── CLAUDE.md                # 本文件
├── LICENSE
├── pnpm-workspace.yaml
├── tsconfig.json
├── tsconfig.base.json
└── vitest.config.ts
```

---

## 开发规范

### 代码风格

- **模块系统**：ESM (`import/export`)，不使用 CommonJS
- **类型安全**：所有函数参数和返回值必须显式标注类型
- **Zod schema**：配置相关类型通过 Zod schema 推导，不手写 interface
- **纯函数优先**：生成器函数（settings-gen、claudemd-gen 等）为纯函数，接收 options 返回内容
- **错误处理**：使用 `Result<T, E>` 模式或自定义错误类，不吞错误

### 命名规范

- 文件名：`kebab-case.ts`
- 类名：`PascalCase`
- 函数/变量：`camelCase`
- 常量：`UPPER_SNAKE_CASE`
- Zod schema：`XxxSchema`（如 `InitOptionsSchema`）
- 推导类型：从 schema 推导（如 `type InitOptions = z.infer<typeof InitOptionsSchema>`）

### 提交规范

- 格式：`<type>(<scope>): <description>`
- 类型：`feat` | `fix` | `docs` | `refactor` | `test` | `chore`
- **description 用中文写**（type/scope 保持英文）
- 示例：`feat(cli): init 时生成真实 statusline 脚本`
- 提交信息正文（如需多行）同样用中文

### 测试要求

- 纯函数必须有单元测试
- 生成器函数测试：验证输出结构和关键内容
- 使用 vitest，测试文件放在同级 `__tests__/` 目录
- 文件名：`*.test.ts`

### 国际化（i18n）

- 界面文案（web 组件 + weave-cli 命令输出/帮助/preview TUI）**必须走词典**，
  禁止在组件或命令里硬编码中英文；专有名词（Claude Code、Codex、MCP、路径、命令字面、
  用户数据）不入典，写死在词条值里即可。
- 语言的单一事实源是 daemon settings（`<configDir>/weave/settings.json` 的 `locale`）：
  web 由 `I18nProvider` 挂载时读取（localStorage 仅作首屏缓存），CLI 由 `initCliLocale()`
  解析（`WEAVE_LOCALE` 环境变量可单次覆盖）。
- 词典位置：web `packages/weave-server/web/src/i18n/dict/`（按领域分 chunk），
  CLI `packages/weave-cli/src/i18n/dict/`；手写类型安全字典，chunk 文件级
  `en: Record<keyof typeof zh, string>` 强制 key 对齐（漏译编译失败）。
- **新增语言的注册步骤**：① `weave-server/src/daemon/settings.ts` 的 `Locale` 联合 +
  `SUPPORTED_LOCALES` 加一项；② web `src/i18n/locale.ts` 镜像同步 + `LOCALE_NATIVE_NAMES`
  加一项，各 chunk 补齐该语言词条并在 `dict/index.ts` 合并进 `DICTS`；③ CLI 新建
  `dict/<lang>.ts` 并注册进 `DICTS`。`Record<Locale, …>` 穷举检查保证不写完字典
  无法编译，调用点零改动。

### hooks 事件系统（D3）

- 链路：Claude Code hooks → `.claude/helpers/hook-handler.cjs`（恒 exit 0、5s guard）
  → `POST /hooks`（项目 token）→ adapter 归一化 → `hook_events`（append-only）→
  **dispatcher 在响应路径上同步匹配规则**，命中 inject 时把 `additionalContext`
  放进响应体由 handler 输出注入会话（官方同步 hook 输出通道，**不是** async）。
- 规则存 SQLite `hook_rules`（行级 CRUD，开关即 `enabled` 字段），内存索引在
  `hooks/registry.ts`；运行态在 `hook_dispatches`；会话标题在 `sessions`（rename 双向：
  读 payload `session_title` diff、写 `pending_title` 经 hook 输出 `sessionTitle`）。
- 四种下游处理器：`log` / `webhook`（出站）/ `inject`（入池+注入当前会话）/
  `manual`（只入池，dashboard 复制或拖到会话经 resume 执行）。inject 只允许挂在
  `INJECTABLE_HOOK_EVENTS` 白名单事件上（规则创建时校验）。
- 采集面（settings.json 7 事件全集）与响应（daemon 规则开关）**分离**：handler 恒不阻塞，
  是否动作由规则决定；全局总开关在 daemon settings `hooks.enabled`。
- **weave 生成物必带标记**并按标记清扫：settings.json hook 组以路径
  `.claude/helpers/hook-handler.cjs` 为 marker（`mergeSettingsJson` 组级清扫，weave 组
  永远等于本次生成结果）、helper 脚本以 `@version weave@` 为 marker（executor 清理
  不在清单的遗留文件，记入 `InitResult.removed`）。改生成器必须同步更新清扫测试。
- 关键文件：`weave-server/src/hooks/{registry,dispatcher,bus,match,resume-runner}.ts`、
  `daemon/hooks-routes.ts`、`weave-cli/src/init/{settings-gen,helpers-gen}.ts`、
  web `components/HooksPanel.tsx`。详见 `docs/FEATURES.md` D3。

### 插件系统（D3.1，SPI 式基础设施）

- **插件包** = 带 `weave-plugin.json` manifest 的目录（rules.json 复用
  `HookRuleSchema` + 可选 handler.mjs/模板/订阅），放约定位置即被 daemon
  自动识别：内置 `presets/` → `<configDir>/weave/plugins/` → 项目
  `.weave/plugins/`。**规范唯一权威 = `docs/PLUGIN-SPEC.md`**（AI 按此生成
  插件，§9 smoke 清单即加载器校验，§10 开发流程，fixtures/changelog-reminder
  为回归基准）。
- **扩展点**：①规则（`hook_rules.origin/plugin_id`，upsert 保用户开关）
  ②自定义处理器（dispatcher `plugin` 分支，与 inject/manual 同防线）
  ③模板注入（TemplateRegistry.register + init Step 6b 复制）
  ④MCP 定义（init 合并，同名 namespace 化）⑤`@file:` 指令模板
  （含 workflow 引导语——**注入触发 Claude 原生 Workflow，无自有引擎**）
  ⑦事件订阅（manifest.subscribe，ingest fire-and-forget 转发）。
- **生命周期**：chokidar 三根目录热重载（防抖 1s）；消失/校验失败的插件
  级联删规则卸 handler（重复 id 不误删）；开关 = `plugin_states` 级联启停。
- **分发**：`weave plugins list|install|uninstall|enable|disable|export|search`
  （installed.json 清单 / sources.json 索引源）+ dashboard 插件区段 +
  `GET/POST /hooks/plugins`。
- 关键文件：`weave-server/src/hooks/{plugin-loader,plugin-installer}.ts`、
  `repositories/plugin-states.ts`、`weave-cli/src/init/plugin-templates.ts`、
  `weave-cli/src/commands/plugins.ts`、web `components/HooksPluginsSection.tsx`。

---

## 核心命令

| 命令 | 功能 | 优先级 |
|------|------|--------|
| `weave init` | 注入 harness 到当前项目 | P0 |
| `weave status` | 查看 harness 状态（含健康检查告警） | P0 |
| `weave daemon` | 启停 Dashboard 后台守护进程 | P0 |
| `weave dashboard` | 启动 daemon 并打开 web 控制台 | P0 |
| `weave scan` | 扫描已 init 项目并注册到 daemon | P1 |
| `weave statusline preview` | statusline 交互式 TUI 预览（Ink） | P1 |
| `weave hooks` | 列表/开关切换 daemon hook 规则 | P1 |
| `weave doctor` | 诊断配置问题 | P1 |
| `weave add <type> <name>` | 动态添加组件 | P1 |
| `weave remove <type> <name>` | 移除组件 | P2 |
| `weave upgrade` | 更新到新版本 | P2 |

> 双 harness 说明：weave 同时管理 Claude Code（`.claude/`）与 Codex（`.codex/`、`AGENTS.md`）表面。
> 共性面（skills / 指令文件 / commands / agents 等）已实现；高难度项见 `docs/BACKLOG.md`。
> `weave init` 支持 `--harness` 多选（TTY 下交互多选，非 TTY / `--no-interactive` 默认 `['claude']`），
> `weave scan`/`weave status` 按 harness marker 探测（`.claude`/`.codex`）。

---

## 实施路线图

### Phase 1 — 核心骨架（P0）

1. 初始化 pnpm monorepo 结构（`pnpm-workspace.yaml`、`tsconfig.base.json`）
2. 实现 `weave-core`：Zod schema（`InitOptionsSchema`、`SettingsSchema`）、平台检测、工具函数
3. 实现 `weave-cli`：自定义 `CommandParser`、`init` 命令
4. 实现 `weave-templates`：`TemplateRegistry` + 初始模板集
5. 实现 `init` executor：目录注入 → settings.json → CLAUDE.md
6. 实现 `status` 命令

### Phase 2 — 完善功能（P1）

7. 添加 MCP 配置生成（A3）
8. 添加 Runtime 配置（A5）
9. 扩展模板：commands、agents、helpers（B2-B4）
10. 实现 `doctor` 和 `add` 命令（C2-C3）
11. 添加项目自动检测（D4）
12. 添加配置校验系统（D1）

### Phase 3 — 进阶能力（P2）

13. 实现 `remove` 和 `upgrade` 命令（C4-C5）
14. 插件注册表扩展（D2）
15. Hooks 事件系统（D3）
16. 安全策略层（D5）
17. Helper 自动刷新 + 签名验证（E3-E4）

---

## ruflo 参考文件索引

实现时应参考以下 ruflo 源文件（位于 `<repo-root>\ruflo`）：

| 模块 | 文件路径 | 用途 |
|------|---------|------|
| Init 命令 | `v3/@claude-flow/cli/src/commands/init.ts` | init 命令设计 |
| Init 执行器 | `v3/@claude-flow/cli/src/init/executor.ts` | 初始化编排逻辑 |
| Init 类型 | `v3/@claude-flow/cli/src/init/types.ts` | Zod schema + 预设 |
| Settings 生成 | `v3/@claude-flow/cli/src/init/settings-generator.ts` | settings.json 结构 |
| MCP 生成 | `v3/@claude-flow/cli/src/init/mcp-generator.ts` | .mcp.json 结构 |
| CLAUDE.md 生成 | `v3/@claude-flow/cli/src/init/claudemd-generator.ts` | 多模板生成 |
| Helpers 生成 | `v3/@claude-flow/cli/src/init/helpers-generator.ts` | 辅助脚本生成 |
| CLI Parser | `v3/@claude-flow/cli/src/parser.ts` | 自定义解析器 |
| 模板注册 | `v3/@claude-flow/codex/src/templates/index.ts` | 模板清单机制 |
| CLI 入口 | `v3/@claude-flow/cli/src/index.ts` | CLI 类设计 |
| Config Schema | `v3/@claude-flow/shared/src/core/config/schema.ts` | Zod 配置 schema |
| Plugin Registry | `v3/@claude-flow/shared/src/plugin-registry.ts` | 插件注册机制 |
| Hook Registry | `v3/@claude-flow/shared/src/hooks/registry.ts` | 事件系统 |
| Helper 刷新 | `v3/@claude-flow/cli/src/init/helper-refresh.ts` | 版本戳自动刷新 |
| Helper 签名 | `v3/@claude-flow/cli/src/init/helper-signing.ts` | 完整性校验 |
| MCP 策略 | `.harness/mcp-policy.json` | 安全策略示例 |

---

## 依赖清单

### 包依赖（workspace 内部，无新增运行时依赖）

- `harness → core`（仅此一条；harness 永不依赖 server/cli，防成环）
- `server → core, harness`
- `cli → core, server, templates, harness`

### 运行时依赖

- `zod` — 配置 schema 校验
- `chalk` — 终端彩色输出
- `yaml` — YAML 解析/生成（config.yaml）

### 开发依赖

- `typescript` — 编译器
- `vitest` — 测试框架
- `@types/node` — Node.js 类型定义
- `tsx` — 开发时 TypeScript 执行

<!-- weave:start -->
## Behavioral Rules

- Follow existing code conventions and patterns in this project
- Prefer editing existing files over creating new ones
- Don't add features, refactor, or introduce abstractions beyond the task
- Three similar lines is better than a premature abstraction
- Write no comments unless the WHY is non-obvious
- Never write multi-paragraph explanations in code
- Don't add error handling for states that can't happen

## File Organization

- Source code: `src/`
- Tests: co-located `*.test.ts` or `__tests__/` directories
- Config files at project root
- Use existing directory structure — don't invent new top-level folders

## Weave Commands

- `/review` — Code review current changes
- `/test` — Write or update tests
- `/explain` — Explain selected code
- `/scaffold` — Generate component scaffold

## Skills

Reusable skills live in `skills/` (agent skills standard: one directory per
skill with a `SKILL.md`). Invoke a skill by name when the task matches one.

<!-- weave:end -->
