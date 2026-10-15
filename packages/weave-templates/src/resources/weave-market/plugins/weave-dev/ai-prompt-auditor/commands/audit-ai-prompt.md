---
name: audit-ai-prompt
description: Audit and refresh the dashboard AI assistant's system-prompt sources against the codebase
---

对 AI 助手提示词三源做一次新鲜度审计：委托 `ai-prompt-auditor` 子 agent 按其审计规程执行——抽取 `docs/FEATURES.md`、`docs/ARCHITECTURE.md` 与内置市场 `SKILL.md` 的事实主张，逐条对照代码权威（CLI 命令注册表、daemon 路由、设置键、包清单），产出差异清单并直接落盘修复，最后跑 `builtin-market.test.ts` 回归。

若无差异，明确说「三源与代码一致」，不要为了产出而改写。
