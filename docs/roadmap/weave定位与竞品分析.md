# weave 定位与竞品分析：会话操作系统

> **2026-10-25 定位稿**。起因：会话扩展点设计（[`会话扩展点与编排重设计.md`](./会话扩展点与编排重设计.md)）
> 评审期间，用户要求在计划基础上重新审视 weave 的工具定位——哪些方向是同类竞品无法相比的、
> 哪些可以再提升。本文是定位分析与战略取向的落档；实施类裁决仍以各计划文档为准。

## 一、竞品版图：大家在卷同一层

主流竞品（Vibe Kanban、Conductor、Sculptor、Claude Squad、crystl、Superset、Pane）收敛在
同一个形态：**任务卡 → git worktree 隔离 → agent 干活 → 人 review diff → merge**。中心是
「任务」与「diff 审批流」。框架级（LangGraph、claude-flow/ruflo）是开发者写代码编排，不是
产品。Paperclip 最接近 weave 的编排面，但偏业务运营（hire / budget / approvals），不管终端、
不管会话的「活」。

**共同盲区：agent 在它们那里是「跑一次任务的工人」，不是持续存活的会话。**

## 二、weave 的差异化（按护城河深度排序）

### 1. 会话是「活的生物」，不是任务卡——根本定位差异

竞品的 agent 生命周期 = 任务从 todo 到 done。weave 的会话有完整生命体征：实时状态机
（running / compacting / failed / terminated 六态）、事件链、对话回放（不落库直查转录）、
闲置淘汰、空壳判死。**别人管「任务做完没有」，weave 管「会话活得怎么样」**——扩展点计划
正是把这个优势产品化：会话成为可接线的元件。

### 2. 跨会话通信是真实基建，竞品几乎为零

层① socket 直投（毫秒级）→ 层② 终端击键 → 层③ 队列，带回执闸、暂停闸、1送1回。竞品的
「协作」= 人看 diff 后手动转任务；连 Claude Code 原生 teams 也只在 claude 内部。**weave 是
唯一让 claude 和 codex 会话互相说话、且投递语义经过工程打磨的本地工具**。编排（L2）与扩展
点（L1）都长在这条基建上——这是别人短期补不出来的。

### 3. 终端共生，而非替代

竞品要么自带终端模拟器（重、体验割裂），要么 worktree + 独立进程（脱离用户环境）。weave
在用户**已有的** wezterm / wt / Terminal.app 里：pane env 精确定位、击键注入（阻塞问答作答、
中断 ESC）、可见屏幕分块、窗口唤出。**用户的工作流不被搬家，weave 是寄生在现有习惯上的
增强层**——「模态框只吃键盘」的作答通道这个深度没有第二家做到。

### 4. 多 harness 一等公民 + 能力面抽象

十六能力槽、声明式规格、「不支持也是面」（置灰必给原因）。claude + codex 统一管理，dsh /
zcode 接入计划已备好图纸。竞品的「多 harness」多是启动器层面（能起 claude 也能起 gemini），
采集 / 投递 / 问答的深度适配只有 claude。**weave 的抽象让「接一家新 harness」从重写产品
变成实现一个 driver**。

### 5. 生产消费解耦的工程品质

daemon 死了：harness 零感知、事件积压不丢、恢复自动续跑（hook 脚本纯本地 I/O 恒 exit 0）。
竞品 daemon / 服务挂了 = 全停。加上隐私体检 hook、移动端完整适配（长按 / 拉动 / 返回栈）、
Web Push 三腿提醒——**这是「工具每天陪着你跑」级别的可靠性投入**，竞品是「用的时候打开」
级别。

### 6. 本地优先 + 手机可用

全部数据在本机（sqlite + 文件轴），手机经局域网 HTTPS 管会话、收推送。竞品要么桌面 app
（Conductor / Sculptor），要么云端（Terragon / Cursor agents——代码要上云）。**「代码不出
机器 + 随时随地盯着」这个组合是空位**。

## 三、诚实的短板（竞品有、weave 没有）

| 短板 | 现状 | 影响 |
|---|---|---|
| **worktree 隔离缺失** | 会话共享工作区，并行会话 git 竞态是已知痛点（本机发生过五起 index 竞态事故） | 竞品的**标配**，也是 weave 并行叙事的最大裂缝——「编排十个会话」的前提是它们不打架 |
| **review / 审批闭环弱** | 改动汇总是右键查看级；没有「diff → approve → merge」流 | 竞品的核心闭环（review screen）weave 只有半个——看完 diff 还得回终端自己说「可以」 |
| **任务语义缺失** | kanban 的「spec → 分支 → PR」在 weave 无对应物，要靠编排图硬表达 | 单会话用户（占多数）入门陡——他们要的是任务板不是会话池 |
| **成本面空白** | 无 token / 费用核算；Paperclip 有预算硬停 | 扩展点 + 编排放量后，「fork 烧钱」会从设计问题变成用户投诉 |
| **沙箱 / 权限** | 会话全权限跑在用户机器 | Sculptor 等已做沙箱；企业场景这是门槛 |

## 四、定位主张：不做「又一个 Kanban」，做「会话操作系统」

竞品卷的是**任务管理层**（卡片、看板、review 流），weave 的 uniquely-owned 地层是**会话
运行时**（采集、投递、终端共生、生命周期）。定位一句话：

> **竞品管理「agent 做任务」；weave 经营「会话的生命」——采集它的体征、连通它的彼此、
> 接线它的生命周期。**

三个战略取向：

1. **把 L1 扩展点做成对外叙事的核心**：「每个会话都是一个可编程的端点」——竞品架构上
   做不了（它们没有事件底座、没有消息基建），是真正的 moat。
2. **补 worktree 隔离，但按 weave 的方式**：不做 kanban 化，而是「会话级工作区绑定」——
   编排图 / 绑定的节点可选 worktree 隔离，与并行会话 git 竞态一起解。补短板里性价比最高。
3. **review 闭环借力而非重建**：改动汇总 + 阻塞问答面已能拼出「diff 呈现 + 人批阅」的
   雏形，补一个「批阅 → 投递 approve 回会话」的动作即闭环，不需要做 merge UI。

## 五、近期提升三件（按 ROI，落地评审定稿 2026-10-25）

| # | 事项 | 理由 |
|---|---|---|
| ① | **review 批阅动作**（改动汇总弹窗加「同意 / 驳回」，走既有投递通道） | 天级成本、面向占多数的单会话用户、补竞品核心闭环最显眼的缺口。**范围钉死**（超出即不再是近零成本）：同意 = 固定文案；驳回 = 单行附言输入框；文案带轮次锚点（弹窗手里的 files 清单摘要，否则会话不知道批的是哪批改动）；codex 无 edits 面按派生面置灰；**不做批阅状态机**（投递行被同文案事件认领即凭证） |
| ② | **会话级 worktree 绑定·最小切片** | 补最大短板（五起 git index 竞态是亲历之痛）；只做「会话起手建 worktree + 结束并回主干」，6.4/6.5 冲突梯队全部后置。与扩展点绑定域**概念对齐、实施分期**——同构的只有「作用域」概念，难点在会话生命周期两端与 git 操作面，几乎不共享代码 |
| ③ | **成本面·降级为每会话用量展示** | 原设想 per-binding token 归因有硬骨头：fork 会话被合成名单在 ingest 侧过滤、token 用量根本不进 `hook_events`，归因 = 新采集面而非计量；且扩展点批 2b 的每绑定日上限（`skipped:capped`）已把烧钱面收口。v1 只做每会话用量展示（读转录 usage，纯只读）；per-binding 归因等扩展点真用起来再说 |

三件与扩展点批次（设计稿第七章）的时序：① review 批阅与 rerere 立即（与批 1 并行）；
② worktree 最小切片排批 2b 后（设计词汇与绑定域同期对齐，避免两套作用域语义分叉）；
③ 成本面会话级展示独立可并行。原「成本面是扩展点放量前必备」的表述由批 2b 次数闸
收口，不再构成硬前置。

## 六、worktree 的合并处理：大量冲突怎么解

> 战略取向 2（worktree 隔离）的配套设计。核心论点：**「大量冲突」的正确解法不是更好的
> 合并工具，而是三层梯队——防冲突（weave 有独家优势）→ 机械消冲突 → 语义消冲突，人只看
> 升级上来的残余。**

### 6.1 冲突的成本曲线

冲突成本随**分歧时间超线性增长**：两个分支各自漂移一天再合，冲突量远大于每小时互同步一次
的总和。所以「大量冲突」首先是**集成频率问题**，其次才是合并技术问题——防冲突层（6.4）
因此排在消冲突层之前。

### 6.2 消冲突阶梯（从廉到贵，每层吸收上一层漏掉的）

| 层 | 机制 | 能吃什么 | 吃不掉什么 |
|---|---|---|---|
| **L1 git 机械层** | `ort` 合并策略（2.34+ 默认，重命名检测已很强）、`git rerere`（记住解过的冲突块并重放）、`-X ours/theirs`（单侧优先）、`union` merge driver（按文件类型配置） | 「两边改了不同区域」「重复同一种解法」 | 同区域双向改动、语义冲突 |
| **L2 结构层** | **mergiraf**（AST 三方合并：树级合并，两边各加一个方法 → 自动都保留）、**jj**（jujutsu）冲突一等公民（冲突可物化、其上可继续提交）、`git imerge`（大合并拆小步格阵） | 同文件内「结构不相交」的改动 | 语义相撞（两边改同一函数且意图不同） |
| **L3 agent 语义层** | fork 一个**解决会话**：喂 base / ours / theirs 三方 diff + **双方意图说明**（任务 spec / prompt——weave 天然有），产出语义合并 + 自证（跑测试 / lint） | 语义冲突、跨文件联动 | 意图本身矛盾（两个任务真在做相反的事） |
| **L4 人** | 只看 L3 产出 diff（走 review 批阅闭环） | 意图裁决 | — |

关键认知：**L3 的输入质量决定成败**。人类解冲突最缺的不是手速而是「对面分支为什么这么改」
——weave 的编排 / 绑定域里每个分支的意图（任务文本、会话 prompt、`{summary}`）是现成的。
这是 agent 时代合并比人类时代**更有优势**的地方，不是劣势。

### 6.3 合并顺序优化（被普遍忽视的一层）

N 个分支依次合入时，**合并顺序影响总冲突量**。贪心策略：每次挑「与当前主干冲突最小」的
分支先合（`merge --no-commit --dry-run` 试算），合完重算。weave 编排域可将其做成「合并梯」
的自动排序。

### 6.4 防冲突：weave 的独家牌

竞品只能在合并时看到 diff（事后）；**weave 在会话运行中就知道每个会话在改哪些文件**——
`edits` 槽（改动汇总）本就按轮提取 Edit/Write 调用。由此：

1. **冲突雷达**：会话 A 与 B 都在碰 `payments/` → 编排 / 绑定层实时告警，趁早 rebase 或
   改派任务，而不是等两边完工。竞品做不了——它们没有 hook 级实时文件视野。
2. **任务分区**：编排图节点声明预期触碰路径（task spec → 文件集），调度时避开同域并行
   ——把「大量冲突」在源头压成「少量冲突」。
3. **高频小批集成**：编排图表达「完成 → 合主干 → 跑测试 → 下游 rebase」节拍，让每个分支
   的漂移窗口以小时计而不是以天计。

**这才是 worktree 方向里 weave 该建的差异化，而不是再造一个 merge UI。**

### 6.5 落法（落地评审定稿 2026-10-25）

1. **rerere 默认开**（init 写进项目 git 配置）——半天成本，**立即做**。注意 init 写策略
   （用户文件只追加合并）与「存量项目须重跑 `weave init`」的既有纪律。
2. **冲突雷达——缓做**：前置缺失（worktree 未落地时并行会话共享工作区本身就是危险态，
   告警之后连安全的 rebase 都做不了，无处置承载面）；落地形态先做「会话列表被动指示」
   而非主动告警；数据源可纯从 `hook_events` 建（PostToolUse 的 toolName + file_path 过
   `capFields` 后幸存），不必扫转录。
3. **解决会话模板——分期**：L3 fork 会话标准化（prompt 模板带三方 diff + 双方意图 +
   「跑测试自证」），依赖 worktree 分支隔离与 review 批阅闭环先行，排两者之后。
4. **mergiraf——并入 3**：不是独立项（weave 没有合并流程、无挂载点），正确形态是解决
   会话模板里的一个可选步骤。
5. **合并梯——拆两半**：「合 A → 测试闸 → 合 B → …」表达为 L2 图的**配方今天零代码可
   文档化**（L2 已有测试闸与顺序边）；贪心自动排序（dry-run 试算重算）是新引擎代码，
   等真有多分支合并需求再说。

### 6.6 诚实的边界

- L3 agent 解决有失败率（意图真矛盾时只会瞎调和）——L4 人审不可去，且 L3 产出必须带
  自证（测试 / lint）才算数。
- mergiraf 语言覆盖有限（Rust / TS / Python 等主流语言较好，冷门语言没有）。
- 冲突雷达在高频小改场景可能过噪——阈值按目录粒度起步，别按文件。

一句话：**合并机制的尽头不是「更聪明的 merge」，而是「更早的知道 + 更便宜的消解 + 只把
真语义矛盾留给人和 agent」**。weave 恰好握着「更早的知道」这张别人没有的牌。

## 参照来源

- [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators) ·
  [crystl: best AI agent orchestration tools](https://crystl.dev/blog/best-ai-agent-orchestration-tools/) ·
  [Vibe Kanban vs Paperclip vs Dispatch](https://www.mindstudio.ai/blog/vibe-kanban-vs-paperclip-vs-claude-code-dispatch-comparison) ·
  [augmentcode: open-source agent orchestrators](https://www.augmentcode.com/tools/open-source-agent-orchestrators) ·
  [nimbalyst: platforms 2026](https://nimbalyst.com/blog/best-ai-agent-orchestration-platforms-2026/)
- [Paperclip](https://github.com/paperclipai/paperclip) · [ruflo (claude-flow)](https://github.com/ruvnet/ruflo) ·
  [LangGraph](https://docs.langchain.com/oss/python/langgraph/use-graph-api)
- 三方对标评审记录见 [`会话扩展点与编排重设计.md`](./会话扩展点与编排重设计.md) 头部修订注。
