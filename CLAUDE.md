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
- 九能力槽（init / events / assets / resume / detect / plugins / pluginState / messaging / capture）+ `HarnessRegistry` 统一装配；`driver.ts` 的 `HarnessCapability` 是能力槽唯一权威，server/cli/web 不自造槽清单。harness 专属实现各自落 `weave-harness/src/<name>/`（claude/、codex/），server/cli 只做装配编排，不写 harness 硬编码。
- **消息/编排域**（设计全文 `docs/plan/session-orchestration.md`）：`MessagingSurface`（messaging 槽）声明通道能力（发现 / inject 忙排 / headless 闲投 / watch idleSignals）与不支持原因，投递裁决唯一单点 = server 的 `MessageDeliverer`（404/409 语义拒绝；auto 忙→inject、绝无头抢占忙会话）；`GET /messaging/capabilities` 纯派生矩阵、无第二事实源——web 按钮与模式选项全表驱动，不写死 harness 白名单。触发源 ⊥ 投递通道：manual（dashboard 唯一人工面——`weave msg` 已移除，人在终端直接在目标会话窗口输入）、idle watch、序列各是「一张表 + 一个引擎」的加法模块，统一收敛到 `MessageDeliverer.send`，**不预抽 `TriggerSource` 统一接口**（三种以上触发源形态收敛后再议）；手动发送**缺省 inject**——开着的会话下一拍注入、未开的入 outbox 队列随其下次 SessionStart 加载（不默认无头抢占；auto 忙→inject/闲→headless 的裁决语义保留给编排显式选择）；headless 规格声明 `promptStdin=true`：prompt 走 stdin、命令行无用户内容，win32 的 `.cmd` shim 由此可经 shell 安全启动（shell 模式禁 detached——实测该组合丢管道输出）；序列（`session_sequences`）状态全在 DB 行（`steps[].messageId` = 重启恢复判据），hop 上限 = 步数 ≤3。实时刷新走既有 hook 帧域的 kind 扩展（`message.*` / `watch.fired` / `sequence.*`），无 invalidate 语义不扩 `DataKey`。
- 依赖硬约束：`@weavecode/harness → @weavecode/core` 是唯一 harness 外向依赖；core 只放纯类型与表（`HARNESS_*` 注册表）。
- web（`packages/weave-server/web`）仅 `import type` 引用 core/harness（tsconfig paths + vite alias 源码直引）。
- 面向抽象与接口编程、避免硬编码：harness 专属格式/路径/键形不得在 server、cli、web 内自拼或散写，一律经能力面（`PluginSurface` / `AssetSurface` 等）取；server 只传语义参数（如「包名 + 市场身份」），harness 负责自己的表示法。
- 插件注册键形 `<name>@<marketplace>` 是 harness 知识，唯一拼装点 = `PluginSurface.pluginKey(name, market?)`（`weave-harness/src/driver.ts`）；server/cli 不自拼键形，web 只渲染不解析（`@` 后 = 所属市场 = 插件的 namespace）。
- 市场身份判据唯一实现 = `packages/weave-server/src/market/identity.ts` 的 `marketIdOf`（包在 `<dataDir>/market/<id>/` 下 → `name@<id>`，否则 weave 自建市场 `name@weave`）；scanner 与 toolkit 同源取用，不得各自实现。
- **SSE 单通道**：dashboard ↔ 服务端只有一条事件流 = `GET /events`（`packages/weave-server/src/daemon/server.ts` 的 `handleSse`），帧形 `data: {type: ...}`——`asset`/`project`/`hook` 是既有域；`push`（后端已算好载荷，前端直写状态）与 `invalidate`（只给 `key`，前端按 key 调既有 fetcher 重拉）是数据域，键表见 `daemon/data-bus.ts` 的 `DataKey`。前端唯一客户端 = `packages/weave-server/web/src/lib/sse.ts`，**不得再 `new EventSource`、不得写定时轮询**；无事件源的数据（终端窗口数、会话存活）由后端隐藏刷新器（形状同 `daemon/terminal-counts-refresher.ts`）只在值变化时推、且只在有 SSE 客户端时才探。
- **web 移动端适配**（`packages/weave-server/web`）：断点 `lg` 二分——桌面三栏原样保留，`<lg` 单列 + 左右栏滑出抽屉；桌面 inline 栏与移动抽屉复用同一 JSX 常量、`isDesktop` 互斥渲染（不双挂载/双请求），断点与指针查询唯一入口 = `web/src/lib/use-media-query.ts`。改/新增 web 布局的硬约束：①视口高度用 `dvh` 不用 `vh`；桌面向 `calc(100dvh-常量)` 的减数是桌面横排预算，`<lg` 上方堆叠更多内容必失真 → 窄屏改视口比例（事件链画布 `h-[52dvh]`）；②hover 才可见的操作按钮触屏不可达 → 补 `max-lg:opacity-100` 一类常显；③拖拽传感器按 `(pointer: fine)` 分流（鼠标 PointerSensor 位移 5px / 触屏 TouchSensor 长按 200ms 容差 8px），不裸用 PointerSensor；④固定宽列（列头/数据行）必须同构收缩（同一组 width 工具类），放不下的列折进行内第二行（`basis-full`）或 `hidden lg:block`，不做横向滚动；⑤纵向 flex 堆叠的下区要 `min-h-0` 才能收缩，否则被外层 `overflow-hidden` 裁掉。
- **资源管理三层模型**：①市场副本层（`<dataDir>/market/<id>/` 导入/移除，LibraryPanel 资源市场侧栏；移除 = 删副本 + 注销宿主市场（`PluginSurface.removeMarketplace` 按落点反查注册名，best-effort；宿主级联卸载该市场的插件含数据，UI 有破坏性确认），非插件装面副本不级联）②安装/卸载层（数据目录 → 装到目标位与卸回：项目 skills/files/MCP、toolkit 包、全局个人 skills 软链、CC 插件包经 `POST /projects/:id/plugins/uninstall`→`PluginSurface.uninstall`，harness 注册表级、与市场源存亡无关）③启用/停用层（包开关/Switch/settings 落盘）。各层操作互不越级：删市场副本 ≠ 卸载，停用 ≠ 卸载。
- 架构总纲参考 `docs/plan/template-method-harness-refactor.md`。
