# MCP 生态暴露：单服务还是拆分，与变更同步机制

> **2026-10-25 分析稿**。目标（用户原话要点）：将整个 weave 通过 MCP 对外提供完整的生态
> 功能——当前只有编排的编辑功能对外暴露；后续开发相关变动要及时更新到 MCP 服务中，
> 可利用现有机制配置一个自动编排的独立会话，进行 MCP 相关的服务与 skill 更新。
> 姊妹篇：[`会话扩展点与编排重设计.md`](./会话扩展点与编排重设计.md)（L1 扩展点）、
> [`weave定位与竞品分析.md`](./weave定位与竞品分析.md)（会话操作系统定位）。

## 一、现状盘点（代码实测）

- **唯一端点 `/mcp`**：Streamable HTTP、无状态（每请求建一套 server+transport，响应完
  回收），挂在认证门后，凭据 = 本机令牌 `x-weave-local` 头（`server.ts` 的 `/mcp` 分支）。
- **唯一服务 `weave-orchestration` v0.1.0**（`daemon/mcp-orchestration.ts`）：10 个工具
  （list/get/create/update/delete orchestration、trigger、list_runs、get_run、cancel_run、
  list_sessions），全部**零缓存转发 daemon 自己的 REST API**（`api()` fetch 回
  `127.0.0.1:<port>/api`）；每个工具带 `outputSchema`；`list_sessions` 已示范「只回最小
  字段」的策展原则（完整行带大量 UI 专用状态，被裁掉）。
- **内置目录 `BUILTIN_MCP_SERVERS`**（`install/builtin-mcp.ts`）：`name / description /
  path` 三元组；安装**只允许 user 档**（令牌随配置落本机文件，项目档会进仓库）；MCP 页
  以「内置」行出现，安装时服务端填实际端口与令牌，前端永远看不到令牌。
- **遗留物**：claude init 的 `mcp-gen.ts` 会往项目 `.mcp.json` 写 `weave` stdio 条目
  （`npx weave mcp start`）——CLI **并无 mcp 子命令**（`commands/` 目录核实：chpass/
  daemon/dashboard/doctor/init/scan/status/uninstall），该条目指向不存在的命令；默认关
  （`mcp.weave=false` 不写文件）。属被 daemon 托管方案取代的旧路径，应随本方案退役
  （`stripWeaveMcp` 保留用于清存量配置）。

## 二、拆分判据：单一大服务 vs 按域多服务

四个关键事实：

1. **工具数 = 上下文成本 + 选择精度衰减**。MCP 客户端把已装 server 的全部工具定义放进
   模型上下文；工具面越大，agent 选错工具的概率越高。全量生态 = 十六能力域，单一大
   服务镜像全部 REST 面会到 60–100+ 个工具——这不是安装问题，是每次对话都在付的
   token 税与准确率税。
2. **拆分在 weave 几乎零边际成本**。所有服务都是同一 daemon 的不同 path、同一令牌、
   同一认证门、同一安装机制（`BUILTIN_MCP_SERVERS` 加一行）；运行时差异只是
   `buildServer` 挂哪份 TOOLS。没有第二个进程、第二份配置面、第二套认证。
3. **拆分的真实收益不在运行时，在安装粒度**：用户按需装——只要会话观察就不必装编排
   编辑；每个服务的工具面各自保持在 10–20 个。
4. **十六个微服务同样不对**：按能力槽一一对应会碎成安装负担（16 行内置目录、16 份
   配置键），且多数域的工具面撑不起一个独立 server。

**结论：按能力域拆少数几个（4 个），不做单一大服务，也不做十六个微服务。** 分组对齐
web api client 十六域的归并（十六域 → 四组），边界沿用既有域词汇，不发明新分类。

## 三、分组提案

| server | path | 覆盖域 | 工具面（策展动词，不镜像 REST） |
|---|---|---|---|
| **weave-orchestration**（既有，不动） | `/mcp`（保留，存量配置不断） | 编排 CRUD / 触发 / 运行日志 | 现有 10 个 |
| **weave-sessions** | `/mcp/sessions` | 会话发现 / 观察 / 投递 / 问答 / 中断 / 订阅 / 改动汇总 | `list_sessions`（全字段版）、`get_session`、`send_message`、`list_questions`、`answer_question`、`interrupt_session`、`watch_session`、`get_session_edits`…（约 10–14 个） |
| **weave-projects** | `/mcp/projects` | 项目 / 配置 / 插件 / 市场 / 上传 | `list_projects`、`get_config`、`set_config`（粒度对齐 config 槽词表，不暴露整键 JSON 编辑）、`list_plugins`、`install_plugin` / `uninstall_plugin`、`list_skills`…（约 10–12 个） |
| **weave-events** | `/mcp/events` | 事件流查询 / 接口日志 / 仪表盘 | `list_events`、`get_dashboard`、`query_api_logs`…（约 4–6 个） |

原则：

- **策展不镜像**：MCP 工具是给 agent 用的动词，不是 REST CRUD 的转写；每工具带
  `outputSchema`（既有惯例）；回包裁最小字段（`list_sessions` 先例）。
- **同名工具不跨服务重复**：`list_sessions` 全字段版归 weave-sessions；orchestration 里
  现有的那份是「选编排节点」的最小面，保留但描述里写明用途差异（或迁移后留别名）。
- **安装仍是 user 档一枚令牌**：MCP 页内置行从 1 行变 4 行，各自独立安装/卸载/启停。
- **写操作过既有服务端校验**：MCP 只是转发层，一切裁决（路径归属、harness 判据、
  投递层序）仍在 daemon API——MCP 永不自带业务逻辑。

## 四、实现要点（独立可先行，不依赖 L1/L2 改造）

1. `mcp-orchestration.ts` 泛化为 `daemon/mcp/` 注册表：`name → { TOOLS, callTool }`；
   `server.ts` 路由按 `/mcp/<server>` 分发；`/mcp` 裸路径保留指向编排（存量已装配置
   不断，退役另行裁决）。
2. `BUILTIN_MCP_SERVERS` 加三行（sessions / projects / events）。
3. **对账测试（「及时更新」的机器侧底线）**：每个工具转发的 path 必须命中 daemon 路由
   表——路由改名后 MCP 工具静默 404 是最可能发生的漂移形态，测试拦在提交前。
4. `mcp-gen.ts` 旧 stdio 路径退役（`stripWeaveMcp` 保留清存量；`mergeMcpJson` /
   `generateMcpJson` 的 `includeWeaveServer` 分支删除）。

## 五、变更同步机制（用户提议的落地）

分两层，各管各的：

**代码层（随版本走）**：工具面是编译进 daemon 的代码，随 weave 发布更新——MCP 工具
名/形状不承诺跨版本稳定，破坏性变更记 DECISIONS。防漂移靠第四节的对账测试。

**流程层（dogfood 自动编排）**：在 weave 仓自身配置一条「MCP 维护」编排——

- **入口** = weave 开发会话（`autoFire` 自然回合触发）；
- **边闸** = `when` 关键词预筛（命中「路由 / MCP / PLUGIN-SPEC」等才继续）→ `condition`
  语义判断（本轮改动是否真的触及 daemon 路由或 MCP 工具面）；
- **命中** → 投递到**专用维护会话**（独立常驻 session）：跑对账测试 → 更新工具清单与
  文档 → 更新 MCP 使用 skill（市场里的 `weave-mcp-usage`，教外部 agent 怎么用这些
  工具）→ 提交；
- **今天就能搭**：L2 编排的 autoFire + when + condition + session 端点全部现成，零新
  机制；L1 扩展点（批 2b）落地后可换成 `turn-end` 绑定，触发从「回合」精到「事件」，
  并享受决策并总结（维护会话的产出摘要回流编排日志）。
- 维护会话本身也是 weave 管理的会话——「会话操作系统」的自举案例：weave 用自己的
  会话维护 weave 的对外生态，这条写进定位稿作参照。

**skill 更新纪律**：若维护触及插件机制，同步内置仓 weave-plugin-creator skill + 内置树
冒烟断言 + marketplace.json（既有三件套硬约束）。

## 六、边界与不做

- **v1 只做 tools 面**：不做 MCP resources / prompts / sampling——SSE、webhook 出口、
  阻塞问答都不是 MCP 该背的（各有既有通道）。
- **MCP 不做第二配置面**：配置读写走 weave-projects 的策展工具，粒度对齐 config 槽
  词表；不暴露整键 JSON 编辑，不绕过「切换与覆盖先弹 diff」的既有裁决。
- **不做跨机暴露**：全部服务仍仅本机；局域网 HTTPS 是 dashboard 的事，MCP 端点不豁免
  认证门。
- **不把 MCP 工具面做成 REST 全集**：策展动词清单为准，新增工具先问「外部 agent 真的
  需要吗」，内部 UI 专用面（statusline、移动端布局等）永不进 MCP。

## 七、与 roadmap 两文档的关系

- **L1 扩展点**（`会话扩展点与编排重设计.md`）= 维护编排的底座：批 2b 落地前用 L2
  编排搭维护会话，落地后换 turn-end 绑定精化触发。
- **定位稿**（`weave定位与竞品分析.md`）第四章取向 1「每个会话都是一个可编程端点」：
  MCP 是这条叙事对 agent 生态的接线面——外部 agent 经 MCP 操作 weave，weave 会话经
  扩展点被编程，同一枚硬币的两面。竞品的 MCP 集成多是「把自家工具暴露给 agent」，
  weave 暴露的是**会话运行时本身**（活会话的观察与投递），这是定位差异的又一实例。

## 八、分批顺序（建议）

| 批 | 内容 | 依赖 |
|---|---|---|
| MCP-1 | 注册表泛化 + `/mcp/<server>` 路由 + 对账测试 + `mcp-gen` 退役（纯重构，行为不变） | 无 |
| MCP-2 | weave-sessions 落地（首个新域，验证分组与策展原则） | MCP-1 |
| MCP-3 | weave-projects + weave-events | MCP-1 |
| MCP-4 | 「MCP 维护」dogfood 编排（L2 形态）+ `weave-mcp-usage` skill 首版 | MCP-2/3 任一 |
| MCP-5 | （批 2b 后）维护编排换 turn-end 绑定精化 | L1 批 2b |
