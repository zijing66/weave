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
- 团队与任务的真相在仓库里的 teams/ 与 playbooks/（state/ 是你的工作底稿）。
- 建会话 / 投递 / 触发编排都经 weave 提供的操作面执行；一次只推进一件事。
- 你自己不做具体开发：拆解、指派、验收、回收。
`;
