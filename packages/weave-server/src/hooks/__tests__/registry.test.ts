import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { HookRuleRepository } from '../../repositories/hook-rules.js';
import { HookDispatchRepository } from '../../repositories/hook-dispatches.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { HookRuleRegistry } from '../registry.js';

function setup() {
  const db = openDatabase(':memory:');
  const projects = new ProjectRepository(db);
  const rules = new HookRuleRepository(db);
  const registry = new HookRuleRegistry(rules);
  return { db, projects, rules, registry };
}

const injectRule = {
  name: '文档更新注入',
  projectId: null,
  source: { kind: 'claude-event', event: 'PostToolUse' } as const,
  filter: { pathGlobs: ['**/*.md'] },
  handler: { type: 'inject' as const, template: '检查文档: {file}' },
};

describe('HookRuleRepository', () => {
  it('创建规则并 JSON 往返（filter/handler 归一化，log 默认 record=false）', () => {
    const { db, rules } = setup();
    const rule = rules.create(injectRule);
    expect(rule.id).toBeTruthy();
    expect(rule.enabled).toBe(true);
    expect(rule.timeoutMs).toBe(10_000);
    expect(rule.record).toBe(true); // inject 默认入池记账

    const log = rules.create({
      name: 'log',
      projectId: null,
      source: { kind: 'claude-event', event: 'PreToolUse' },
      handler: { type: 'log' },
    });
    expect(log.record).toBe(false);

    const reloaded = rules.getById(rule.id);
    expect(reloaded).toEqual(rule);
    expect(reloaded?.handler).toEqual({ type: 'inject', template: '检查文档: {file}' });
    expect(reloaded?.filter.pathGlobs).toEqual(['**/*.md']);
    db.close();
  });

  it('list(projectId) 附带全局规则；setEnabled 单字段更新；remove 级联 dispatches', () => {
    const { db, projects, rules } = setup();
    const p1 = projects.register({ path: '/a', name: 'a', token: 't1', source: 'init' });
    const p2 = projects.register({ path: '/b', name: 'b', token: 't2', source: 'init' });
    const global = rules.create(injectRule);
    const scoped = rules.create({ ...injectRule, projectId: p1.id, name: 'p1 规则' });

    expect(rules.list(p1.id).map((r) => r.id).sort()).toEqual([global.id, scoped.id].sort());
    expect(rules.list(p2.id).map((r) => r.id)).toEqual([global.id]);
    expect(rules.list().map((r) => r.id)).toHaveLength(2);

    expect(rules.setEnabled(scoped.id, false)?.enabled).toBe(false);
    expect(rules.getById(global.id)?.enabled).toBe(true);

    const dispatches = new HookDispatchRepository(db);
    dispatches.insert({ ruleId: scoped.id, prompt: 'x', status: 'pending', mode: 'manual' });
    expect(rules.remove(scoped.id)).toBe(true);
    expect(dispatches.list({ ruleId: scoped.id })).toHaveLength(0); // ON DELETE CASCADE
    expect(rules.remove(scoped.id)).toBe(false);
    db.close();
  });

  it('坏行（JSON 损坏）跳过而非抛错', () => {
    const { db, rules } = setup();
    const rule = rules.create(injectRule);
    db.prepare('UPDATE hook_rules SET handler = ? WHERE id = ?').run('{broken', rule.id);
    expect(rules.list()).toHaveLength(0);
    db.close();
  });
});

describe('HookRuleRegistry', () => {
  it('按事件索引候选规则，priority 降序，仅启用项', () => {
    const { db, registry } = setup();
    const low = registry.create({ ...injectRule, name: 'low', priority: 0 });
    const high = registry.create({ ...injectRule, name: 'high', priority: 10 });
    registry.create({
      name: 'disabled',
      projectId: null,
      source: { kind: 'claude-event', event: 'PostToolUse' },
      handler: { type: 'log' },
      enabled: false,
    });

    const c = registry.candidates('PostToolUse');
    expect(c.map((r) => r.id)).toEqual([high.id, low.id]);
    expect(registry.candidates('PreToolUse')).toHaveLength(0);

    registry.setEnabled(high.id, false);
    expect(registry.candidates('PostToolUse').map((r) => r.id)).toEqual([low.id]);
    db.close();
  });

  it('inject 校验：非白名单事件与 webhook 源被拒绝', () => {
    const { db, registry } = setup();
    expect(() =>
      registry.create({
        ...injectRule,
        source: { kind: 'claude-event', event: 'PreToolUse' }, // 不支持 additionalContext
      }),
    ).toThrow(/not supported on event/);
    expect(() =>
      registry.create({
        ...injectRule,
        source: { kind: 'webhook', routeId: 'r1' },
      }),
    ).toThrow(/requires source.kind/);
    expect(registry.list()).toHaveLength(0);

    // Stop/SessionStart/UserPromptSubmit/SubagentStop 均允许
    for (const event of ['Stop', 'SessionStart', 'UserPromptSubmit', 'SubagentStop']) {
      expect(
        registry.create({ ...injectRule, source: { kind: 'claude-event', event } }).id,
      ).toBeTruthy();
    }
    expect(registry.list()).toHaveLength(4);
    db.close();
  });

  it('update 校验沿用新 handler；load 重建索引', () => {
    const { db, registry, rules } = setup();
    const rule = registry.create(injectRule);
    expect(() =>
      registry.update(rule.id, {
        handler: { type: 'inject', template: 'x' },
        source: { kind: 'claude-event', event: 'Notification' },
      }),
    ).toThrow(/not supported/);

    // 绕过 registry 直接改库后 load() 可见
    rules.setEnabled(rule.id, false);
    registry.load();
    expect(registry.candidates('PostToolUse')).toHaveLength(0);
    db.close();
  });
});

describe('HookDispatchRepository', () => {
  it('状态流转 + 列表过滤 + 防递归窗口查询', () => {
    const { db, rules, registry } = setup();
    const rule = registry.create(injectRule);
    const dispatches = new HookDispatchRepository(db);

    const d = dispatches.insert({
      ruleId: rule.id,
      sessionId: 's1',
      prompt: '更新文档',
      status: 'injected',
      mode: 'auto',
    });
    expect(d.status).toBe('injected');
    expect(d.finishedAt).toBeNull();

    dispatches.updateStatus(d.id, { status: 'running', output: 'out', finished: false });
    expect(dispatches.getById(d.id)).toMatchObject({ status: 'running', output: 'out', finishedAt: null });

    dispatches.updateStatus(d.id, { status: 'succeeded', error: 'keep?', finished: true });
    expect(dispatches.getById(d.id)).toMatchObject({
      status: 'succeeded',
      output: 'out', // COALESCE 保留
      error: 'keep?', // 显式传入则更新
      finishedAt: expect.any(String),
    });

    // 防递归窗口
    const recent = dispatches.findRecentAuto(rule.id, 's1', new Date(Date.now() - 60_000).toISOString());
    expect(recent?.id).toBe(d.id);
    expect(
      dispatches.findRecentAuto(rule.id, 's1', new Date(Date.now() + 1_000).toISOString()),
    ).toBeUndefined();
    expect(dispatches.list({ status: 'succeeded' })).toHaveLength(1);
    expect(dispatches.list({ ruleId: 'nope' })).toHaveLength(0);
    db.close();
  });
});

describe('SessionRepository', () => {
  it('touch 幂等 upsert；pending_title 改名流程；session_title diff 检测', () => {
    const { db, projects } = setup();
    const p = projects.register({ path: '/a', name: 'a', token: 't', source: 'init' });
    const sessions = new SessionRepository(db);

    sessions.touch('s1', p.id);
    sessions.touch('s1', null); // project_id 保留首次非空值
    expect(sessions.getBySessionId('s1')?.projectId).toBe(p.id);

    // 外部 /rename：pending 为空时采纳 reported
    expect(sessions.applyReportedTitle('s1', '新名字')).toBe(true);
    expect(sessions.getBySessionId('s1')?.title).toBe('新名字');
    expect(sessions.applyReportedTitle('s1', '新名字')).toBe(false); // 无变化

    // dashboard 改名：挂 pending，外部旧值不采纳
    sessions.setPendingTitle('s1', 'dashboard名');
    expect(sessions.applyReportedTitle('s1', '旧外部名')).toBe(false);
    expect(sessions.getBySessionId('s1')).toMatchObject({
      title: '新名字',
      pendingTitle: 'dashboard名',
    });

    // 通道 A：hook 下发生效后，下一次上报的 session_title 回带 pending 值 → 落定并清 pending
    expect(sessions.applyReportedTitle('s1', 'dashboard名')).toBe(true);
    expect(sessions.getBySessionId('s1')).toMatchObject({ title: 'dashboard名', pendingTitle: null });
    expect(sessions.applyReportedTitle('s1', 'dashboard名')).toBe(false); // 已一致

    // 通道 B：dispatcher 下发 sessionTitle 后 settlePendingTitle 乐观落定
    sessions.setPendingTitle('s1', '再来一次');
    sessions.settlePendingTitle('s1', '再来一次');
    expect(sessions.getBySessionId('s1')).toMatchObject({ title: '再来一次', pendingTitle: null });
    db.close();
  });
});
