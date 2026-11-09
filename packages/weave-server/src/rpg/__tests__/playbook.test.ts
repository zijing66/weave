import { describe, expect, it } from 'vitest';
import { graphsOf, parsePlaybookYaml, renderPlaybook } from '../playbook.js';

/** 单图（向后兼容）+ 多图（11.3#16 互馈环）+ 渲染纯函数的契约锁定。 */

const SINGLE = `
name: Boss·落地页
kind: boss
difficulty: 7
risk: 3
reward: { xp: 500 }
startText: 开始任务
graph:
  nodes:
    - { id: t:start, kind: trigger }
    - { id: r:frontend-dev, role: frontend-dev, module: web/src/ui }
  edges:
    - { from: t:start, to: r:frontend-dev, text: "实现 {upstream}" }
`;

const MULTI = `
name: 互馈·开发测试
kind: 团队
graphs:
  - name: A·开发入口
    nodes:
      - { id: t:start, kind: trigger }
      - { id: r:dev, role: dev }
      - { id: r:test, role: test }
    edges:
      - { from: t:start, to: r:dev, text: "实现 {upstream}" }
      - { from: r:dev, to: r:test, text: "测试 {upstream}" }
  - name: B·测试回投
    nodes:
      - { id: r:test, role: test }
      - { id: r:dev, role: dev }
    edges:
      - { from: r:test, to: r:dev, text: "修复 {upstream}", when: "失败,报错,不通过" }
`;

describe('parsePlaybookYaml', () => {
  it('单图解析：graph 键等价一张图的 graphs（向后兼容）', () => {
    const r = parsePlaybookYaml(SINGLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.playbook.name).toBe('Boss·落地页');
    expect(r.playbook.difficulty).toBe(7);
    expect(graphsOf(r.playbook)).toHaveLength(1);
    expect(graphsOf(r.playbook)![0]!.nodes).toHaveLength(2);
  });

  it('多图解析：graphs 数组按序保留', () => {
    const r = parsePlaybookYaml(MULTI);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(graphsOf(r.playbook)).toHaveLength(2);
    expect(graphsOf(r.playbook)![1]!.name).toBe('B·测试回投');
  });

  it('graphs 与 graph 同给以 graphs 为准', () => {
    const r = parsePlaybookYaml(`${MULTI}\ngraph:\n  nodes:\n    - { id: r:x, role: x }\n  edges: []`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(graphsOf(r.playbook)).toHaveLength(2);
  });

  it('坏 YAML / 缺 name / 空 graphs 如实报错', () => {
    expect(parsePlaybookYaml(':::').ok).toBe(false);
    expect(parsePlaybookYaml('kind: boss\ngraph: { nodes: [], edges: [] }').ok).toBe(false);
    const r = parsePlaybookYaml('name: x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Invalid playbook');
  });

  it('任务属性是模板元数据（difficulty/risk/reward 随文件走）', () => {
    const r = parsePlaybookYaml(SINGLE);
    if (!r.ok) return;
    expect(r.playbook).toMatchObject({ difficulty: 7, risk: 3, reward: { xp: 500 } });
  });
});

describe('renderPlaybook', () => {
  it('单图渲染：r:<role> 占位替换为 sessionId，trigger 原样保留', () => {
    const p = parsePlaybookYaml(SINGLE);
    if (!p.ok) throw new Error(p.error);
    const r = renderPlaybook(p.playbook, { 'frontend-dev': 'sess-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.orchestrations).toHaveLength(1);
    expect(r.orchestrations[0]).toMatchObject({
      name: 'Boss·落地页',
      startText: '开始任务',
    });
    expect(r.orchestrations[0]!.nodes).toEqual([
      { id: 't:start', kind: 'trigger' },
      { id: 'sess-1', kind: 'session' },
    ]);
    expect(r.orchestrations[0]!.edges[0]).toMatchObject({ from: 't:start', to: 'sess-1', text: '实现 {upstream}' });
  });

  it('多图渲染：一剧本出编排集（互馈环双图），name 缺省补序号', () => {
    const p = parsePlaybookYaml(MULTI);
    if (!p.ok) throw new Error(p.error);
    const r = renderPlaybook(p.playbook, { dev: 's-dev', test: 's-test' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.orchestrations.map((o) => o.name)).toEqual(['A·开发入口', 'B·测试回投']);
    expect(r.orchestrations[1]!.edges[0]).toMatchObject({
      from: 's-test',
      to: 's-dev',
      when: '失败,报错,不通过',
    });
  });

  it('缺绑定如实报错（渲染不猜）', () => {
    const p = parsePlaybookYaml(MULTI);
    if (!p.ok) throw new Error(p.error);
    const r = renderPlaybook(p.playbook, { dev: 's-dev' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('no binding for role "test"');
  });

  it('渲染产物过 validateOrchestration 同判据（静态坏图在这里拦）', () => {
    const bad = parsePlaybookYaml(`
name: 坏图
graphs:
  - name: g
    nodes:
      - { id: r:a, role: a }
    edges:
      - { from: r:a, to: r:a, text: x }
`);
    if (!bad.ok) throw new Error(bad.error);
    const r = renderPlaybook(bad.playbook, { a: 's1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Self-loop');
  });
});
