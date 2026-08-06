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
│   │   │       ├── executor.ts    # 初始化编排器
│   │   │       ├── settings-gen.ts
│   │   │       ├── mcp-gen.ts
│   │   │       ├── claudemd-gen.ts
│   │   │       └── helpers-gen.ts
│   │   ├── bin/
│   │   │   └── cli.js             # Shebang 入口
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
- 示例：`feat(cli): add init command with preset selection`

### 测试要求

- 纯函数必须有单元测试
- 生成器函数测试：验证输出结构和关键内容
- 使用 vitest，测试文件放在同级 `__tests__/` 目录
- 文件名：`*.test.ts`

---

## 核心命令

| 命令 | 功能 | 优先级 |
|------|------|--------|
| `weave init` | 注入 harness 到当前项目 | P0 |
| `weave status` | 查看 harness 状态 | P0 |
| `weave doctor` | 诊断配置问题 | P1 |
| `weave add <type> <name>` | 动态添加组件 | P1 |
| `weave remove <type> <name>` | 移除组件 | P2 |
| `weave upgrade` | 更新到新版本 | P2 |

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

实现时应参考以下 ruflo 源文件（位于 `D:\GitRepo\AIRepo\ruflo`）：

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

### 运行时依赖

- `zod` — 配置 schema 校验
- `chalk` — 终端彩色输出
- `yaml` — YAML 解析/生成（config.yaml）

### 开发依赖

- `typescript` — 编译器
- `vitest` — 测试框架
- `@types/node` — Node.js 类型定义
- `tsx` — 开发时 TypeScript 执行
