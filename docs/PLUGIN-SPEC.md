# Weave 插件规范（PLUGIN-SPEC）

> 本文档是 weave 插件的**唯一权威规范**。AI 可仅凭本文档生成完整可用的插件目录；
> 加载器校验即 smoke 检查（见文末清单）。
> 外部机制对比与借鉴意见见 `docs/PLUGIN-RESEARCH.md`（研究参考，非规范）；
> 跨 harness 统一机制（targets/harness 维度等）的演进方案见 `docs/CROSS-HARNESS-DESIGN.md`。

## 1. 概述与信任模型

一个 weave 插件 = 一个**自包含目录**，核心是 `weave-plugin.json` manifest + 可选的
`rules.json`（hook 规则）+ 可选的 `handler.mjs`（自定义处理器）+ 可选的模板/指令文件。
把目录放到约定位置，daemon 启动/热重载时**自动识别**并注册（SPI 式接入），无需任何显式配置。

**信任模型 = 本地目录即信任**（与 Claude Code 插件同模型）：`handler.mjs` 是任意可执行
JS，放在扫描目录里就等于授权运行。分发渠道（git/npm URL）安装时会打印来源警告；
项目级 `.weave/plugins/` 随 git 走，信任级与审查源码相同。**不要**从不可信来源安装插件。

## 2. 目录结构

```
<插件根目录>/                    # 见 §6 扫描位置
└── my-plugin/                   # 目录名建议 = manifest.id（kebab-case）
    ├── weave-plugin.json        # 必需：manifest
    ├── rules.json               # 可选：hook 规则数组（manifest.rules 引用）
    ├── prompts/                 # 可选：inject/manual 指令模板
    │   └── check-docs.md
    ├── handler.mjs              # 可选：自定义处理器（ESM）
    ├── skills/                  # 可选：模板注入（扩展点③）
    │   └── my-skill/SKILL.md
    ├── commands/foo.md          # 可选
    ├── agents/bar.md            # 可选
    └── README.md                # 可选：人类说明
```

## 3. manifest（`weave-plugin.json`）

```jsonc
{
  "manifestVersion": 1,             // 必需，当前规范版本 = 1
  "id": "my-plugin",                // 必需，^[a-z][a-z0-9-]{0,63}$，全局唯一
  "name": "我的插件",                // 必需，显示名
  "version": "1.0.0",               // 必需，semver（X.Y.Z 或 X.Y.Z-prerelease）
  "description": "……",              // 可选
  "author": "……",                   // 可选
  "engines": { "weave": ">=0.1.0" },// 可选（暂不强制校验）
  "rules": ["rules.json"],          // 可选，默认 []：规则文件列表（相对路径）
  "handlers": [                     // 可选：自定义处理器入口
    { "type": "doc-lint", "entry": "handler.mjs" }
  ],
  "requires": { "events": ["PostToolUse"] },  // 可选：依赖的采集事件，未知事件 → 加载 rejected
  "templates": {                    // 可选：扩展点③，init 时复制进项目
    "skills": ["skills/my-skill"],
    "commands": ["commands/foo.md"],
    "agents": ["agents/bar.md"]
  },
  "mcpServers": { … },              // 可选：扩展点④（schema 已就位，消费方落地中）
  "subscribe": { "events": [...], "entry": "subscriber.mjs" },  // 可选：扩展点⑦（落地中）
  "config": { "depth": 2 }          // 可选：默认配置，用户经 plugin_states 覆写后进 ctx.config
}
```

约束：

- `id` 以 `weave-` 开头为**内置预设命名空间保留**，用户插件用该前缀 → 加载 rejected。
- 同 `id` 的插件出现在多个位置 → **先加载者胜**，后者 rejected（重复 id 报错）。
- manifest 任一字段校验失败 → **整个插件 rejected**（不影响其他插件），原因记入插件列表。

## 4. 规则文件（`rules.json`）

JSON 数组，每个元素 = `HookRule` 去掉 `id`/`projectId`（加载器生成）：

```jsonc
{
  "name": "文档更新检查",            // 必需
  "enabled": false,                 // 可选，默认 true；用户在 dashboard 的开关改动永远被保留
  "priority": 10,                   // 可选，默认 0，数值越大越先匹配
  "source": { "kind": "claude-event", "event": "PostToolUse" },  // 必需
  "filter": {                       // 可选，默认 {}
    "toolNames": ["Edit", "Write"],       // 匹配 toolInput 工具名
    "pathGlobs": ["**/*.md"],             // 匹配 toolInput.file_path（glob，posix 分隔）
    "crossProjectOnly": true              // 只在路径命中其他已注册项目根时触发
  },
  "handler": { … },                 // 必需，见下
  "timeoutMs": 10000,               // 可选，handler 执行超时（plugin 分支竞速强杀）
  "record": true                    // 可选，是否落 hook_dispatches（log 默认 false）
}
```

`source.event` 必须是采集面 9 事件之一：
`PreToolUse / PostToolUse / UserPromptSubmit / SessionStart / Stop / SubagentStop / Notification / PreCompact / SessionEnd`。

### 四种内置 handler + 插件 handler

```jsonc
{ "type": "log" }                                            // 只记账+SSE，不入池
{ "type": "webhook", "url": "https://…", "secret": "…", "headers": {} }  // 出站 POST（HMAC/5s/4KB）
{ "type": "inject", "template": "@file:prompts/check.md" }   // 入池(injected) + 注入当前会话
{ "type": "manual", "template": "……" }                       // 只入池(pending)，dashboard 拖拽执行
{ "type": "plugin", "handlerType": "doc-lint", "config": {} } // 自定义处理器（省略 pluginId，加载器填）
```

**inject 限制**：只能挂 `PostToolUse / UserPromptSubmit / SessionStart / Stop / SubagentStop`
（支持同步 `additionalContext` 的白名单事件），挂其他事件 → 加载 rejected。

### `@file:` 模板语法

`inject`/`manual` 的 `template` 可写 `@file:相对路径`（相对插件根目录，路径不得越界），
加载时把文件内容**内联**进规则（落库的是展开文本）。模板变量（渲染时替换）：

| 变量 | 含义 |
|---|---|
| `{event}` | 事件名 |
| `{tool}` | 工具名（Edit/Write/Bash…） |
| `{file}` | toolInput.file_path（posix 归一） |
| `{cwd}` | 会话工作目录 |
| `{session}` | session id |
| `{project}` | 项目路径 |
| `{rule}` | 规则名 |

**workflow 引导约定**：prompts/*.md 中可写「建议使用 Workflow 工具 / fork 子 agent 并行」
类语句——这是给 Claude 的指令内容，daemon 不解析；命中注入后由 Claude 会话自行编排执行。

### 防递归（插件无豁免）

所有入池/注入的指令自动追加隐藏标记 `<!--weave-dispatch-->`，且同 规则×会话 有 60 秒
去重窗口——插件规则与内置规则走 dispatcher 同一条防线。

## 5. 自定义处理器（`handler.mjs`）

ESM，default 导出：

```js
export default {
  type: 'doc-lint',                  // 必须与 manifest.handlers[].type 一致，否则整插件 rejected
  async execute(ctx) {
    // ctx.event   — 归一化事件 payload（eventType/toolName/toolInput/cwd/raw…）
    // ctx.rule    — 命中的完整规则对象
    // ctx.config  — manifest.config 与用户覆写合并后的配置
    // ctx.logger  — debug/info/warn/error（前缀自动带插件 id）
    return {
      prompt: '……',             // 可选：写入指令池（pending，带防递归标记）
      additionalContext: '……',  // 可选：注入当前会话（事件须在 inject 白名单内，否则丢弃）
    };
    // 无返回值 / 抛异常 / 超时 → 静默跳过，永不影响事件采集（ingest 恒 201）
  },
};
```

- 超时：`rule.timeoutMs`（默认 10s）竞速，超时即放弃本次结果。
- handler 的 `entry` 路径必须留在插件目录内（路径穿越 → 加载 rejected）。
- 模块加载带缓存破除查询串，改文件后热重载生效（无需重启 daemon）。

## 6. 扫描位置与生命周期

| 位置 | 作用域 | 规则 projectId |
|---|---|---|
| 内置 `presets/`（随 dist 发货） | builtin | null（全局） |
| `<configDir>/weave/plugins/<id>/` | global | null（全局） |
| `<project>/.weave/plugins/<id>/` | project | 该项目 id |

生命周期：`discovered → validated → active | rejected（校验失败，记原因） | disabled（用户关闭）`。
规则落库为 `origin = builtin|plugin`、`plugin_id = <id>`、稳定 id `plugin:<id>:<序号>`；
**插件更新只覆盖定义字段，用户改过的 enabled 永远保留**。插件级开关（`plugin_states`）
关闭时，其全部规则级联 disabled。

## 7. 分发

- **目录拷贝 / git 仓库**：直接放进扫描位置即生效（项目级随 git 分发）。
- 安装 / 导出 / 搜索：经 dashboard 插件区段与 REST `POST /hooks/plugins`
  （导出/搜索为 server API `exportPlugin`/`searchPlugins`，见分发通道批次落地）。
- 分发包 = 插件目录本身（含 manifest/rules/prompts/handler，剔除 node_modules）。

## 8. 完整示例（AI 生成基准）

以下四文件构成一个完整可加载的插件（`doc-lint-demo`）：

**weave-plugin.json**

```json
{
  "manifestVersion": 1,
  "id": "doc-lint-demo",
  "name": "文档 lint 演示",
  "version": "1.0.0",
  "description": "md 编辑后跑自定义 lint，并可注入修复指令",
  "rules": ["rules.json"],
  "handlers": [{ "type": "doc-lint", "entry": "handler.mjs" }],
  "requires": { "events": ["PostToolUse"] },
  "config": { "maxIssues": 5 }
}
```

**rules.json**

```json
[
  {
    "name": "md lint",
    "priority": 20,
    "source": { "kind": "claude-event", "event": "PostToolUse" },
    "filter": { "toolNames": ["Edit", "Write"], "pathGlobs": ["**/*.md"] },
    "handler": { "type": "plugin", "handlerType": "doc-lint" },
    "timeoutMs": 8000
  },
  {
    "name": "md 修复注入",
    "priority": 19,
    "source": { "kind": "claude-event", "event": "PostToolUse" },
    "filter": { "toolNames": ["Edit", "Write"], "pathGlobs": ["**/*.md"] },
    "handler": { "type": "inject", "template": "@file:prompts/fix.md" }
  }
]
```

**handler.mjs**

```js
export default {
  type: 'doc-lint',
  async execute(ctx) {
    const file = ctx.event?.toolInput?.file_path;
    if (!file) return;
    // 例子：把发现的问题写进指令池，等 dashboard 拖拽执行
    return { prompt: `检查文档 ${file} 的标题层级（上限 ${ctx.config.maxIssues ?? 5} 个问题）` };
  },
};
```

**prompts/fix.md**

```markdown
刚编辑了 {file}，请顺手检查该文档的格式一致性（标题层级、代码块语言标注、失效链接）。
若检查项较多，可用 Workflow 工具并行核对后汇总。
```

## 9. Smoke 校验清单（加载器自动执行）

1. `weave-plugin.json` 存在、JSON 合法、过 manifest schema；
2. `id` 合法且非保留前缀（用户插件）、不与已加载插件重复；
3. `requires.events` ⊆ 采集面 9 事件；
4. 每个规则文件存在、为数组、逐条过规则 schema；inject 挂白名单事件；
5. `@file:` 模板存在且路径不越界；
6. handler `entry` 存在、路径不越界、动态 import 成功、default 导出含
   `type`（与 manifest 一致）与 `execute` 函数；
7. 插件引用的 `handlerType` 均在 `manifest.handlers` 声明；
8. 全部通过 → 规则 upsert 入库、handler 注册、状态 `active`；任一失败 → 整插件
   `rejected`（已入库规则回滚删除），**不阻断其他插件**。

满足本清单 = 加载成功；加载成功 + 规则可被命中 = 插件可用。

## 10. 开发流程（AI 生成插件）

插件开发的标准姿势就是让 AI 照本文档生成，无需读 weave 源码：

1. **给 AI 的提示词**（可直接复制）：
   > 阅读 `docs/PLUGIN-SPEC.md`，按规范生成一个插件目录 `<id>`，需求：……
   > 输出全部文件内容（weave-plugin.json / rules.json / prompts/ / handler.mjs）。
2. **落盘**：把生成的目录放进任一扫描位置
   （`<configDir>/weave/plugins/`、项目 `.weave/plugins//`）。
3. **验证**：daemon 1 秒内热重载（或 dashboard 插件区段查看状态）——
   `active` 即通过 smoke；`rejected` 的 error 字段会给出具体失败项。
4. **联调**：dashboard Hooks 面板启用插件规则 → 触发对应事件 →
   看指令池/注入效果；改文件即热重载，无需重启。
5. **分发**：server `exportPlugin` 导出插件目录打包给他人，
   对方经 `POST /hooks/plugins` 安装（或直接放入扫描位置）即用。

**回归基准**：仓库内 `packages/weave-server/src/hooks/__tests__/fixtures/changelog-reminder/`
即「AI 按本文档生成」的验收样本（规则 + `@file:` 模板 + 事件订阅组合），
其验收测试固定在 `plugin-loader.test.ts` 的「AI 生成验收」describe 中——
改规范必须同步该样本与测试。
