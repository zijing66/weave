# Weave Harness — 实施计划

> 更新日期：2026-08-07 | 状态：文档阶段已完成，准备进入 Phase 1 编码

## Context

基于 ruflo（claude-flow v3.34.0）的设计理念，创建名为 **weave** 的 Claude Code harness 工具。核心能力：对任意已有项目执行 `weave init`，注入 Claude Code 插件能力（skills、commands、agents、helpers、settings.json、MCP 配置等）。

---

## 技术决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 语言 | TypeScript ESM (ES2022) | 与 ruflo 一致 |
| 包管理 | pnpm monorepo | 便于后续分包扩展 |
| CLI 框架 | 自定义 parser | 参考 ruflo 的 parser.ts，支持子命令嵌套 |
| 校验 | Zod | 配置 schema 运行时校验 |
| 测试 | vitest | ESM 原生，快速 |

---

## 实施步骤

### Step 1: 功能范围文档 ✅

`docs/FEATURES.md` — 覆盖 A1-E4 全部 20 项功能，含优先级和 ruflo 参考。

### Step 2: CLAUDE.md 项目指引 ✅

`CLAUDE.md` — 技术栈、monorepo 结构、开发规范、核心命令、路线图、ruflo 参考索引。

### Step 3: Phase 1 — 核心骨架（P0）

1. 初始化 pnpm monorepo（`pnpm-workspace.yaml`、`tsconfig.base.json`）
2. 实现 `weave-core`：Zod schema、平台检测、工具函数
3. 实现 `weave-cli`：自定义 `CommandParser`、`init` 命令
4. 实现 `weave-templates`：`TemplateRegistry` + 初始模板集
5. 实现 `init` executor：目录注入 → settings.json → CLAUDE.md
6. 实现 `status` 命令

### Step 4: Phase 2 — 完善功能（P1）

7. MCP 配置生成（A3）
8. Runtime 配置（A5）
9. 扩展模板：commands、agents、helpers（B2-B4）
10. `doctor` 和 `add` 命令（C2-C3）
11. 项目自动检测（D4）
12. 配置校验系统（D1）

### Step 5: Phase 3 — 进阶能力（P2）

13. `remove` 和 `upgrade` 命令（C4-C5）
14. 插件注册表扩展（D2）
15. Hooks 事件系统（D3）
16. 安全策略层（D5）
17. Helper 自动刷新 + 签名验证（E3-E4）

---

## 关键 ruflo 参考文件

| 模块 | ruflo 路径 | 用途 |
|------|-----------|------|
| Init 命令 | `v3/@claude-flow/cli/src/commands/init.ts` | init 流程设计 |
| Init 执行器 | `v3/@claude-flow/cli/src/init/executor.ts` | 初始化编排逻辑 |
| Init 类型 | `v3/@claude-flow/cli/src/init/types.ts` | Zod schema + 预设 |
| Settings 生成 | `v3/@claude-flow/cli/src/init/settings-generator.ts` | settings.json 结构 |
| MCP 生成 | `v3/@claude-flow/cli/src/init/mcp-generator.ts` | .mcp.json 结构 |
| CLAUDE.md 生成 | `v3/@claude-flow/cli/src/init/claudemd-generator.ts` | 多模板生成 |
| Helpers 生成 | `v3/@claude-flow/cli/src/init/helpers-generator.ts` | 辅助脚本生成 |
| CLI Parser | `v3/@claude-flow/cli/src/parser.ts` | 自定义解析器 |
| 模板注册 | `v3/@claude-flow/codex/src/templates/index.ts` | 模板清单机制 |
| CLI 入口 | `v3/@claude-flow/cli/src/index.ts` | CLI 类设计 |

---

## 产出文件清单

| 文件 | 状态 | 说明 |
|------|------|------|
| `docs/FEATURES.md` | ✅ 完成 | 完整功能范围（20 项，P0/P1/P2） |
| `CLAUDE.md` | ✅ 完成 | 项目指引（技术栈、规范、路线图） |
| `docs/PLAN.md` | ✅ 完成 | 本文件，实施计划 |
