# weave

> This file is managed by [weave](https://github.com/zijing66/weave) — a coding-agent harness.
> Re-run `weave init` to regenerate.

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

<!-- 以下节写在标记块外：weave init 只按 weave:start/end 合并标记块，块外人工内容 append-only 保留（packages/weave-cli/src/init/claudemd-gen.ts mergeClaudeMd）。 -->

## Architecture

- 抽象类全仓**仅两处**、皆为模板方法：`InitPipeline`（`weave-harness/src/init/pipeline.ts`，经 `@weavecode/harness` 导出）固定 init 骨架；`TerminalBackend`（`packages/weave-server/src/daemon/opener.ts`）固定终端后端骨架「取候选 → 按序尝试 → 全失败抛真相」，子类只填候选与真正不同的流程（wezterm 覆写 `run` 走 mux），`settings → 后端` 的唯一入口 = `terminalBackendFor`，「这个 preset 能不能反查已开窗口」归后端的 `enumerable`——调用方不得散写 preset 白名单。本条曾写作「不新增其他抽象类」，那是**过时描述**而非禁令；新增抽象类按需即可，但扩张前先与项目所有者确认。
- 六能力槽（init / events / assets / resume / detect / plugins）+ `HarnessRegistry` 统一装配；harness 专属实现各自落 `weave-harness/src/<name>/`（claude/、codex/），server/cli 只做装配编排，不写 harness 硬编码。
- 依赖硬约束：`@weavecode/harness → @weavecode/core` 是唯一 harness 外向依赖；core 只放纯类型与表（`HARNESS_*` 注册表）。
- web（`packages/weave-server/web`）仅 `import type` 引用 core/harness（tsconfig paths + vite alias 源码直引）。
- 面向抽象与接口编程、避免硬编码：harness 专属格式/路径/键形不得在 server、cli、web 内自拼或散写，一律经能力面（`PluginSurface` / `AssetSurface` 等）取；server 只传语义参数（如「包名 + 市场身份」），harness 负责自己的表示法。
- 插件注册键形 `<name>@<marketplace>` 是 harness 知识，唯一拼装点 = `PluginSurface.pluginKey(name, market?)`（`weave-harness/src/driver.ts`）；server/cli 不自拼键形，web 只渲染不解析（`@` 后 = 所属市场 = 插件的 namespace）。
- 市场身份判据唯一实现 = `packages/weave-server/src/market/identity.ts` 的 `marketIdOf`（包在 `<dataDir>/market/<id>/` 下 → `name@<id>`，否则 weave 自建市场 `name@weave`）；scanner 与 toolkit 同源取用，不得各自实现。
- **SSE 单通道**：dashboard ↔ 服务端只有一条事件流 = `GET /events`（`packages/weave-server/src/daemon/server.ts` 的 `handleSse`），帧形 `data: {type: ...}`——`asset`/`project`/`hook` 是既有域；`push`（后端已算好载荷，前端直写状态）与 `invalidate`（只给 `key`，前端按 key 调既有 fetcher 重拉）是数据域，键表见 `daemon/data-bus.ts` 的 `DataKey`。前端唯一客户端 = `packages/weave-server/web/src/lib/sse.ts`，**不得再 `new EventSource`、不得写定时轮询**；无事件源的数据（终端窗口数、会话存活）由后端隐藏刷新器（形状同 `daemon/terminal-counts-refresher.ts`）只在值变化时推、且只在有 SSE 客户端时才探。
- 架构总纲参考 `docs/plan/template-method-harness-refactor.md`。
