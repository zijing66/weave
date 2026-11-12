import { describe, expect, it } from 'vitest';
import { expeditionBadgeCountOf, houseRoleBridgeRowsOf, roleAttentionOf } from '../ProjectList';

/**
 * G6 角色可见桥（RPG 稿 §八）派生纯函数：项目行出征徽章 + house 成员折叠区。
 * 只做渲染层聚合——派生不出的态（修炼中等 goal 域事实）如实缺席、不猜。
 */

describe('expeditionBadgeCountOf（项目行出征徽章）', () => {
  const rows = [
    { projectId: 1, status: 'active' },
    { projectId: 1, status: 'merged' },
    { projectId: 2, status: 'active' },
    { projectId: 1, status: 'active' },
    { projectId: 9, status: 'dangling' },
  ];

  it('只数 active 出征；done/conflict 凡非 active 不计', () => {
    expect(expeditionBadgeCountOf(rows, 1)).toBe(2);
    expect(expeditionBadgeCountOf(rows, 2)).toBe(1);
    expect(expeditionBadgeCountOf(rows, 9)).toBe(0);
  });

  it('零出征 = 0（调用方据此不摆徽章）', () => {
    expect(expeditionBadgeCountOf([], 1)).toBe(0);
    expect(expeditionBadgeCountOf(rows, 42)).toBe(0);
  });
});

describe('houseRoleBridgeRowsOf（关联角色折叠区）', () => {
  const houses = [
    {
      coreProjectId: 1,
      members: [
        { kind: 'role', roleId: 11 },
        { kind: 'role', roleId: 12 },
        { kind: 'aux', roleId: null },
        { kind: 'role', roleId: 404 }, // 成员行指向已删角色（防孤儿：跳过不渲染）
      ],
    },
    { coreProjectId: 2, members: [{ kind: 'aux', roleId: null }] },
  ];
  const roles = new Map([
    [11, { id: 11, name: 'flame-coder' }],
    [12, { id: 12, name: 'gardener' }],
  ]);
  const expeditions = [
    { roleId: 11, projectId: 7, status: 'active' },
    { roleId: 12, projectId: 7, status: 'merged' }, // 出征已并回 = 待命
    { roleId: 99, projectId: 7, status: 'active' }, // 非本房角色不关
  ];
  const projectNames = new Map([
    [1, 'weave'],
    [7, '某目标项目'],
  ]);

  it('成员行 = house 的 kind:role 成员；active 出征标目标、其余待命；孤儿成员行跳过', () => {
    expect(houseRoleBridgeRowsOf({ houses, roles, expeditions, projectNames }, 1)).toEqual([
      { roleId: 11, name: 'flame-coder', expedition: { target: '某目标项目' } },
      { roleId: 12, name: 'gardener', expedition: null },
    ]);
  });

  it('没建房（无 house 行）= null（折叠入口不摆）；建了但成员已删光 = 空数组（如实空态）', () => {
    expect(houseRoleBridgeRowsOf({ houses, roles, expeditions, projectNames }, 42)).toBeNull();
    expect(houseRoleBridgeRowsOf({ houses, roles, expeditions, projectNames }, 2)).toEqual([]);
  });

  it('出征目标项目不在列表（已删）= 不猜名（行仍出、expedition 落 null）', () => {
    const rows = houseRoleBridgeRowsOf(
      {
        houses,
        roles,
        expeditions: [{ roleId: 11, projectId: 999, status: 'active' }],
        projectNames,
      },
      1,
    )!;
    expect(rows[0].expedition).toBeNull();
  });
});

describe('roleAttentionOf（G6 角色版双路提醒第二路：折叠区角标）', () => {
  const goals = [
    { id: 1, roleId: 11, status: 'active' },
    { id: 2, roleId: 12, status: 'budget_out' }, // 预算尽 = 待上帝裁
    { id: 3, roleId: 404, status: 'paused' }, // 别家角色不关
  ];

  it('goal 停摆（paused/budget_out）→ 角色角标亮；active/他角不亮', () => {
    expect(roleAttentionOf(12, { goals, pendingDecisions: [] })).toBe(true);
    expect(roleAttentionOf(11, { goals, pendingDecisions: [] })).toBe(false);
    expect(roleAttentionOf(13, { goals, pendingDecisions: [] })).toBe(false);
  });

  it('信箱 pending 指到该角色的 goal（input.goalId）→ 角标亮；坏 input 不炸不亮', () => {
    const pending = [
      { action: 'budget-renew', input: '{"goalId":1}' }, // → role 11
      { action: 'downgrade', input: 'not-json' },
      { action: 'crop-promote', input: '{"cropId":7}' },
    ];
    expect(roleAttentionOf(11, { goals, pendingDecisions: pending })).toBe(true);
    expect(roleAttentionOf(12, { goals, pendingDecisions: pending })).toBe(true); // goal 2 停摆路径仍亮
    expect(roleAttentionOf(13, { goals, pendingDecisions: pending })).toBe(false);
  });

  it('已决行（非 pending）不进角标判据——信箱批完角标退场', () => {
    // 调用方过滤 pending 后传入；这里验证全空 pending 时只剩 goal 停摆信号
    expect(roleAttentionOf(11, { goals, pendingDecisions: [] })).toBe(false);
  });
});
