# 插件化机制对比研究：dsh 与 Claude Code mods

> 本文档是 weave 插件体系（见 `docs/PLUGIN-SPEC.md`）的**外部参考研究**：
> 深度调研 deepseek-harness（dsh）与 Claude Code（`mods/` 及其插件体系）两套
> 插件化机制，对照 weave 现状，记录可借鉴的设计与明确不抄的部分。
> 研究基于两个仓库的实际源码（路径与行号见 §6），仅作参考意见，不构成实施承诺。

## 1. 背景与定位

| 对象 | 一句话定性 |
|---|---|
| **deepseek-harness（dsh）** | DeepSeek 开源 agent harness，口号 "Everything is a Plugin"——宿主本身就是一棵 Cordis 插件树，模型适配器、工具注册表、agent loop 皆为可替换插件 |
| **Claude Code** | Anthropic 官方仓库：**经典插件**（`plugins/`：commands/agents/skills/JSON hooks/MCP + marketplace）与 **function-hooks mod**（`mods/`：`register(on, options)` 代码式钩子）双体系并存 |
| **weave（现状）** | 自有 `weave-plugin.json` manifest + rules.json + handler.mjs 的 SPI 体系：三根目录扫描、热重载、`plugin_states` 开关、四通道分发（见 `docs/PLUGIN-SPEC.md`） |

## 2. dsh（deepseek-harness）机制速览

**框架 = vendored Cordis。** 插件即模块：

```ts
export const name = 'hello-plugin'
export const inject = ['tools']                 // 服务依赖按名字声明
export const Config = Schema.object({ … })      // Schemastery schema，加载时校验+默认值
export function apply(ctx: Context, config: Config) { … }
```

- **注册即 effect**：所有注册（`ctx.on`、`ctx.tools.register`、定时器…）返回 disposer
  并由框架托管——卸载/热更/服务消失时自动逆序回滚，清理是框架职责而非插件作者职责。
- **生命周期**：`PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED`（失败 `FAILED`）；
  注入的服务消失 → 依赖者自动卸载，服务回归 → 自动重新加载（能力可热替换）。
- **组合纯声明式，两份 manifest**：`dsh.bundle` 回答「本包贡献什么」（一段 patch），
  `dsh.profile` 回答「启动形态按什么顺序叠哪些 bundle」——包作者与部署者职责解耦。
- **4 层 patch 覆盖**：bundle → profile → home → `--patch`，写在 `cordis.patch.yml`，
  按行 `id` 寻址、后层**整值替换**（无深合并）、`disabled` 可写 `!!js` 表达式
  （配置即代码，审计面大）。
- **事件系统**：5 种分发模式（emit / waterfall / parallel / serial / bail）× 三域事件
  （session 持久事实 / agent 活体 / capability 接缝）；关键策略点分层——
  `tools/pre-execute`（allow/deny/**ask**）→ `guard`（单调 deny，不可被解）→
  `tools/execute`（唯一可换 signal）→ `tools/post-execute`（变换结果）→
  `tools/result`（只读观察）。
- **扩展面**：工具/命令注册表、92 个 `ctx.*` 服务接缝（llm/fs/shell/sandbox/subagents…）、
  UI slots、`dsh.client` 浏览器插件轴、Claude Code/Codex `hooks.json` 兼容桥。
- **分发 = npm 生态**（无自建 marketplace）：安装管线 inspect（spec 形态/是否已装）→
  GitHub 可达预检 → 版本门 → 多 registry fallback（私有源永不回落公共）→ 逐失败
  回滚 `package.json` 快照 → 启用；结果是结构化 **`ChangeResult`**
  （错误码 `not-found|network|incompatible-version|…` + 状态 `applied|restart-required|failed|…`）。
- **peer 版本门**：对 `@deepseek-ai/dsh*` 的 range 在**插件模块被 import 之前**拦截；
  越权放行 = `compatibility.json` 的**精确版本豁免**（`pkg@version → [runtime]` 对，
  写入须 `--accept-risk`，升级不继承）。
- **状态全落文件**（`package.json` bundles / `cordis.patch.yml` disabled+config /
  `compatibility.json` / `allowBuilds`），无插件状态数据库。
- **信任模型**：无签名、无 provenance、**无沙箱**——同进程全信任，SAFETY.md 自认未审计；
  信任只发生在安装时刻（含构建脚本白名单 `allowBuilds` 的显式批准）。

## 3. Claude Code mods 机制速览

**双体系并存。** 经典插件走目录约定（`.claude-plugin/plugin.json` + `commands/ agents/
skills/ hooks/hooks.json/ .mcp.json`）；mod 是「行为住在 hooks module 里的插件」：
`hooks/hooks.json` 写 `"modules": ["./register.ts"]`，模块契约

```ts
export type Register = (on: On, options: PluginOptions) => unknown;
// options = manifest userConfig 的值（含默认），变更即重载并重新 register
```

经典 JSON hooks 经 `classic.*` 命名空间包进同一条钩子链——声明式与代码式互不知晓的
两套系统被统一成一层。

- **三层事件空间**：引擎事件（`tool.call / tool.check / ui.render / prompt.submit /
  agent.spawn / session.* / turn.* / plugin.register / engine.create…`）+ `classic.*`
  + `$` 操作事件（每次对 `$` 的调用本身也可拦截）。
- **五 tier 洋葱链** `prepend → user → append → builtin → core`：越外层权威越高；
  `next.origin` 由宿主钉死不可伪造；`next.to()` 只允许**向更低权威层跳**；
  `next.trace` 可审计谁放宽了什么。组织策略（managed）与用户插件的优先级被做进调度器本体。
- **`plugin.register` 准入事件**：每个 hooks module 装载前触发，宿主给出钉死的
  `{name, tier, root, version, provenance, uses}`（`uses` = **静态扫描**插件源码得到的
  事件/调用清单），闸门返回 `{refuse}` 则该模块整体不得装载，fail-closed。
- **`engine.create` fold**：插件后序叠加「名词」（能力对象）到 `$`——可**扣留**别人的
  名词但**不可替换**，违者整个插件被卸载并点名双方；类型侧用 declaration merging
  （`mods/types/claude-code.d.ts` 单一契约，13186 行）。
- **`userConfig` schema**：manifest 内声明类型/默认值/枚举/required → **加载前校验**，
  枚举自动画成 `/config` 选择器，敏感值进 secure storage；**项目级 settings 不可写插件
  选项**（防仓库投毒）。
- **信任 = 策略型**（同样无签名）：marketplace 白名单 `strictKnownMarketplaces` 与
  黑名单 `blockedMarketplaces`、官方源背书才预授权 `allowed-tools`、安装时
  `--accept-command <sha256>` 精确接受某条命令、路径围栏（禁 `../` / symlink 逃逸）。
- **失败与预算**：`HookBudget`（自身代码 10s / `.catch` 宽限 1s / 滞留 5s，等待
  `next`/`$` 时钟停止）；钩子抛错/超时 → 该钩子被跳过、下方 core 兜底，
  "a broken plugin never blocks a prompt"。
- **热重载粒度**：仅变更的模块重载；若模块触及 `engine.create`/`plugin.register`
  则全量重建（改 fold 会影响别人的 `$`）；`--plugin-dir` 监听运行中目录增删。

## 4. 三方对比表

| 维度 | weave（现状） | dsh | Claude Code |
|---|---|---|---|
| 插件定义 | 自有 manifest（rules/handlers/templates/mcpServers/subscribe/config） | npm 包 + `dsh.bundle` patch + Cordis 模块 | `.claude-plugin/plugin.json` + hooks module / 经典目录 |
| 发现 | 三根目录 SPI 扫描 + 热重载 1s | 纯声明式 profile/bundle 枚举，无目录扫描 | 默认目录约定 + manifest 补充路径（只增不替）+ `--plugin-dir` |
| 扩展点 | 规则 / 处理器 / 模板 / MCP / 订阅 / 指令模板 | 事件 5 模式 + 服务接缝 + 工具/命令 + UI slots | 三层事件空间 + 目录组件 + `engine.create` 名词 fold |
| 配置覆写 | `plugin_states.config`（整段 JSON） | 4 层 patch 按行 id 整值替换 + `!!js` | `userConfig` schema 校验 + `pluginConfigs` 多作用域 |
| 依赖/兼容 | `engines.weave` 字段**未强制** | peer range **import 前**拦截 + 精确豁免 | `dependencies` 版本区间 + 依赖自动 enable / 禁用保护 |
| 权限/分层 | origin（builtin/global/project）仅来源标记 | isolate realm + scope 链 + guard 单调 deny | 五 tier 洋葱链 + 准入闸门 + provenance 宿主钉死 |
| 失败隔离 | 单插件 rejected 不阻断 + handler 超时竞速 | fiber FAILED 不影响他人；effect 自动回滚 | 钩子失败即跳过 core 兜底；`HookBudget` |
| 分发 | 四通道（扫描 / install / search / export） | npm registry + pnpm 管线（结构化 `ChangeResult`） | marketplace.json + `claude plugin *` 命令族 |
| 信任 | 本地目录即信任，install 打印警告 | 同：安装时刻人类决定，无签名无沙箱 | 策略型白名单 + sha256 命令接受 + 路径围栏，无签名 |
| 契约/文档 | `PLUGIN-SPEC.md` 手写（AI 生成基准） | **代码生成**的事件矩阵/API 目录 + CI 校验新鲜度 | `.d.ts` 单一契约 + `claude plugin test/validate` |

值得注意的横向结论：**三者都没有代码签名**——「本地/已装即信任 + 安装时刻的人类
决定」是当前 harness 插件生态的共识下限；weave 的信任模型不落后，风险提示写清即可。

## 5. 对 weave 的启发（参考意见）

### 高价值（建议后续考虑）

1. **`config` 升级为类型化 userConfig schema**（抄 CC）
   manifest `config` 现为无 schema 的裸对象。升级为字段声明 `{type, default, enum,
   required, title, description}` → 加载时校验 + 默认值填充 → dashboard 依 schema 自动
   生成插件配置表单（枚举画选择器）→ 覆写持久化 `plugin_states.config` 合并为
   `ctx.config`。敏感字段可留 secure 存储位。
2. **`engines.weave` 版本门强制化 + 精确豁免**（抄 dsh 的 peer 门）
   现规范注明「暂不强制校验」。改为加载时 semver 拦截（不匹配 → rejected 且原因明确），
   在 import handler 之前完成；越权放行用精确版本豁免清单（`accept-risk` 语义）。
3. **`weave plugins install` 结构化状态机**（抄 dsh `ChangeResult`）
   inspect（spec 形态 / 是否已装 / 是否插件）→ 预检（git 可达、版本门）→ 安装 →
   启用，全程结构化错误码（`not-found | network | incompatible-version | not-a-plugin | …`）
   与 `application` 状态（`applied | restart-required | failed`）。多 registry fallback 可后置。
4. **provenance 统一命名**（抄 CC `<id>@<marketplace|inline|builtin>`）
   插件来源从「origin 枚举 + installed.json 附带信息」统一为 `<id>@<source>`
   （builtin / global-dir / project-dir / inline / git / npm），dashboard 与 CLI 徽标同源，
   同一插件的「扫描发现」与「命令安装」身份可区分。

### 中价值（backlog）

5. **规则级用户覆盖**（抄 dsh 行寻址思想）：upsert 现只保 `enabled`；可扩展为用户可
   覆盖单条规则的任意定义字段（存 `plugin_states.config` 的 `ruleOverrides`），
   插件更新不吞用户改动。
6. **扩展点文档由代码生成**（抄 dsh）：脚本从 Zod schema（manifest/HandlerConfig）
   生成字段表与 handler 分类学，diff 进 CI——`PLUGIN-SPEC.md` 是「AI 生成基准」，
   腐烂代价高。
7. **handler.mjs 类型契约**：发布 `weave-plugin` 类型包（ctx/event/返回值契约的
   `.d.ts`/JSDoc），`weave plugins validate` 输出与加载器一致的静态 uses 清单
   （对齐 CC `claude plugin validate`）。
8. **hook 分类学 phase**（抄 dsh pre-execute / guard / execute / post 四层）：为未来
   「策略型规则」（deny/ask 类，不止 log/inject）预留 `phase` 枚举——**与 D3
   「不做阻断门禁」的既有决策冲突，须重新决策后才动**。

### 明确不建议抄

- dsh 的 4 层 patch × `!!js` × isolate realm 认知复杂度——weave 取两层
  （插件默认 + 用户覆写）即够；
- CC 的五 tier 洋葱链与 `engine.create` fold——weave 无组织策略场景，成本远超收益；
- 任何「签名/沙箱」承诺——两参考项目都没有，维持「本地目录即信任 + install 警告」，
  把风险如实写进规范 §1 即可（现状已如此）。

## 6. 关键出处

### dsh（`D:\GitRepo\AIRepo\deepseek-harness`）

| 位置 | 内容 |
|---|---|
| `docs/architecture.md` | 分层（profile/bundle/patch）、三域事件、扩展点总表 |
| `vendor/include/src/index.ts:57-127` | `applyEntryPatches`——全部 patch 语义（行 id 寻址、整值替换） |
| `vendor/loader/src/config/entry.ts:10-23` | Loader entry schema（id/name/config/group/disabled/inject） |
| `packages/util/package-manifest/src/types.ts:30-94` | `dsh.bundle` / `dsh.profile` / `dsh.client` manifest |
| `packages/boot/app-boot/src/plugin-compatibility.ts:61-88` | peer 版本门（import 前拦截） |
| `packages/boot/plugin-manager/src/types.ts:116-143` | `ChangeResult` 状态机与失败分类 |
| `packages/boot/plugin-manager/src/patch.ts:14-43` | 启停状态落盘方式（`writePluginEnabled`） |
| `docs/event-producer-consumer.md` | **代码生成**的事件生产者/消费者矩阵（CI 校验新鲜度） |
| `docs/capability-seams.md:574-665` | 92 个 `ctx.*` 服务接缝目录 |
| `SAFETY.md` | 信任边界自述（无沙箱、插件可损毁主机） |

### Claude Code（`D:\GitRepo\AIRepo\claude-code`）

| 位置 | 内容 |
|---|---|
| `mods/README.md` | mod 定义、四内置 mod、`--plugin-dir` / `claude plugin test`、early-access 声明 |
| `mods/types/claude-code.d.ts` | 全部类型契约：`TIERS`（五层）:9743、`HookBudget`:4228、`PluginOptions`/userConfig:6181、`PluginRegisterInput`:6203、`plugin.register`:3617、`engine.create`:3652、`Register`:7413 |
| `mods/sec-default/hooks/register.ts:106-114` | `plugin.register` 准入闸门实现（fail-closed） |
| `mods/agents-md/.claude-plugin/plugin.json:8-22` | `userConfig` schema 实例 |
| `mods/telemetry/hooks/register.ts:53-56` | `engine.create` 名词叠加示例 |
| `.claude-plugin/marketplace.json` | marketplace 清单字段实样 |
| `plugins/README.md:47-61` | 经典插件目录结构 |
| `plugins/plugin-dev/` | 官方插件开发工具包（skill + validator agent + create-plugin） |
| `CHANGELOG.md` | 插件生命周期 / 信任策略 / manifest 字段演进的权威记录 |
