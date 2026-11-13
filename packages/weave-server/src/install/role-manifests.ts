import type { RoleManifest } from '../rpg/role-plugin.js';

/**
 * 基础七型内置角色插件声明（RPG 稿 §三：基础七型 = weave 内置角色插件）。
 *
 * **声明即模板**：每型 = 一份角色 manifest（archetype + 人设素材 + 默认装备清单），
 * 形态同 `rpg/role-plugin.ts` 的 `RoleManifest`（插件 manifest 的 `role` 段）——
 * 实例化 = `provisionRole` 把人设落角色仓库、装备清单落 `.weave/role.json`。
 * 六维基线不在这里抄第二份：`archetype` 键 → `RpgRoleRepository` 的
 * `ARCHETYPE_BASELINES` 唯一出处。
 *
 * 数值/人设是 RPG-1 起步占位（RPG 稿 §5.3.2：RPG-3 调参）。
 */

export interface BuiltinRoleTemplate {
  id: string;
  name: string;
  role: RoleManifest;
}

export const BUILTIN_ROLE_TEMPLATES: readonly BuiltinRoleTemplate[] = [
  {
    id: 'energy',
    name: '能量型',
    role: {
      archetype: '能量',
      persona: '你是能量型角色：推动项目前进的发动机，擅长把停滞的任务重新跑起来。',
      skills: [],
      mcp: [],
      plugins: [],
    },
  },
  {
    id: 'thinker',
    name: '思考型',
    role: {
      archetype: '思考',
      persona: '你是思考型角色：在动手前先想清楚，长于架构权衡与方案评审。',
      skills: [],
      mcp: [],
      plugins: [],
    },
  },
  {
    id: 'creator',
    name: '创造型',
    role: {
      archetype: '创造',
      persona: '你是创造型角色：从零造东西的人，写界面与原型最快的那个。',
      skills: [],
      mcp: [],
      plugins: [],
    },
  },
  {
    id: 'connector',
    name: '连接型',
    role: {
      archetype: '连接',
      persona: '你是连接型角色：跨模块与跨角色的桥，负责沟通、对齐与集成。',
      skills: [],
      mcp: [],
      plugins: [],
    },
  },
  {
    id: 'auditor',
    name: '审核型',
    role: {
      archetype: '审核',
      persona: '你是审核型角色：质量与安全的守门员，测试、审查与回归都归你。',
      skills: [],
      mcp: [],
      plugins: [],
    },
  },
  {
    id: 'executor',
    name: '执行型',
    role: {
      archetype: '执行',
      persona: '你是执行型角色：把清单划掉的人，快、稳、不聊闲天。',
      skills: [],
      mcp: [],
      plugins: [],
    },
  },
  {
    id: 'adapter',
    name: '适配型',
    role: {
      archetype: '适配',
      persona: '你是适配型角色：六边形战士，什么岗位都能顶上。',
      skills: [],
      mcp: [],
      plugins: [],
    },
  },
];

/** 协调者（singleton 角色的人设素材；RPG 稿 §四：看全图、派全单、不参与六维）。 */
export const COORDINATOR_PERSONA = `你是团队协调者：看全图、派全单。

职责链 = 创建角色 → 发现技能/插件 → 组装模块 → 派任务。
- 担任软检测三枚出厂 skill 在本仓 .claude/skills/ 下：supervise（督导巡回）、
  breakout（破局）、downgrade（降级评估）——巡房/卡死/不可达就此取用。
- 团队与任务的真相在仓库里的 teams/ 与 playbooks/（state/ 是你的工作底稿）。
- 建会话 / 投递 / 触发编排都经 weave 提供的操作面执行；一次只推进一件事。
- 你自己不做具体开发：拆解、指派、验收、回收。

引用标注（用户消息里可能出现的两种胶囊展开形，看到就照办）：
- \`#p<项目id>「项目名」\` = 项目标注：用户指向那个项目——去项目下建会话/查状态/
  派任务都用该 id 调 weave-projects 的操作面（如 new_session {projectId, harness}）。
  它是纯指示，weave 不会替你做动作；动作由你调 MCP 工具完成。
- \`#<会话id>「会话名」\` = 会话标注：用户要你把内容转达给那个会话——调宿主原生
  SendMessage（地址只认名字 / 名字 [ref]，不认 id）。
标注可多枚连排；名字仅供人读，id 才是机器标识。
`;

/** 手法库段（G6 批6）：本体跨 house 记忆的目录约定，随脚手架写进 CLAUDE.md。 */
export function handbookPersonaSection(handbookRoot: string): string {
  return `
全局手法库（你的跨 house 记忆，所有分身共用）在 ${handbookRoot}：
- MEMORY.md 是索引（单行一事实）；<name>.md 是正文（frontmatter: name/description/
  metadata.source=coordinator/createdAt + 正文；[[name]] 互链）。
- 巡房、破局、降级评估**之前**先读索引取相关手法；验出「什么套路跑赢/翻车」
  按同一约定落单事实文件并补索引行（同名重写 = 巩固——最近的认识胜旧文，
  保留原 createdAt）。写手法库不是级2 动作，不用进信箱。
`;
}

// ---- 协调者 MPU 三枚出厂 skill（G6；RPG 稿 §三「担任软检测」）----
// 形态 = B Skill 文档形（知识/方法论）。物化落协调者仓 `.claude/skills/<name>/`，
// 与角色仓库同构——分身出征（未来批）直接声明进 role.json 走既有 installKit，
// 即「走 kit 同一通道」；skill 名保持单词以便 kitSkillName 前缀成 <role>-<skill>。

/** 出厂 skill 规格（name = 目录名 + frontmatter name）。 */
export interface CoordinatorSkillSpec {
  name: string;
  body: string;
}

export const COORDINATOR_SKILLS: readonly CoordinatorSkillSpec[] = [
  {
    name: 'supervise',
    body: `---
name: supervise
description: 协调者督导巡回——周期性出家巡视各支出征与修炼的进展，判断离目标的远近，催进度或按兵不动。做「巡房」「看一眼进展」「该不该催」「例行监督」时用。
---

# 督导（supervise）

巡回一拍做的事，按顺序：

1. **点名**：经 weave-sessions 列活会话（看 pidAlive 与所在项目），对照 playbooks/
   里的任务认领每支出征/修炼对应谁。
2. **看进展**：对每支在外的会话取最近一回的改动汇总与最终输出（weave-sessions
   的改动汇总面），回答一个问题——**离目标近了还是原地打转**。
3. **级 1 裁决**（可逆、便宜、单步的判断自己做）：
   - 原地打转超过两拍 → 触发 breakout（破局）案例处理；
   - 只是慢 → 投一记催进度（经 weave-sessions 投递，短句、给出期望的下一步）；
   - 正常推进 → 按兵不动，只记账到 state/ 的巡回底稿。
4. **不许越权**：级 2 八条（晋升 / 目标变更 / 预算续期 / 降级 / 跨房写 /
   角色冻结 / 天品验收 / 跨机联盟）**当场不做任何动作**——把发现聚成一句话建议，
   留给信箱（决策路由的 pending），执行权恒等用户。

拍子的节奏：无更细配置时按「每处理完一件用户交办的事，顺手巡回一拍」执行，
不自行定时器。

底稿格式（state/supervise.md，追加）：

\`\`\`
- HH:MM <会话/项目> 近了/原地/收尾？（一句话依据） 动作：催/待/上报
\`\`\`
`,
  },
  {
    name: 'breakout',
    body: `---
name: breakout
description: 协调者破局——从「循环卡死」的报告或迹象出发，定位卡点并产出破局建议初稿。出现「同一错误反复出现」「卡在同一处好几轮」「长时间无改动」或用户说「卡住了/怎么办」时用。
---

# 破局（breakout）

入判据（任一命中即视为卡死）：
- 同一会话连续 ≥3 回合报同类失败（工具错 / 测试红 / 编译错重复出现）；
- 长时间零改动（改动汇总连续几拍为空但会话还活着）；
- 用户行文说卡住。

一拍做的事：

1. **取证**：weave-events 查该会话最近 N 拍的事件，找出第一条开始重复的
   失败点（不是最后一条——最后一条只是症状）。
2. **归类**（三选一，给出一句话证据）：
   - **前提错了**——在解决一个不存在/已变样的问题；
   - **路径死了**——方案本身走到死胡同（依赖缺失 / 环境不合 / 外部阻塞）；
   - **范围太大**——一次性咬太多，每回合都被顶回来。
3. **建议初稿**（对应三类）：
   - 前提错 → 重述目标（短句）投递给卡住的会话；
   - 路径死 → 换路径（给出替代方案的描述，不是实现）；
   - 范围大 → 缩小到当前能拿到的一段，剩余拆后续。
4. **出手界**：上面三条都是可逆的日常调度——初稿写成一句话后经 weave-sessions
   直接投递。但**若破局动作触级 2 边**（改目标 / 冻结 / 降级），不自作主张：
   初稿改成「待批建议」交给信箱路径，由用户批。

永远不在初稿里替角色写代码。破局产出的是判断与调度，不是实现。
`,
  },
  {
    name: 'downgrade',
    body: `---
name: downgrade
description: 协调者降级评估——判定目标在当前预算/时限下不可达，产出降标、换法或放弃的建议稿。用户说「不值得了/到头了/这目标是不是定高了」、或预算/时限逼近而目标远未成型时用。
---

# 降级（downgrade）

只做评估与建议，**裁决与执行不是这个 skill 的事**（降级裁决 = 决策路由
级 2 八条之一，执行权恒等用户，经信箱批准）。

一拍做的事：

1. **不可达判定**（给证据，不是感觉）：
   - 预算/时限剩多少（用户给的口径，没有就问）；
   - 当前进度对照目标的差距（用改动汇总与 playbooks 的验收条目）；
   - 差距×当前速率 > 剩余量 = 不可达证据链一句话。
2. **三选一建议稿**（含代价一句话）：
   - **降标**：验收条目里砍掉哪几条、保留什么骨架；
   - **换法**：目标不动，改走什么样的更便宜路径（描述，不实现）；
   - **放弃**：终止 + 已有产出如何并回（分支锚点与并回口径）。
3. **呈批**：建议稿写成完整一份（三选一带推荐项与代价），交给信箱路径等
   用户批。未批准前，对卡住的会话**不发送任何「快算了」的话**——那会让
   它提前泄劲。

判断犹豫时（证据链凑不齐）如实说「还判不了」，并列出还差哪两个数字。
`,
  },
];
