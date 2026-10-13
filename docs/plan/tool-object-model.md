# 工具对象统一模型（Tool Object Model）——安装/启用状态抽象

> 状态：**已拍板，待排期开发**（2026-10-13 落档，同日经项目所有者逐项确认，见 §7）。
> 方向由项目所有者提出：所有 harness 的工具功能统一为抽象 tool 对象——可安装范围、
> 每范围安装状态、每范围启用与继承链；前端对抽象统一实现开关/安装/展示，
> 不管理具体 harness 的表示法。
> 上游：`harness-pluginization-audit.md`（P0–P5 已收口，其延后项由本模型收编，见 §4）；
> 相邻：`cc-plugin-verification.md`（CC 插件键形与启用语义调研）。

## 1. 动机

P0–P5 之后「新增 harness」已零 shared 改动，但 web 侧仍有一批延后分叉（MCP 呈现、
toolkit、effectiveScope…）。共性根因不在 harness 插件化，而在**每类工具各自发明了
范围/状态形状**：

- CC 插件启用：`PluginStateSurface` 只有 user/project 两档读写（`weave-harness/src/driver.ts:202`），
  而 claude 实际合并语义是 **local > project > user**（`claude/plugins.ts:23`，H3）——
  链存在但未建模，local 档无读写面。
- MCP 启用：claude 项目级三态 `'enabled' | 'disabled' | 'default'`
  （`weave-server/src/install/settings-mcp.ts:44`）——「显式覆写 vs 继承」的正确形状，
  但只此一处、claude-only、未推广。
- weave 自有 SPI 插件：`plugin_states` 表平铺（`repositories/plugin-states.ts`），
  无范围维度（builtin/global/project 三根已是范围雏形）。
- **user 档安装管理面前后端缺失（功能缺失，非仅形状问题）**：插件路由只有
  `/projects/:id/plugins/uninstall` 与 enabled get/put，全挂项目上下文；
  `PluginSurface.globalInstall`（两步 CLI 链、幂等）仅被 toolkit 管线内部调用
  （`hooks/toolkit.ts:440`）——「装到 user 档」无独立路由，web 亦无入口/视图。
- 前端拿到 `PluginEnabledMap = Record<Harness, Record<string, boolean>>`（`web/api.ts:538`）
  ——范围维度被压掉，App/CategoryDetail 只能按 harness 分叉补知识。

## 2. 模型

一句话：**工具（tool）是抽象对象，携带「可安装范围 + 每范围安装状态 + 每范围启用覆写与
继承链」；具体 harness×工具以数据行定义自己的范围表，表示法留在 harness 实现内；
前端只对抽象状态做通用开关、安装控制与展示。**

### 2.1 抽象协议（core 放纯类型，server 产出实例、按项目视图请求）

```ts
type ToolScope = 'user' | 'project' | 'local';            // 词表已定（§7-1）：global 一次性改名 user
type InstallState = 'absent' | 'installed' | 'updateAvailable';
type EnableOverride = 'on' | 'off' | 'inherit';

interface ToolState {
  key: string;                                 // 既有键形纪律：name@market（pluginKey）
  category: ToolCategory;                      // 与 installCapabilities 的 category 集对齐
  harness: Harness;
  installScopes: readonly ToolScope[];         // 该 harness 下可装的范围（§2.2 数据行）
  installs: Partial<Record<ToolScope, InstallState>>;    // 每范围独立，跨范围不冲突
  enables: Partial<Record<ToolScope, EnableOverride>>;   // 未列 = inherit
  effective: { enabled: boolean; source: ToolScope | null };  // server 解析好下发
}
```

### 2.2 具体定义（harness 包内数据行，`satisfies` 催补，加 harness = 补行）

```
claude: { plugin: ['user','project','local'], mcp: ['project','user'], skill: ['project','user'], … }
codex:  { plugin: ['user'],                  mcp: ['user'],          skill: ['project','user'], … }
```

每范围的落点与读写（settings 文件、config 键形、CLI 子命令）留在各 surface 实现内。

### 2.3 状态语义

- **安装状态**：每范围独立求值（user 已装、project 未装 ≠ 冲突）；`updateAvailable`
  由市场源版本比对派生（市场副本层产物，见 §2.5）。
- **启用链**：`local > project > user`（claude；其他 harness 的链序由其数据行给出）。
  未覆写 = `inherit` → 沿链取最近显式值；全链无覆写 → 缺省「已装即启用」。
- **生效态由 server 唯一解析**，随对象下发（`effective` 含决定来源，UI 可示「继承自 user」）；
  前端不重复实现链解析。

### 2.4 边界（不收编什么）

- **能力 ≠ 工具**：会话「打开终端」门控、statusline 支持是 harness **能力**
  （capabilities/detect 槽），不是可安装物——不进本模型，仍走能力面。
- **表示法永不进抽象**：文件格式、config 键形、路径——抽象只管状态与控制
  （HARNESS_EVENTS 的教训：并集会造出非法规则；本模型只并「控制语义」，
  这在各类工具间是真正同构的）。

### 2.5 与三层资源模型的关系

①市场副本层不变；②安装/③启用两层的状态即本模型——模型不新增层，只把
②③两层的散落状态收拢为一个对象协议。

### 2.6 基石条款

weave hooks 采集集成（事件入口，整个 dashboard 的地基）本身按工具对象建模，
**硬性要求 user 档安装/启用面**——跨项目采集，不依赖逐项目 init。现状仅项目档：
weave init 落项目 `.claude/settings.json` 的 hooks，cli/harness 内无 user 档采集
安装路径（无 userHooks/globalHooks 机制）。user 档采集面为新增（§6 第 2 步）。

## 3. 现状 germ → 缺口

| 现有 | 位置 | 模型槽 | 缺口 |
|---|---|---|---|
| installCapabilities scopes 矩阵 | `server/src/install/capabilities.ts` | installScopes | P5 已改派生；仅 project/global 两值 |
| PluginStateSurface user/project 读写 | `harness/src/driver.ts:202` | enables 写入面 | 缺 local；无整对象读 |
| local>project>user 合并语义 | `harness/src/claude/plugins.ts:23`（H3） | 启用链 | 隐式注释，未建模 |
| MCP 三态覆写 | `server/src/install/settings-mcp.ts:44` | EnableOverride | 单处实现，未推广 |
| plugin_states 表 | `server/src/repositories/plugin-states.ts` | 自有插件状态 | 无范围维度 |
| globalInstall（两步 CLI 链） | `harness/src/driver.ts:188`、`server/src/hooks/toolkit.ts:440` | user 档安装 | 仅 toolkit 管线内部调用；无管理路由与 web 入口 |
| builtin/global/project 三根 | `server/src/hooks/plugin-loader.ts` | installScopes 雏形 | 未统一命名 |

## 4. 前端通用化（延后项收编表）

| 延后项（audit 延后表 web 行） | 收编为 |
|---|---|
| ~~CategoryDetail rowsFor MCP 分叉（claude 双 scope / 其余用户级）~~ | ✅ installScopes 数据行驱动卡面（§6-1 `ea96180`；通用安装菜单归后续） |
| ~~App machineMcp 计数与 effectiveScope~~ | ✅ `effective` 随行下发（§6-1）+ 计数/档位回落改行 installScopes 与能力矩阵判据（`29efca4`） |
| ~~LibraryPanel codexMcpPathHint~~ | ✅ 范围落点提示按矩阵 dest 行渲染（§6-4 `62bcf04`：mcpDest + `~` 缩写显示形） |
| ~~ToolkitSection isCcPack / SkillGrid 插件卸载 claude 门控~~ | ✅ manifest targets 过滤/徽标并集 + installScopes 门控（§6-4 `62bcf04`） |
| ~~FileAssetTree 全局卸载门控~~ | ✅ 卸载面按 installScopes 行驱动（§6-4 `62bcf04`：canUninstall 共用安装矩阵） |

通用控件三件：①按 installScopes 渲染的安装菜单（claude plugin 三项、codex 一项，
同一控件）——**拍板 6 缓**（「装到 project/local 档」动作待可逆实验后开；ToolkitSection
项目 Switch 是「安装+清扫+项目启用」复合管线，归本件不动）；②三态开关
on/off/inherit + 解析结果显示——**已推广**（MCP `ea96180`；插件组 SkillGrid PackBlock
逐档循环钮 `abf50fa`：全局 user / 项目 project+local，循环序按行判据——有安装面
harness 三态、仅启用面 on/off 布尔，与 server PUT 同分支）；③per-scope 状态徽章——
随 ② 落地（循环钮即「档位·状态」徽章）。hooks 事件矩阵、会话终端门控、statusline
属能力/规则域，不在此表（§2.4）。

摆放（§7-5/7-7 已定，**已落地**）：user 档入当前全局配置区，project/local 档入
项目下方；scope→视图区域的映射由摆放元数据 `GROUP_VIEW_SCOPES`（CategoryDetail）
驱动——新档位 = 加一行，视图与控件不写死 per-scope 分支。

## 5. 落点与依赖方向

- **core**：纯类型 + 范围表常量（延续「core 只放纯类型与表」）。
- **harness**：`TOOL_SCOPES satisfies Record<Harness, Record<ToolCategory, readonly ToolScope[]>>`
  + 各 surface 补 local 档读写（claude = `.claude/settings.local.json`）。
- **server**：ToolState 组装与生效态解析唯一处；HTTP 面按对象收发；SSE push 新增键（DataKey）。
- **web**：通用控件，删除 §4 分叉；不 import core 值（镜像纪律不变）。

## 6. 迁移路径（建议，每步独立可交付）

1. **MCP 先行**（已收 `ea96180`）：范围表 + ToolState 协议 + web MCP 三处收编
   （分叉最大、延后项最集中）。
2. **CC 插件**（已收 `7ce4865` + `f12a444`→`dcf619e` 采集四部曲）：PluginStateSurface
   补 local；PluginEnabledMap → ToolState；user 档安装管理面（server 路由 + web
   入口）；hooks 基石 user 档采集面（§2.6）。
3. **toolkit / 自有 SPI 插件**：~~plugin_states 加范围维度（schema 迁移）~~
   实施时拍板不加（见 §7-3）：D3 已用 `plugin_states`（user 档默认）+
   `projects.meta.plugins`（project 档覆写）+ `effective()`（生效链解析）
   实现两档链语义，SPI 插件单根安装无 local 档；改为三根词表对齐
   （loader scope `global` → `user`，对齐 ToolScope）。
4. ~~收尾：SkillGrid 卸载门控、LibraryPanel 提示、FileAssetTree 门控。~~
   已收（`62bcf04`）：`AssetSurface.mcpDest` 落点随安装属性矩阵行下发，三处
   门控/提示全量数据行驱动（FileAssetTree 删两套写死清单改 `canUninstall`、
   SkillGrid 改 installScopes 门控、LibraryPanel 删 codexMcpPathHint 自拼路径），
   §4 收编表对应行全数落地。

测试闭式镜像同步派生（P5 教训：不留写死两 harness 的计数断言）。

## 7. 拍板记录（2026-10-13）与待定项

**已定：**

1. **词表**：按建议统一 `user|project|local`——现有 AssetScope/InstallScope 的 `global`
   一次性改名 `user`。
2. （原问题 2 转待定 1——先重述后定，见 §8。）
3. **自有 SPI 插件**（第 3 步实施时已定）：**不加** plugin_states 范围维度——D3 的
   `plugin_states`（user 档默认）+ `projects.meta.plugins`（project 档覆写）+ `effective()`
   已是 ToolScope 两档链的完整实现，SPI 插件单根安装（一个 id 只落一个根，
   安装态由 loader 扫描即事实、无需持久化）、无 local 档根；加 scope 列要么与
   meta.plugins 重复、要么把 toolkit weave 成分曾有的「flip 全局串项目」问题请回来。
   收编改为词表对齐：三根 `builtin|global|project` 的 `global` 改名 `user`
   （LoadedPluginInfo.scope + web 镜像 + 徽标 + 测试），对齐 §7-1 词表。
4. **hooks**：事件矩阵不进模型（规则域，audit 延后表该行改标「能力面/规则域，非工具域」）。
   但 **weave hooks 采集集成本身是基石**，按工具对象建模，**硬性要求 user 档安装/启用面**
   （跨项目采集，§2.6）。
5. **视图摆放**：user 档放当前全局配置区；project 档（及「会话级别」，含义见待定 2）
   放项目下方；**摆放本身抽象实现**——scope→视图区域的映射由元数据驱动，不写死。

6. **local 档 = 方案 A**：三档全进 installScopes 数据行；管理动作分期——先 user 档安装
   （globalInstall 已有）+ 三档启用覆写读写（setProjectEnabled 补 local 变体），
   「装到 project/local 档」动作待可逆实验（同 cc-plugin-verification.md 规格）后开。
7. **「会话级别」= CC local 档**（本仓仅本人）：项目下方放 project + local 两档控制。

（原待定项已全部拍板，无遗留。）

## 8. local 档语义重述（供拍板；事实来源 `cc-plugin-verification.md` 实机验证）

CC 三档安装的实测与文档事实：

1. **物理包一份**：`~/.claude/plugins/cache/<mkt>/<plugin>/<version>/`——user 级，
   三档共用（local 档不另存包）。
2. **安装记录按档分立**：`~/.claude/plugins/installed_plugins.json` 每键是**数组**，
   同一插件可在多个 scope 各一条记录（`[{scope:"user"},{scope:"local"}]`，
   weave 的卸载已逐 scope 删）。
3. **启用的档位 = enabledPlugins 写进哪个 settings 文件**：`~/.claude/settings.json`（user）/
   `.claude/settings.json`（project，随 git 共享）/ `.claude/settings.local.json`
   （local，gitignored、本仓仅本人）。
4. **解析链**：六源 key-by-key merge，`--add-dir` < user < project < local < `--settings` < managed。
5. **project 档 ≠ 协作者自动获得**：project 声明不触发下载，协作者各自仍需 install
   （相对路径源除外）。
6. **未实测**：`--scope local` 安装的确切写盘行为（enabledPlugins 是否落
   settings.local.json、installPath 形态）——既有验证只跑了 user 档全链路。

读侧无分歧：installs 读 installed_plugins.json 数组按 scope 分桶，enables 读三个
settings 文件按档分桶。分歧在**管理动作开多宽**：

- **方案 A（建议）**：三档全进 installScopes 数据行；管理动作分期——先 user 档安装
  （globalInstall 已有）+ 三档启用覆写读写（setProjectEnabled 补 local 变体），
  「装到 project/local 档」动作待补一次可逆实验（同 cc-plugin-verification.md 规格）后开。
- **方案 B**：local 仅作启用覆写档——installScopes 只 `['user','project']`，enables 三档，
  不提供装到 local 的动作。

**已定：方案 A（§7-6）。**
