---
name: weave-plugin-creator
description: 开发 weave 插件——规则包（weave-plugin.json + rules.json + handler.mjs）、CC 插件、mod、skills 包的目录规范、manifest 字段、扫描位置与装载验证回路。要写、改或调试 weave 插件与 hook 规则时使用。
---

# Weave 插件开发

weave 插件 = **一个自包含目录**，放进扫描位置即被 daemon 自动识别（SPI 式，无需任何显式配置）。
信任模型 = 本地目录即信任：handler 代码放进扫描目录就等于授权运行，**不要从不可信来源安装**。

## 选型

| 需求 | 形态 | 标志 |
|---|---|---|
| 事件驱动：编辑后注入指令 / 只记账 / 出站 webhook / 自定义处理 | weave 规则包 | `weave-plugin.json` |
| 给会话加 skill / command / agent 模板 | CC 插件（skills 包） | `.claude-plugin/plugin.json` |
| 拦截/改写工具调用（deny + toast 提示） | mod | `hooks/hooks.json` + `register.tsx` |
| Claude Code 经典 hooks | classic hook 包 | `hooks/hooks.json`（hooks 对象形） |

一个目录可同时带两种 manifest（CC 插件 + weave 规则）→ 启用时双管线都走。

## 一、weave 规则包

### 目录结构

```
my-plugin/
├── weave-plugin.json     # 必需：manifest
├── rules.json            # 可选：规则数组（manifest.rules 引用）
├── prompts/              # 可选：inject/manual 指令模板（@file: 引用）
│   └── check.md
├── handler.mjs           # 可选：自定义处理器（ESM）
├── skills/my-skill/      # 可选：模板（扩展点③）
├── commands/foo.md       # 可选
├── agents/bar.md         # 可选
└── README.md             # 可选
```

目录名建议 = manifest.id。

### manifest（weave-plugin.json）

| 字段 | 必需 | 说明 |
|---|---|---|
| `manifestVersion` | ✓ | 固定 `1` |
| `id` | ✓ | `^[a-z][a-z0-9-]{0,63}$`，全局唯一；**`weave-` 前缀保留给内置**，用户插件用会被 rejected |
| `name` | ✓ | 显示名 |
| `version` | ✓ | semver（`X.Y.Z` 可带 prerelease） |
| `description` / `author` | | 展示用 |
| `rules` | | 规则文件相对路径数组，默认 `[]` |
| `handlers` | | `[{type, entry}]`，自定义处理器入口 |
| `requires.events` | | 依赖的采集事件；**未知事件名 → rejected** |
| `templates` | | `{skills: [], commands: [], agents: []}`——init 时复制进项目 |
| `mcpServers` | | MCP server 定义（预留扩展点） |
| `subscribe` | | `{events: [...], entry: 'subscriber.mjs'}`——订阅采集事件流（fire-and-forget 观察者） |
| `config` | | 默认配置，用户经 dashboard 覆写后合并进 `ctx.config` |

### rules.json

JSON 数组，每元素（`id`/`projectId` 由加载器生成）：

```jsonc
{
  "name": "文档更新检查",                        // 必需
  "enabled": false,                             // 可选，默认 true；用户在 dashboard 的开关永远被保留
  "priority": 10,                               // 可选，越大越先匹配
  "source": { "kind": "claude-event", "event": "PostToolUse" },  // 必需
  "filter": {                                   // 可选
    "toolNames": ["Edit", "Write"],             // 匹配工具名
    "pathGlobs": ["**/*.md"],                   // 匹配 file_path（glob，posix 分隔）
    "crossProjectOnly": true                    // 只在路径命中其他已注册项目时触发
  },
  "handler": { "type": "inject", "template": "@file:prompts/check.md" },
  "timeoutMs": 10000                            // 可选，默认 5000
}
```

**事件七选一**：`PreToolUse / PostToolUse / UserPromptSubmit / SessionStart / Stop / SubagentStop / Notification`。

**handler 五型**：

| 型 | 语义 |
|---|---|
| `{"type":"log"}` | 只记账 + SSE，不入池（高频事件防写放大） |
| `{"type":"webhook","url":"…","secret":"…","headers":{}}` | 出站 POST（HMAC 签名） |
| `{"type":"inject","template":"…"}` | 入池(injected) + **注入当前会话** |
| `{"type":"manual","template":"…"}` | 只入池(pending)，dashboard 拖拽执行 |
| `{"type":"plugin","handlerType":"doc-lint","config":{}}` | 自定义处理器（pluginId 省略，加载器填） |

`inject` 只能挂 `PostToolUse / UserPromptSubmit / SessionStart / Stop / SubagentStop`
（同步注入白名单），挂其他事件 → 整插件 rejected。

**模板变量**（渲染时替换）：`{event} {tool} {file} {cwd} {session} {project} {rule}`。
`template` 写 `@file:相对路径` 则加载时内联文件内容（路径不得越出插件目录）。

### handler.mjs

```js
export default {
  type: 'doc-lint',            // 必须与 manifest.handlers[].type 一致
  async execute(ctx) {
    // ctx.event   归一化事件 payload（eventType/toolName/toolInput/cwd/raw…）
    // ctx.rule    命中的完整规则
    // ctx.config  manifest.config 与用户覆写合并后
    // ctx.logger  debug/info/warn/error（自动带 [plugin:<id>] 前缀）
    return {
      prompt: '写入指令池的文案',       // 可选
      additionalContext: '注入当前会话', // 可选（事件须在 inject 白名单内，否则丢弃）
    };
  },
};
```

失败/抛异常/超时 → 静默跳过，**永不影响事件采集**。

### 校验红线（任一不过 → 整插件 rejected，不影响其他插件）

- manifest 过 schema；`requires.events` ⊆ 七事件；inject 挂白名单事件
- 规则文件存在、为数组、逐条过 schema；`@file:` 模板存在且不越界
- handler `entry` 不越界、动态 import 成功、default 导出 `type` 与 manifest 一致
- 同 id 与已加载插件重复 → 后者 rejected（先到先得）

## 二、CC 插件 / mod / skills 包

- `.claude-plugin/plugin.json`：`{name, version, description, author}`（CC 原生清单）
- `weave.json`：`{targets: ["claude"], kind}`——kind 取 `skill | hook | mod | rule | surface`，缺省按内容推导
- skills 包：`skills/<name>/SKILL.md`（agent skills 标准：frontmatter `name` + `description`）；commands/agents 为单文件 `*.md`
- mod：`hooks/hooks.json` = `{"modules":["./register.tsx"]}`，`register.tsx` 用 Claude Code 的
  `Register` API（`on('tool.call', {tool:'Edit'}, ($, e, next) => …)`，返回 `{deny}` 即拦截）；
  **宿主 Claude Code ≥ 2.1.287**，enable 时有版本闸
- classic hooks：`hooks/hooks.json` 的 `hooks` 对象形 + `.cjs` 脚本

CC 插件形态的包（有 `.claude-plugin`）启用时走「Claude 全局安装 + 项目开关」；
不带 CC 清单的裸表面包（仅 `weave.json` + `skills/`）启用时解包进项目 `.claude/skills/`
（`.weave/toolkit/` 记 checksum 账本：用户改过的文件禁用时保留）。

## 三、放哪里、怎么装

| 位置 | 作用域 | 备注 |
|---|---|---|
| `<数据目录>/plugins/<id>/` | 全局 | Windows 即 `%APPDATA%\weave\plugins\`；dashboard 插件区「安装」支持本地目录 / git URL，落在这里 |
| `<project>/.weave/plugins/<id>/` | 单项目 | 随 git 分发，规则只对该项目生效 |
| 内置 / 市场包 | — | 无需手放：daemon 启动时把内置仓落到 `<数据目录>/market/weave/`，市场导入的包落 `<数据目录>/market/<市场id>/` |

CC 包注册键形 `<name>@<市场>`；内置市场身份 = `weave`（如 `code-review@weave`）。

## 四、验证回路

1. **落盘 → 热重载**：改文件 ~1s 内生效，无需重启 daemon。
2. **看状态**：dashboard 插件面——`active` 即通过 smoke；`rejected` 的 error 字段给出具体失败项。
3. **启用**：直接放扫描位置的包默认生效；**工具包（市场/内置仓形态）的 weave 规则成分首见默认停用**，需在市场里按项目启用，再到 Hooks 规则面开具体规则。
4. **联调**：触发对应事件（如编辑 `.md` 文件）→ 看指令池 / 注入效果。
5. **分发**：dashboard 插件区「导出」产可分发目录（自动剔除 node_modules/.git），对方安装或直接放扫描位置即用。

## 五、超时与防递归（无豁免）

- handler 超时 = `timeoutMs`（默认 5s）竞速强杀；规则预算要明显小于宿主 hook 窗口
- 入池/注入指令自动追加隐藏防递归标记 + 同 规则×会话 60s 去重——插件与内置规则走同一条防线

## 权威规范

完整规范见 weave 仓库 `docs/PLUGIN-SPEC.md`；仓库内验收样本
`packages/weave-server/src/hooks/__tests__/fixtures/changelog-reminder/`
（其行为由 `plugin-loader.test.ts` 的「AI 生成验收」固定）。
