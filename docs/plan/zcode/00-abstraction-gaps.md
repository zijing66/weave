# R 批次：抽象适配层缺口

> 先修这里，再接 ZCode。四批互不依赖、都能独立开工 + 独立提交 + 独立验收。
> 每一批的理由都相同：**再挂一个 harness 时会撞到的写死点**，且存量也有小毛病。

## 判定口径

抽象层的正确形状在本仓已定过：能力槽声明能力，调用方按表/按面取值，
**server/cli/web 不写 harness 名字**（`driver.ts` 的十条槽 + `core/harness.ts` 的
四张表）。R 批次只是把**已经声明过能力、但消费侧仍在写名字**的地方并回去。

三处已声明能力、写侧却仍是二分（本轮要修的）：

| 能力 | 读侧（已能力化） | 写侧（写死） |
|---|---|---|
| MCP 配置 | `AssetSurface.mcpScopes` / `mcpDest` | server 8 处 `body.agent === 'codex'` 分支 |
| 交互式开终端 | `ResumeCommandSpec.openArgs` | web 一行 `s.harness === 'claude'` |
| inject 注入面 | `INJECTABLE_EVENTS[harness]` | 镜像文档 `hookSourceHarness(...) !== 'claude'` |

第四批（R4）不在上表：它是 toolkit 里**根本没声明能力**就写的 claude 字面量。

---

## R1 会话行「在终端打开」能力化（0.5 天）

### 现状与证据

- 行渲染门控写死 claude：`packages/weave-server/web/src/components/tasks/SessionList.tsx:466`
  ```tsx
  {s.harness === 'claude' && (
    <button type="button"
      disabled={noTranscript || !!s.pidAlive || openTermState === 'loading'} … />
  ```
- 服务端**已经**是能力驱动的：`packages/weave-server/src/daemon/hooks-routes.ts:570-600`
  取 `deps.harnesses?.get(src)?.resume`，`!spec?.supported || !spec.openArgs` → 501。
  同一路由还按 `transcriptState(transcriptPresent, hasRun)` 拒一次「转录不在」。
- 行字段在 `hooks-routes.ts:449-500` 组装；web 类型在
  `web/src/lib/api.ts:335-366`（`SessionRow`）。

⇒ web 那一行是**唯一**写死点：它镜像了一个服务端已算得出的判断。

### 目标

`/sessions` 每行带一个服务端派生的布尔，web 只渲染它：

- `hooks-routes.ts` 行组装处新增
  ```ts
  const resume = deps.harnesses?.get(s.harness)?.resume;
  // …
  canOpenTerminal: !!(resume?.supported && resume.openArgs),
  ```
  （`harness` 取自会话行已有的 `src`；`deps.harnesses` 是可注入的
  `HarnessRegistry`，测试用同一入口。）
- `api.ts` 的 `SessionRow` 加 `canOpenTerminal: boolean`。
- `SessionList.tsx:466` 改成 `{s.canOpenTerminal && (`，其余三态
  （`noTranscript` / `pidAlive` / `loading`）一律不动。

### 为什么用行字段而不是 web 静态表

`HARNESS_UI`（`web/src/lib/harness-meta.ts`）装的是**身份**（label / badge / 图标 /
dotDir），不是能力。能力判断的真源在 harness 注册表，web 拿到的是派生结果——
与 `/projects` 行上已有的 `canStartSession` 同口径（那条同样是服务端算好、web 只渲染）。

### 验收

- 现有 claude 行为零变化（claude 注册了 `openArgs` → 字段恒 true）。
- 单测：伪造一个注册了 `resume.openArgs` 的驱动 → 行字段 true；注册了 `supported`
  但无 `openArgs` → false。
- `weave-server` 与 `web` 两个 tsc 都绿（`web` 的 tsc 须单独跑，见 memory
  `weave-web-feedback-conventions`）。

### 风险 / 回滚

无。纯加法字段。回滚 = 删字段 + 还原一行门控。

---

## R2 inject 镜像文档按 harness 分条（0.5 天）

### 现状与证据

- 镜像文档生成：`packages/weave-server/src/hooks/mirror.ts:67-91`，过滤器第一句
  ```ts
  if (hookSourceHarness(rule.source) !== 'claude') return false;
  ```
- 文档形状：`MirrorRule { id, name, events, tools, globs, template }`
  ——**没有 harness 字段**。
- 落到 `<dataDir>/hooks/mirror/<shard>.json`，`shard = sha256(project token)`；
  一个项目**一份**文档，与 harness 无关。
- 消费侧是生成的采集脚本 `packages/weave-harness/src/claude/capture.ts:24`，脚本
  自己按 `shard` 算路径读这份文档（跨端契约，注释已写明与 server 侧对齐）。

### 为什么必须改

ZCode 的 hook 事件名是 claude 的子集（见 [`01-p0-capture.md`](./01-p0-capture.md)），
且 `additionalContext` 支持面与 claude 不同。一个项目同时装了 claude 与 zcode 的
hooks 时：一份文档、两个脚本读——zcode 脚本会看见 claude 的 inject 规则（反之亦然），
规则里的 `events` 名字相同更让错配无声发生。

### 目标（向后兼容的加法，**不升 `MIRROR_VERSION`**）

1. `MirrorRule` 加 `harness: Harness | 'any'`（`hookSourceHarness` 的返回类型就带
   `'any'`；`validateHandler` 只在**建规则**那侧拒 `'any'` 挂 inject，读侧不校验，
   投影函数不能假设盘上的行一定过过那道闸）。
2. `buildMirrorDoc` 去掉 claude 过滤，改为**逐条盖章**：
   ```ts
   .filter((rule) => {
     if (rule.source.kind !== 'hook-event') return false;   // 同时兜掉 webhook / legacy
     …
   })
   .map((rule) => ({ …, harness: hookSourceHarness(rule.source) ?? 'claude' }))
   ```
   一份文档装全项目所有 harness 的规则。
3. `generateHookHandler(version, harness = 'claude')` 增参：脚本里
   ```js
   const OWN_HARNESS = ${JSON.stringify(harness)};
   // 老文档没有 harness 字段（存量都是 claude 规则）→ 缺省 claude；'any' 通吃
   var owner = rule.harness || 'claude';
   if (owner !== 'any' && owner !== OWN_HARNESS) continue;
   ```
   与脚本里已有的 `INJECTABLE_EVENTS` / `TITLE_EVENTS` 同一种「镜像 server 表」写法。
4. 顺带（同一处必需）：脚本里 inbox 行的 `source` 由字面量 `'claude'` 改取
   `OWN_HARNESS`——否则新 harness 的事件会被记到 claude 名下。`INJECTABLE_EVENTS`
   / `TITLE_EVENTS` 两个字面量仍留 P0（那时才有第二个 harness 的表可抄）。

**不升版本的理由**：字段是增量、老脚本忽略它照旧工作（存量规则全是 claude），
新脚本对缺字段按 claude 兜底。升版本会让**存量项目的静态注入在下一次
`weave init` 之前全部失效**，代价大于收益。

### 验收

- 单测（`hooks/__tests__/`）：同一项目里一条 claude inject 规则 + 一条 zcode inject
  规则 → 文档两条都在、`harness` 各自正确。
- 单测：`generateHookHandler('0.0.0','zcode')` 产物含 `OWN_HARNESS = "zcode"`，
  且 claude 产物含 `"claude"`。
- 手验（不改真库）：`weave doctor` 的采集脚本一节仍报「weave 生成」。
- 老项目不重跑 init 时，注入行为不变（缺字段兜底 claude）。

### 风险 / 回滚

低。回滚 = 还原过滤器与 `generateHookHandler` 签名；文档字段留着无害。

---

## R3 MCP 读写能力化（1.5~2 天，P2 的前置）

### 现状与证据

**读侧已能力化**：`AssetSurface.mcpScopes()` / `mcpDest()`（`driver.ts:133-144`），
`install/mcp-rows.ts` 用它算 `installScopes`。

**写侧 8 处写死 codex**（`grep -rn "agent === 'codex'" packages/weave-server/src`）：

| 位置 | 现在做的 |
|---|---|
| `daemon/server.ts:895` | `if (body.agent === 'codex')` → 拒 project scope + 存在性检查 + `writeCodexMcpServer` |
| `daemon/server.ts:914` | 回的 scope：`body.agent === 'codex' ? 'user' : (body.scope ?? 'project')` |
| `daemon/server.ts:1007` | 卸载分支同上 |
| `daemon/server.ts:1883` | `needsProjectPath`：`mcp && agent === 'codex'` → false |
| `install/apply-update.ts:89` | 更新分支：codex 走 `writeCodexMcpServer` |
| `install/mcp-rows.ts:53-55` | 三条 `push('claude','project'…)/push('claude','user'…)/push('codex','user'…)` |
| `install/installer.ts:36` | `McpServerConfig` 定义在 server（**类型位置错**，见下） |
| `web/src/components/McpGrid.tsx:109` | `s.harness === 'codex' \|\| s.scope === 'user'` |

**表示法三种**（这是 harness 知识，必须住在 harness 里）：

- claude project → 项目 `.mcp.json` 的 `mcpServers[name]`（`install/installer.ts:161-177`）
- claude user → `~/.claude.json`（`install/global-config.ts:176-182`）
- codex user → `~/.codex/config.toml` 的 `[mcp_servers.<name>]`（`install/codex-toml.ts`）

`install/codex-toml.ts:29` 自己留了话：「MCP 表示法的下沉留后续批次（其类型
`McpServerConfig` 仍住 server）」——**R3 就是那一批**。

### 类型位置：`McpServerConfig` 该住哪

它现在住 `install/installer.ts:36`，web 另有一份镜像（`web/src/lib/api.ts:639`）。
`@weavecode/harness → @weavecode/core` 是唯一外向依赖，**harness 不能 import server**。

裁定：**移到 `weave-harness/src/driver.ts`**（它被 `AssetSurface` 的方法签名引用，
定义与引用同处最自然），`install/installer.ts` 原位置 `export type { McpServerConfig }`
re-export，存量 import 零改动。不动 core（core 只放纯类型与**表**，这条不是表）。

### 目标签名

```ts
// weave-harness/src/driver.ts
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AssetSurface {
  // …既有…

  /** 读该 scope 的 MCP 服务器映射（无该 scope → 空对象，不抛）。 */
  mcpRead(scope: 'project' | 'user', projectPath: string, homedir: string):
    Promise<Record<string, McpServerConfig>>;

  /** 写/覆盖一条（表示法归本 harness；scope 必须在 mcpScopes() 内，否则抛）。 */
  mcpWrite(scope: 'project' | 'user', projectPath: string, homedir: string,
           name: string, cfg: McpServerConfig): Promise<void>;

  /** 删一条；返回是否真删掉了（→ 404 语义）。 */
  mcpRemove(scope: 'project' | 'user', projectPath: string, homedir: string,
            name: string): Promise<boolean>;
}
```

`homedir` 显式传参（不读 `os.homedir()`）——测试与 `userConfigFile(home)` 同口径。

### 落地顺序

1. **类型下沉**（半小时）：`McpServerConfig` 定义进 `driver.ts`，server re-export。
   此刻两边零行为变化，可单独提交。
2. **claude 实现**：把 `installer.ts` 的 `readMcpServers` / `installMcp` /
   `uninstallMcp` 与 `global-config.ts` 的 `readGlobalMcpServers` /
   `writeGlobalMcpServer` / `removeGlobalMcpServer` 的**文件表示法部分**搬进
   `weave-harness/src/claude/assets.ts`（已有这个文件，加方法而非新目录）。
   **`recordInstalled` 那一步留在 server**：install ledger 是 server 的 DB 事，
   不是 harness 表示法——`mcpWrite` 只写文件，server 在调用成功后再记账。
3. **codex 实现**：`readCodexMcpFromText` / `upsertCodexMcpInText` /
   `removeCodexMcpFromText` + fs 包装搬进 `weave-harness/src/codex/mcp.ts`
   （行级 TOML 原语已在 `codex/toml.ts`）。`codex-toml.ts` 改为 re-export。
   harness 包需加运行时依赖 `smol-toml`（现在只有 `@weavecode/core`）。
   `mcpScopes()` 只有 `['user']` → 传 `'project'` 一律抛错，这就是原来那个 400。
4. **server 并回表**：
   - `mcp-rows.ts` 的三条 `push` → `for (const s of assetSurfaces()) for (const scope of s.mcpScopes()) push(s.harness, scope, await s.mcpRead(...))`。
     `enable`（启停覆写）仍只对 claude project 档有值——那是
     `settings-mcp` 的既有事实，保留条件 `harness === 'claude' && scope === 'project'`，
     但它已是**唯一**剩下的 claude 判断，且理由是「覆写住 `.claude/settings.json`」
     （表示法事实）。若能顺手并进 `AssetSurface` 更好，否则留注释。
   - `server.ts:895-920` 三段分支 → 取 `assetSurfaceFor(agent)`，校验 scope ∈
     `mcpScopes()`（否则 400），`mcpWrite`；返回的 scope 用**校验后的**那个。
   - `server.ts:1007-1016` → `mcpRemove`，false → 404。
   - `server.ts:1883` → `!(category === 'mcp' && agent 的 surface 不含 'project')`。
   - `apply-update.ts:89` → `surface.mcpWrite(scope, …)`。
5. **web**：`McpGrid.tsx:109` 的 `s.harness === 'codex' || s.scope === 'user'` →
   按行的 `installScopes` 判定（`!installScopes.includes('project')`）。
   `CategoryDetail.tsx` 那几处 `runtimeTab === 'codex'` 是**页签渲染**、不是能力判断，
   本轮不动（见 P2 的页签一节）。

### 落地偏差（实施时定）

- 验收里的「注册进 registry 的第三个 surface」做不到：`Harness` 是 core 的封闭
  联合，测试里造不出新 harness。改为**把 codex 面当场改造成第三种形状**（多给一个
  它本来没有的 project 档 + 内存实现）再打三条路由——见
  `__tests__/mcp-surface.test.ts`，效果等价且能证明 server 无分支。
- codex 的 fs 包装下沉后 `file` 变成必填（harness 不认识路径），server 保留
  `codexConfigFile()` 与四个带默认值的薄包装；`setCodexConfigFileOverride` 这个
  测试 seam 随之删除（路由已不经 server 解析路径），测试改用 `HOME`/`USERPROFILE`
  隔离（与 `global-config.test.ts` 同口径）。
- 两处**有意的语义统一**（原来同一件事在两个档上不一致）：装已存在的 server 一律
  409（原来 claude user 档静默覆盖）、卸不存在的 server 一律 404（原来 claude user
  档 200）。未注册的 `agent` 由「静默落到 claude」改成 400。

### 验收

- 存量 claude project / claude user / codex user 三条装卸路径**行为逐字不变**：
  现有 `install/__tests__` 与 `mcp-rows` 测试全绿即证。
- 新增单测：伪造第三个 surface（`mcpScopes() = ['project','user']`，内存实现）
  注册进 registry → `/assets` 行、装卸、更新三条路径都通，server 侧零分支。
- `grep -rn "agent === 'codex'" packages/weave-server/src` 除测试外应**归零**
  （`installer.ts:87/105` 那两处是错误文案里的 `' (Codex)'` 后缀，属表示法，
  可改为取 surface 的展示名或留着——它们不是分支，允许保留）。
- 两个 tsc 绿。

### 风险 / 回滚

中。风险点集中第 2 步（搬 claude 的文件表示法）——`installer.ts` 同时被
toolkit / 全局装卸 / apply-update 多处消费，**搬 = 只移动实现、re-export 保住
所有既有 import 路径**，不要顺手改签名。回滚按步回滚（每步独立提交）。

---

## R4 toolkit 的两处 claude 字面量（0.5 天）

### 现状与证据

`packages/weave-server/src/hooks/toolkit.ts`：

- `:216-226` 裸表面包的单文件资产落盘
  ```ts
  // 裸表面包的单文件资产（claude-only：codex 无对应项目表面）
  if (claude && !isCcPluginPack(pack)) {
    … fileAssetTargetDir(category, 'claude', 'project', projectPath, homedir()) …
  ```
  `installPack`（`:199-215`）的 skills 循环**已经**按 `pack.targets` 走了 surface；
  只有这一块是 claude 独占，注释给了理由（codex 无项目级 commands/agents 面）。
- `:656` 及周边 `pluginKey` 拼装、`:444/:456/:535/:544/:551/:629/:693` 的
  `isCcPluginPack(pack) && targets.includes('claude')` —— 这些是**CC 插件机制**
  的判断（宿主插件安装/uninstall/注册键），zcode 有 Claude 兼容插件市场，
  形态待 P2/🔬 再定，**本轮不动**。

### 目标

只改第一处：把 `claude` 换成按 `pack.targets` 遍历，`fileAssetTargetDir` 的
harness 参数取自循环变量：

```ts
if (!isCcPluginPack(pack)) {
  for (const harness of pack.targets) {
    const surface = assetSurfaceFor(harness);
    for (const category of FILE_ASSET_CATEGORIES_OF_PACK) {
      … fileAssetTargetDir(category, harness, 'project', projectPath, homedir()) …
```

判断「该 harness 有没有这个表面」用 surface 自己的口径（`surface.targetDir()` 抛错
即无该面 → 跳过），而不是在 server 里列 codex/claude。今天 codex 的
`targetDir` 对 `command/agent/workflow/rule/output-style` 会抛 → 行为不变。

### 验收

- 现有 toolkit 测试全绿（codex 目标包不会多落文件、claude 包文件数不变）。
- 新增单测：manifest `targets: ['claude','codex']` 的裸表面包 → claude 一份、
  codex 侧因 surface 抛错而跳过且不报错。

### 风险 / 回滚

低。一处循环。回滚 = 还原 if。

---

## 提交切分

| 提交 | 内容 |
|---|---|
| 1 | R1（server 一字段 + web 一行 + 类型） |
| 2 | R2（mirror 盖章 + 脚本滤条 + 单测） |
| 3 | R3-step1（`McpServerConfig` 下沉 + re-export，零行为变化） |
| 4 | R3-step2（claude 表示法搬 harness + server 并回表 + 单测） |
| 5 | R3-step3（codex 表示法搬 harness + re-export + 单测） |
| 6 | R3-step4（web `McpGrid` 按 installScopes） |
| 7 | R4（toolkit 循环化 + 单测） |

每批落库用**路径限定提交**，提交前列出暂存路径复核（与并行会话共用工作区，见
memory `weave-parallel-session-git-hazards`）。
