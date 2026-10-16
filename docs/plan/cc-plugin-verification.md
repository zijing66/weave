# CC 原生插件机制 H1-H5 验证结论（批 3 前置）

> 调研日期：2026-10-04 ｜ 环境：Windows 11，Claude Code `2.1.288`
> 方法：只读观察 + 一次完全可逆的临时插件安装实验（实验后三份状态文件 sha256 与实验前逐一比对**完全一致**，临时 marketplace/cache 已删净）。
> 本文档为批 3「CC 原生包全局安装纠正」（docs/plan/ui-redesign.md R4）的前置验证记录。

## 官方文档（均于 2026-10-04 抓取）

- 安装与 scope：https://code.claude.com/docs/en/plugins/install
- 加载与注册源：https://code.claude.com/docs/en/plugins/loading
- CLI 参考：https://code.claude.com/docs/en/plugins/cli-reference
- settings 键（enabledPlugins / extraKnownMarketplaces）：https://code.claude.com/docs/en/settings-reference
- mods 总览：https://code.claude.com/docs/en/plugins/mods/overview
- 创建插件（无 marketplace 开发）：https://code.claude.com/docs/en/plugins/create
- 发布/无 marketplace 分发：https://code.claude.com/docs/en/plugins/publish
- marketplace 创建：https://code.claude.com/docs/en/plugins/create-marketplace

---

## H1：installed_plugins.json 是注册源，installPath 指向 cache

**结论：证实（且与文档三阶段模型完全吻合）。**

### 证据

本机 `~/.claude/plugins/installed_plugins.json` schema（version 2）：

```json
{
  "version": 2,
  "plugins": {
    "<name>@<marketplace>": [
      {
        "scope": "user",
        "installPath": "C:\\Users\\<user>\\.claude\\plugins\\cache\\<marketplace>\\<plugin>\\<version>",
        "version": "1.0.0",
        "installedAt": "…Z",
        "lastUpdated": "…Z",
        "gitCommitSha": "…"        // git/github 源才有；本地 directory 源无此字段（实测）
      }
    ]
  }
}
```

- 值是**数组**（当前每键单元素，scope 为安装时的 scope）。
- 6 个既有条目的 `installPath` 全部指向 `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`。
- 文档（plugins/loading）：三阶段 = settings 声明 `enabledPlugins` → 磁盘 `installed_plugins.json` + `cache/` → 会话加载；「installed_plugins.json records each install with its `scope`, `installPath`, and `version`」「`cache/` holds the plugin files」。

**如何把一个本地插件包目录全局安装（实测全链路）**：

1. 包目录旁放 `.claude-plugin/marketplace.json`（`name` + `owner` + `plugins:[{name, source:"./相对路径"}]`）；
2. `claude plugin marketplace add <该目录>` —— 输出 `Successfully added marketplace: <mkt> (declared in user settings)`，写入：
   - `known_marketplaces.json`：`{"<mkt>": {"source": {"source":"directory","path":"…"}, "installLocation": "<同一路径>", "lastUpdated": …}}`（**本地目录源不拷进 marketplaces/**）；
   - `~/.claude/settings.json` 的 `extraKnownMarketplaces.<mkt>.source`（会**重排 settings.json 键序并补行尾换行**，语义内容不变）；
3. `claude plugin install <name>@<mkt> --scope user --json` —— 输出 `{"outcome":"ok","scope":"user",…}`，同时写：
   - `installed_plugins.json` 新条目（key = `<entry name>@<marketplace name>`，installPath → `cache\<mkt>\<plugin>\<version>\`，version 取 manifest `version`）；
   - `cache/<mkt>/<plugin>/<version>/`（实测连本地目录源也拷了一份副本）；
   - `~/.claude/settings.json` 的 `enabledPlugins["<name>@<mkt>"] = true`。

**反证（对 R4 中 H1 fallback）**：`claude plugin install <本地路径>` **不支持**——

```text
claude plugin install "D:\nonexistent\some-plugin" --json
→ {"outcome":"failed","message":"Plugin \"…\" not found in any configured marketplace.","failureCode":"directory_unavailable"}
claude plugin install "./not-a-plugin-dir"
→ 同样失败（按名字在已配置 marketplace 中查，不按路径）
```

失败路径未写入任何状态文件（diff 确认）。`claude plugin install --help` 也只说明 “Install a plugin from available marketplaces”。

### 对批 3 的建议（R4 fallback 路径选择）

- **R4 的 H1 fallback（surface 内 spawn `claude plugin install <local-path>`）不可用，应废除**。
- 主路径：`claude/plugins.ts` 的 `globalInstall(srcDir)` spawn 两步官方链：`claude plugin marketplace add <pack 源目录>` + `claude plugin install <name>@<mkt> --scope user`（幂等：重复装输出 `already installed` exit 0）。
- 备选（CLI 不可 spawn 时才用「weave 自管全局位」）：按上文实测 schema 手写 `installed_plugins.json`（注意：key 用 `name@weave`、数组条目、version=manifest version、目录名=version）+ 拷 `cache/` + 写用户 settings `enabledPlugins`；此路径要自行做 JSON 合并与并发保护。
- 注意：CLI 写 settings.json 会整体重排键序——Weave 若自己写该文件，应只改目标键、保留其余字节。

---

## H2：mods（CC ≥2.1.287）与普通 CC 包同机制

**结论：证实。**

### 证据

- 本机 `claude --version` → `2.1.288 (Claude Code)` ≥ mods 门槛 2.1.287。
- 文档（mods/overview）原句：**「A mod installs as a plugin, from a marketplace.」**，且「Install plugins covers marketplaces, scopes … all of which apply to a plugin that contains a mod without changes」；mod = 插件内 `hooks/hooks.json` + hooks 模块（`register.js/.tsx`），三件套 `plugin.json + hooks/hooks.json + register.*`。
- mod 关闭/安装与插件一致（`/plugin` Installed 页 / `claude plugin enable|disable|uninstall`），无独立注册文件。
- `~/.claude/dev-mods/<session-uuid>/`：文档（mods/create）说明这是「Claude 在会话中现场写的 mod」的存放目录（`~/.claude/dev-mods/<session-id>/<mod-name>/`），**不进 installed_plugins.json**，属临时/开发态，与安装机制无关（本机该目录当前为空壳）。
- 本机 Weave 项目 `.claude/plugins/{file-guard,mission-control}` 即标准 mod 三件套，`claude plugin validate` 均通过（file-guard: `tool.call{Edit/Write/Bash}` + `$.ui.toast`；mission-control: `session.start/prompt.submit/tool.call/ui.render` 等），但**未在 installed_plugins.json 注册**（详见 H4）。
- Weave 代码侧同一契约：`packages/weave-server/src/hooks/toolkit.ts:76` 注释「mod 类包的宿主版本下限（Claude Code ≥ 2.1.287 契约）」，`MIN_MOD_HOST_VERSION` / `evaluateModHostGate` 与本文档 H2 结论一致。
- `claude plugin test`（“Run a mod's tests”）与 `claude plugin details`（Hooks 组件清单）均把 mod 当普通插件对待。

### 对批 3 的建议

- **无需 mod 专属安装分支**：mod 走与普通包完全相同的 `globalInstall` + `setProjectEnabled`。R4 的「fallback：mod 专属分支留在 surface 内」不必启用。
- 计划中的「mod 版本闸零改」不受影响——那是版本检查，不是安装机制分叉。**行号勘误**：ui-redesign.md 批 3 硬闸写的 `toolkit-toggle :152-176` 已漂移，当前实现/测试实际在 `toolkit-toggle.test.ts:203-242`（mod 宿主版本闸 :203-223、版本闸纯函数 :225-237、detectClaudeVersion 真实 spawn :239-242），改计划时应同步更新该锚点。

---

## H3：项目 settings.json 的 enabledPlugins 覆盖全局，key = name@marketplace

**结论：证实。**

### 证据

- 本机 `~/.claude/settings.json` 实例：`"enabledPlugins": {"frontend-design@claude-plugins-official": true, "playwright@claude-plugins-official": false, …}` —— key 形如 `name@marketplace`，value 为布尔。
- 文档（settings-reference `enabledPlugins`）：Type = object mapping `plugin-name@marketplace-name` to Boolean，Scope = Any file；「**Project settings take precedence over user settings**, so setting a plugin to `false` in `~/.claude/settings.json` doesn't disable a plugin that the project's `.claude/settings.json` enables. To opt out … set it to `false` in `.claude/settings.local.json` instead.」
- 文档（plugins/loading「Find where a plugin is enabled」）给出完整六源优先级（低→高）：`--add-dir` < user < **project** < local < `--settings` flag < managed；「These sources merge key by key. For each plugin id, the value that applies is the one from the highest-precedence source that mentions the id.」——即 **value=false 在项目层同样生效，可覆盖全局 true**（反向亦然：用户 false 被项目 true 覆盖，CC 会在 `claude plugin list` 标注 “Disabled in ~/.claude/settings.json but still loads”）。
- 本机 `claude plugin list --json` 每条含 `projectEnabled` 字段（当前全 false）——可作读取项目启用态的 CLI 依据。
- **重要限制**（settings-reference / plugins/loading）：项目 `.claude/settings.json` 的 `true` **不会**给协作者下载插件——「Claude Code doesn't fetch it onto a machine where it isn't installed, unless its marketplace entry has a relative-path source…」；每个协作者仍需 `claude plugin install <name>@<mkt> --scope project` 一次（或本地路径 marketplace 的相对路径源可免安装记录）。

### 对批 3 的建议

- `setProjectEnabled` 直接读写项目 `.claude/settings.json` 的 `enabledPlugins`（key=`name@weave`，bool）即可，与计划 `claude/plugins.ts` 接口一致；**R4 的 H3 fallback（settings.local.json / CC CLI）不需要启用**，但 `computeEnabled` 判据按计划改为「全局已装 && 项目 enabledPlugins=true」正确。
- `disable` = 项目层写 `false`（或删键）而**保留全局安装**，与优先级模型自洽；若用户在自己 `settings.local.json` 写了 false，Weave 的开关读取需知晓 local 层可能覆盖（可先不处理，仅在文档/提示中说明）。
- 「enable 不等于安装」：对外部源插件，仅项目 `true` 不会自动出现在协作者机器上——Weave `enable` 应继续依赖自己的 `globalInstall` 步骤（计划已如此设计）。

---

## H4：项目 `.claude/plugins/` 目录是否会被 CC 自动加载

**结论：证伪「会加载」——CC 不会加载，可下定论。**

### 证据

- 文档（plugins/loading「Plugins shared through a repository」）原句：**「To share a plugin through a repository, list it under `enabledPlugins` in `.claude/settings.json` or place it under `.claude/skills/`. Claude Code doesn't scan a project's `.claude/plugins/` directory.」**
- 合法的项目级加载途径只有三种（同一文档「Find where a plugin came from」表）：
  1. `@<marketplace>`：settings `enabledPlugins` 声明（需已安装或相对路径源）；
  2. `@skills-dir`：把含 `.claude-plugin/plugin.json` 的目录放在**项目 `.claude/skills/`** 下（按 manifest `defaultEnabled`，受 workspace trust 门控，且只从主工作目录的 `.claude/skills/` 读取）；
  3. `@inline`：`--plugin-dir` / `--plugin-url` / `CLAUDE_CODE_PLUGIN_DIRS` 环境变量（仅本会话）。
- 本机佐证：在 Weave 项目根下运行 `claude plugin list`（及 `--json`）只列 6 个 user scope 插件，**无 file-guard / mission-control**；`claude plugin details file-guard` → `Plugin "file-guard" not found`。项目 `.claude/settings.json` 也无 `enabledPlugins` 键。
- 结论：Weave 现存的项目副本（`.claude/plugins/file-guard`、`.claude/plugins/mission-control`）对 **CC 而言是死数据**（只有 Weave 自己的 plugin-loader 会读它们）。

### 对批 3 的建议

- 计划中「若会加载→清理前强提示、按钮显式不自动删」的条件分支**不触发**：清理项目副本不改变任何 CC 行为。清理按钮仍按计划做（属遗留数据卫生），提示语可改为「Weave 旧副本」而非暗示 CC 在用。
- 批 3 的合规共享方式二选一：
  - **主推**：全局安装 + 项目 `.claude/settings.json` `enabledPlugins`（H1 链路）；
  - 备选轻量路径（无 marketplace、零安装记录）：把包目录（含 `.claude-plugin/plugin.json`）放进项目 `.claude/skills/` → 以 `<name>@skills-dir` 自动加载（受信任对话框门控；与 `~/.claude/skills/` 同名时用户侧副本优先）。若采用此路径，注意 mods 的 hooks 在 project-scope 下要过项目信任检查。

---

## H5：本地包可用 name@weave 作 key、marketplace 可不在 known_marketplaces

**结论：key 形态证实；「marketplace 可不在 known_marketplaces」部分证实（可不手工维护该文件，但必须对 CC「已知」）。`claude plugin install` 不接受本地目录路径（证伪）。**

### 证据

- key 规则（create-marketplace / loading 文档）：**entry name + `@` + marketplace.json 的 `name`**，即把 marketplace 命名为 `weave`、entry 命名为插件名后，key 就是 `name@weave`；该 key 同时是 `enabledPlugins` 键、`installed_plugins.json` 键、`cache/<marketplace>/` 目录名。`inline/skills-dir/synced` 为保留名，**未见 `local` 保留**。
- `known_marketplaces.json` 实测 schema：

  ```json
  { "<mkt>": { "source": {"source": "github|git|directory", …}, "installLocation": "…", "lastUpdated": "…" } }
  ```

  本机原有两个条目（github/git 源）。实验证明本地目录源会写入 `source:{"source":"directory","path":…}` 且 `installLocation` = 原路径（不拷贝）。
- 「可不在 known_marketplaces.json」的成立边界：
  - `claude plugin marketplace add <本地路径>` 会**自动**写 known_marketplaces.json（并同时写用户 settings `extraKnownMarketplaces`，输出 “declared in user settings”）——所以**不需要 Weave 手工维护 known_marketplaces.json**；
  - 纯 settings 声明也可行：在任意 settings 文件写 `extraKnownMarketplaces: {"weave": {"source": {"source":"directory","path":"…"}}}`，文档（loading）：「A marketplace that settings declare but known_marketplaces.json lacks: Claude Code clones it, then reloads plugins…」——会话启动时自动注册；
  - 但**安装/查找时 marketplace 必须为已知**（要么已在 known_marketplaces.json，要么被 settings 声明），不存在「完全不注册 marketplace 直接 `install name@whatever`」的路径。
- `claude plugin install <path>` 不可用（见 H1 反证）；`claude plugin install --help` 无路径类参数。

### 对批 3 的建议

- 采用计划首选：marketplace 名定为 `weave` → key 自然为 `name@weave`。`globalInstall` 用 H1 两步 CLI 链，known_marketplaces.json / extraKnownMarketplaces 由 `marketplace add` 自动维护，**Weave 不直接改 known_marketplaces.json**。
- R4 的 H5 fallback（「weave 自管全局位+本地 marketplace 条目」）降级为仅当 `claude` CLI 不可 spawn 时启用；此时至少要同时写 `extraKnownMarketplaces`（或 known_marketplaces.json 二选一）+ `installed_plugins.json` + cache 三处，缺一处即加载失败。
- 「全局位+指引确认」（再降级）只在两步 CLI 都失败（如权限/损坏）时使用。
- 本地 directory 源的版本规则（loading 文档）：manifest `version` 优先（实测 cache 目录 = `0.0.1`）；无 git 时 `gitCommitSha` 不写——Weave 读 `installed_plugins.json` 判「已装」时不要依赖该字段。

---

## 安全实验记录（已完全还原）

1. 备份 `settings.json` / `installed_plugins.json` / `known_marketplaces.json`（sha256 记录）。
2. 临时目录 `Temp\cc-h5-test`（marketplace name `cc-h5-test-mkt`，plugin `cc-h5-test-plugin`）。
3. `claude plugin marketplace add` → `claude plugin install … --json` 全链路成功，采集 schema（见 H1/H5）。
4. `claude plugin uninstall … --json` → `claude plugin marketplace remove … --json` 成功；手工删除残留 `cache/cc-h5-test-mkt/`（含 `.orphaned_at`）与临时目录；settings.json 从备份恢复（语义差异仅剩 CLI 写入的空 `extraKnownMarketplaces:{}`，恢复后消除）。
5. **终验**：三份状态文件 sha256 与实验前逐一一致；`grep cc-h5-test` 全部 0 命中；`claude plugin list` 无残留。对 Weave 仓库仅执行只读操作（`validate`/`details`/`list`）+ 写入本文件。
