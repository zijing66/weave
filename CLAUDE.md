# weave

> This file is managed by [weave](https://github.com/weave) — a coding-agent harness.
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

- 全仓唯一 abstract class = `InitPipeline`（`weave-harness/src/init/pipeline.ts`，经 `@weave/harness` 导出），模板方法范式；不新增其他抽象类。
- 六能力槽（init / events / assets / resume / detect / plugins）+ `HarnessRegistry` 统一装配；harness 专属实现各自落 `weave-harness/src/<name>/`（claude/、codex/），server/cli 只做装配编排，不写 harness 硬编码。
- 依赖硬约束：`@weave/harness → @weave/core` 是唯一 harness 外向依赖；core 只放纯类型与表（`HARNESS_*` 注册表）。
- web（`packages/weave-server/web`）仅 `import type` 引用 core/harness（tsconfig paths + vite alias 源码直引）。
- 面向抽象与接口编程、避免硬编码：harness 专属格式/路径/键形不得在 server、cli、web 内自拼或散写，一律经能力面（`PluginSurface` / `AssetSurface` 等）取；server 只传语义参数（如「包名 + 市场身份」），harness 负责自己的表示法。
- 插件注册键形 `<name>@<marketplace>` 是 harness 知识，唯一拼装点 = `PluginSurface.pluginKey(name, market?)`（`weave-harness/src/driver.ts`）；server/cli 不自拼键形，web 只渲染不解析（`@` 后 = 所属市场 = 插件的 namespace）。
- 市场身份判据唯一实现 = `packages/weave-server/src/market/identity.ts` 的 `marketIdOf`（包在 `<dataDir>/market/<id>/` 下 → `name@<id>`，否则 weave 自建市场 `name@weave`）；scanner 与 toolkit 同源取用，不得各自实现。
- 架构总纲参考 `docs/plan/template-method-harness-refactor.md`。
