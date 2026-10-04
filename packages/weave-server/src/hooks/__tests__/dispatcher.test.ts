import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../db/db.js';
import type { DatabaseSync } from 'node:sqlite';
import { ProjectRepository, type ProjectRow } from '../../repositories/projects.js';
import { HookRuleRepository } from '../../repositories/hook-rules.js';
import { HookDispatchRepository } from '../../repositories/hook-dispatches.js';
import { PluginStateRepository } from '../../repositories/plugin-states.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { HookRuleRegistry } from '../registry.js';
import { HookEventBus, type HookBusMessage } from '../bus.js';
import { HookDispatcher, type IngestContext } from '../dispatcher.js';
import { setDaemonSettingsDb, writeDaemonSettings } from '../../daemon/settings.js';
import { DISPATCH_MARKER } from '../match.js';
import type { NormalizedHookPayload } from '../types.js';

function payload(over: Partial<NormalizedHookPayload> = {}): NormalizedHookPayload {
  return {
    eventType: 'PostToolUse',
    toolName: 'Edit',
    toolInput: { file_path: 'D:\\proj\\docs\\guide.md' },
    toolResponse: { big: 'x'.repeat(100) },
    cwd: 'D:\\proj',
    transcriptPath: null,
    raw: {},
    ...over,
  };
}

describe('HookDispatcher', () => {
  let db: DatabaseSync;
  let projects: ProjectRepository;
  let project: ProjectRow;
  let hookEvents: HookEventRepository;
  let registry: HookRuleRegistry;
  let dispatches: HookDispatchRepository;
  let bus: HookEventBus;
  let messages: HookBusMessage[];
  let dispatcher: HookDispatcher;
  let fetchCalls: Array<{ url: string; init: RequestInit }>;

  /** 每次调用先落一条真实 hook_events 行（event_id 是外键），再构造 ctx。 */
  const ctx = (over: Partial<IngestContext> = {}): IngestContext => {
    const payload0 = payload(over.payload ?? {});
    const eventId = hookEvents.insert({
      projectId: project.id,
      source: 'claude',
      eventType: payload0.eventType,
      sessionId: over.sessionId ?? 's1',
      payload: JSON.stringify(payload0),
    });
    return {
      eventId,
      project,
      sessionId: 's1',
      payload: payload0,
      source: 'claude',
      ...over,
      payload: payload0,
    };
  };

  beforeEach(async () => {
    setDaemonSettingsDb(openDatabase(':memory:')); // 隔离真实用户配置
    await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
    });
    db = openDatabase(':memory:');
    projects = new ProjectRepository(db);
    hookEvents = new HookEventRepository(db);
    project = projects.register({ path: 'D:\\proj', name: 'proj', token: 't1', source: 'init' });
    registry = new HookRuleRegistry(new HookRuleRepository(db));
    dispatches = new HookDispatchRepository(db);
    bus = new HookEventBus();
    messages = [];
    bus.subscribe((m) => messages.push(m));
    fetchCalls = [];
    dispatcher = new HookDispatcher({
      registry,
      dispatches,
      bus,
      projects,
      sessions: new SessionRepository(db),
      fetchImpl: (async (url: URL | string, init?: RequestInit) => {
        fetchCalls.push({ url: String(url), init: init ?? {} });
        return new Response('ok', { status: 200 });
      }) as typeof fetch,
    });
  });

  afterEach(() => {
    setDaemonSettingsDb(null);
    db.close();
  });

  it('总开关关闭时整体短路：不匹配、不入池、不发事件', async () => {
    registry.create({
      name: 'r',
      projectId: null,
      source: { kind: 'claude-event', event: 'PostToolUse' },
      handler: { type: 'inject', template: 'x {file}' },
    });
    await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: false },
    });

    const outcome = await dispatcher.onIngest(ctx());
    expect(outcome).toEqual({});
    expect(dispatches.list()).toHaveLength(0);
    expect(messages).toHaveLength(0);
  });

  it('inject：命中注入渲染 + 入池(injected) + 防递归标记 + bus 事件', async () => {
    registry.create({
      name: '文档更新',
      projectId: null,
      source: { kind: 'claude-event', event: 'PostToolUse' },
      filter: { toolNames: ['Edit', 'Write'], pathGlobs: ['**/*.md'] },
      handler: { type: 'inject', template: '检查文档 {file}（规则 {rule}）' },
    });

    const outcome = await dispatcher.onIngest(ctx());
    // 模板 {file} 以 posix 归一渲染（跨平台指令文本）
    expect(outcome.additionalContext).toContain('检查文档 D:/proj/docs/guide.md');
    expect(outcome.additionalContext).toContain(`规则 文档更新`);
    expect(outcome.additionalContext).toContain(DISPATCH_MARKER);

    const rows = dispatches.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'injected', mode: 'auto', sessionId: 's1' });
    expect(messages.some((m) => m.kind === 'rule.matched')).toBe(true);
    expect(messages.some((m) => m.kind === 'dispatch.created')).toBe(true);

    // 60s 去重：同 rule × session 第二次不入池
    const again = await dispatcher.onIngest(ctx());
    expect(again.additionalContext).toBeUndefined();
    expect(dispatches.list()).toHaveLength(1);
  });

  it('过滤：toolNames 与 pathGlobs 不命中则不触发；非白名单事件无 inject 候选', async () => {
    registry.create({
      name: 'md only',
      projectId: null,
      source: { kind: 'claude-event', event: 'PostToolUse' },
      filter: { toolNames: ['Edit'], pathGlobs: ['**/*.md'] },
      handler: { type: 'inject', template: 'go' },
    });

    // 文件类型不符
    const ts = await dispatcher.onIngest(
      ctx({ payload: payload({ toolInput: { file_path: 'D\\proj\\src\\a.ts' } }) }),
    );
    expect(ts.additionalContext).toBeUndefined();
    // 工具不符
    const tool = await dispatcher.onIngest(
      ctx({ payload: payload({ toolName: 'Bash' }) }),
    );
    expect(tool.additionalContext).toBeUndefined();
    // 事件不符（无该事件候选）
    const ev = await dispatcher.onIngest(
      ctx({ payload: payload({ eventType: 'PreToolUse' }) }),
    );
    expect(ev.additionalContext).toBeUndefined();
    expect(dispatches.list()).toHaveLength(0);
  });

  it('项目归属：projectId=null 全局命中，scoped 规则只对本项目命中', async () => {
    const other = projects.register({ path: 'D:\\other', name: 'other', token: 't2', source: 'scan' });
    registry.create({
      name: 'global',
      projectId: null,
      source: { kind: 'claude-event', event: 'PostToolUse' },
      handler: { type: 'inject', template: 'global' },
    });
    registry.create({
      name: 'scoped-other',
      projectId: other.id,
      source: { kind: 'claude-event', event: 'PostToolUse' },
      handler: { type: 'inject', template: 'scoped' },
    });

    const outcome = await dispatcher.onIngest(ctx());
    expect(outcome.additionalContext).toContain('global');
    expect(outcome.additionalContext).not.toContain('scoped');
    expect(dispatches.list()).toHaveLength(1);
  });

  it('crossProjectOnly：路径落在其他已注册项目根下才命中', async () => {
    projects.register({ path: 'D:\\lib', name: 'lib', token: 't3', source: 'scan' });
    registry.create({
      name: 'cross',
      projectId: null,
      source: { kind: 'claude-event', event: 'PostToolUse' },
      filter: { crossProjectOnly: true },
      handler: { type: 'inject', template: 'cross {file}' },
    });

    const outside = await dispatcher.onIngest(
      ctx({ payload: payload({ toolInput: { file_path: 'D:\\lib\\README.md' } }) }),
    );
    expect(outside.additionalContext).toContain('cross');

    const inside = await dispatcher.onIngest(
      ctx({ payload: payload({ toolInput: { file_path: 'D:\\proj\\docs\\a.md' } }) }),
    );
    expect(inside.additionalContext).toBeUndefined();
  });

  it('log：只发 bus，不落 dispatch 行', async () => {
    registry.create({
      name: 'log-rule',
      projectId: null,
      source: { kind: 'claude-event', event: 'PostToolUse' },
      handler: { type: 'log' },
      record: false,
    });
    const outcome = await dispatcher.onIngest(ctx());
    expect(outcome).toEqual({});
    expect(dispatches.list()).toHaveLength(0);
    expect(messages.filter((m) => m.kind === 'rule.matched')).toHaveLength(1);
  });

  it('manual：入池 pending、不注入；模板渲染 + 标记', async () => {
    registry.create({
      name: 'manual-rule',
      projectId: null,
      source: { kind: 'claude-event', event: 'PostToolUse' },
      handler: { type: 'manual', template: '手动处理 {file}' },
    });
    const outcome = await dispatcher.onIngest(ctx());
    expect(outcome).toEqual({});
    const rows = dispatches.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', mode: 'manual' });
    expect(rows[0]!.prompt).toContain('手动处理 D:/proj/docs/guide.md');
    expect(rows[0]!.prompt).toContain(DISPATCH_MARKER);
  });

  it('webhook：异步出站，成功回写 succeeded，body 为事件摘要且带 HMAC 签名', async () => {
    registry.create({
      name: 'hook-out',
      projectId: null,
      source: { kind: 'claude-event', event: 'PostToolUse' },
      handler: { type: 'webhook', url: 'https://example.com/ci', secret: 's3cret' },
    });
    const outcome = await dispatcher.onIngest(ctx());
    expect(outcome).toEqual({});
    expect(messages.some((m) => m.kind === 'dispatch.started')).toBe(true);

    // 等异步链完成（信号量 + fetch stub 立即返回）
    for (let i = 0; i < 50 && fetchCalls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(fetchCalls).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));

    const rows = dispatches.list();
    expect(rows[0]!.status).toBe('succeeded');
    expect(rows[0]!.output).toBe('ok');
    const body = String(fetchCalls[0]!.init.body);
    const parsed = JSON.parse(body) as { ruleName: string; filePath: string; toolName: string };
    expect(parsed.ruleName).toBe('hook-out');
    expect(parsed.filePath).toBe('D:\\proj\\docs\\guide.md');
    // 不透传全量 toolResponse
    expect(body).not.toContain('xxxx');
    const headers = fetchCalls[0]!.init.headers as Record<string, string>;
    expect(headers['x-weave-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(messages.some((m) => m.kind === 'dispatch.finished' && m.status === 'succeeded')).toBe(true);
  });

  it('webhook：网络失败回写 failed，不抛出', async () => {
    dispatcher = new HookDispatcher({
      registry,
      dispatches,
      bus,
      projects,
      sessions: new SessionRepository(db),
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    });
    registry.create({
      name: 'down',
      projectId: null,
      source: { kind: 'claude-event', event: 'PostToolUse' },
      handler: { type: 'webhook', url: 'https://example.com/x' },
    });
    await dispatcher.onIngest(ctx());
    for (let i = 0; i < 50 && dispatches.list()[0]?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const row = dispatches.list()[0]!;
    expect(row.status).toBe('failed');
    expect(row.error).toContain('ECONNREFUSED');
  });

  it('rename 双向：session_title diff 采纳外部改名；pending 交付即落定并广播', async () => {
    // 无任何规则也要跑 rename 逻辑
    const first = await dispatcher.onIngest(ctx({ payload: payload({ raw: { session_title: '外部改名' } }) }));
    expect(first.sessionTitle).toBeUndefined();
    // applyReportedTitle 落定由 sessions 完成——经 repo 直接验证
    const sessions = new SessionRepository(db);
    expect(sessions.getBySessionId('s1')?.title).toBe('外部改名');
    expect(messages.filter((m) => m.kind === 'session.renamed')).toHaveLength(1);

    // dashboard 挂 pending：title 立即更新（display 不代持旧名）
    sessions.setPendingTitle('s1', 'dashboard改名');
    expect(sessions.getBySessionId('s1')).toMatchObject({
      title: 'dashboard改名',
      pendingTitle: 'dashboard改名',
    });

    // 工具事件（不携带 session_title 上报）：照常下发 sessionTitle 但不落定——
    // pending 保留，否则下一 UPS 会以旧名经 diff 把 title 自纠回去（改名被吞）
    const tool = await dispatcher.onIngest(ctx({ payload: payload({ raw: {} }) }));
    expect(tool.sessionTitle).toBe('dashboard改名');
    expect(sessions.getBySessionId('s1')).toMatchObject({
      title: 'dashboard改名',
      pendingTitle: 'dashboard改名',
    });
    expect(messages.filter((m) => m.kind === 'session.renamed')).toHaveLength(1); // 未广播

    // 携带 session_title 上报的事件（UserPromptSubmit）：下发 + 落定 + 广播
    const ups = await dispatcher.onIngest(
      ctx({ payload: payload({ eventType: 'UserPromptSubmit', raw: { session_title: '旧名' } }) }),
    );
    expect(ups.sessionTitle).toBe('dashboard改名');
    expect(sessions.getBySessionId('s1')).toMatchObject({
      title: 'dashboard改名',
      pendingTitle: null,
    });
    const renamedEvents = messages.filter((m) => m.kind === 'session.renamed');
    expect(renamedEvents).toHaveLength(2);
    expect(renamedEvents[1]).toMatchObject({ sessionId: 's1', title: 'dashboard改名' });

    // 自纠兜底：会话若未真正应用改名，下一次上报的旧标题经 diff 通道改回
    await dispatcher.onIngest(
      ctx({ payload: payload({ eventType: 'UserPromptSubmit', raw: { session_title: '旧名' } }) }),
    );
    expect(sessions.getBySessionId('s1')).toMatchObject({ title: '旧名', pendingTitle: null });

    // pending 已清 → 后续事件不再下发 sessionTitle
    const third = await dispatcher.onIngest(
      ctx({ payload: payload({ eventType: 'UserPromptSubmit', raw: {} }) }),
    );
    expect(third.sessionTitle).toBeUndefined();
  });

  it('没有任何规则命中时返回空对象', async () => {
    expect(await dispatcher.onIngest(ctx())).toEqual({});
    expect(messages).toHaveLength(0);
  });

  describe('plugin 处理器分支', () => {
    /** 构造一个带 plugin host 的 dispatcher（复用既有 db/registry/bus）。 */
    const makeDispatcher = (handlers: Record<string, (c: unknown) => unknown>, config: Record<string, unknown> = {}): HookDispatcher =>
      new HookDispatcher({
        registry,
        dispatches,
        bus,
        projects,
        sessions: new SessionRepository(db),
        plugins: {
          getHandler: (pluginId, type) => {
            const fn = handlers[`${pluginId}:${type}`];
            return fn ? { type, execute: fn } : undefined;
          },
          getConfig: () => config,
        },
      });

    const createPluginRule = (timeoutMs?: number) =>
      registry.create({
        name: '插件规则',
        projectId: null,
        source: { kind: 'claude-event', event: 'PostToolUse' },
        handler: { type: 'plugin', pluginId: 'demo', handlerType: 'lint' },
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });

    it('返回 prompt → 入池 pending（带防递归标记）+ dispatch.created', async () => {
      createPluginRule();
      const d = makeDispatcher({ 'demo:lint': () => ({ prompt: '插件指令' }) });
      const outcome = await d.onIngest(ctx());
      expect(outcome.additionalContext).toBeUndefined();

      const rows = dispatches.list();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'pending', mode: 'auto' });
      expect(rows[0].prompt).toContain('插件指令');
      expect(rows[0].prompt).toContain(DISPATCH_MARKER);
      expect(messages.some((m) => m.kind === 'dispatch.created')).toBe(true);
    });

    it('返回 additionalContext（白名单事件）→ 注入响应体；非白名单事件 → 丢弃', async () => {
      createPluginRule();
      const d = makeDispatcher({ 'demo:lint': () => ({ additionalContext: '插件注入' }) });
      const outcome = await d.onIngest(ctx());
      expect(outcome.additionalContext).toContain('插件注入');

      // PreToolUse 规则（plugin 类型允许非白名单事件挂载）→ 注入内容丢弃
      registry.create({
        name: 'pre 规则',
        projectId: null,
        source: { kind: 'claude-event', event: 'PreToolUse' },
        handler: { type: 'plugin', pluginId: 'demo', handlerType: 'lint' },
      });
      const off = await d.onIngest(ctx({ payload: payload({ eventType: 'PreToolUse' }) }));
      expect(off.additionalContext).toBeUndefined();
    });

    it('ctx 收到 config 与 logger；handler 抛异常/超时 → 静默跳过，不影响 ingest', async () => {
      createPluginRule(50);
      let seen: unknown;
      const d = makeDispatcher(
        {
          'demo:lint': (c) => {
            seen = c;
            throw new Error('boom');
          },
        },
        { threshold: 3 },
      );
      const outcome = await d.onIngest(ctx());
      expect(outcome).toEqual({}); // 异常吞掉，ingest 正常
      expect(dispatches.list()).toHaveLength(0);
      const ctxArg = seen as { config: Record<string, unknown>; logger: { error: (m: string) => void } };
      expect(ctxArg.config).toEqual({ threshold: 3 });
      expect(typeof ctxArg.logger.error).toBe('function');

      // 超时路径
      const slow = makeDispatcher({ 'demo:lint': () => new Promise((r) => setTimeout(r, 500)) });
      expect(await slow.onIngest(ctx())).toEqual({});
    });

    it('60s 去重：同 rule × session 第二次不重复执行', async () => {
      createPluginRule();
      let calls = 0;
      const d = makeDispatcher({
        'demo:lint': () => {
          calls++;
          return { prompt: 'p' };
        },
      });
      await d.onIngest(ctx());
      await d.onIngest(ctx());
      expect(calls).toBe(1);
      expect(dispatches.list()).toHaveLength(1);
    });

    it('PluginHost 未注入 / handler 未注册 → 跳过不报错', async () => {
      createPluginRule();
      const noHost = new HookDispatcher({
        registry,
        dispatches,
        bus,
        projects,
        sessions: new SessionRepository(db),
      });
      expect(await noHost.onIngest(ctx())).toEqual({});
      const emptyHost = makeDispatcher({});
      expect(await emptyHost.onIngest(ctx())).toEqual({});
      expect(dispatches.list()).toHaveLength(0);
    });
  });

  describe('插件项目启用门控（D3 effective）', () => {
    let states: PluginStateRepository;

    const makeGated = (): HookDispatcher =>
      new HookDispatcher({
        registry,
        dispatches,
        bus,
        projects,
        sessions: new SessionRepository(db),
        pluginStates: states,
      });

    /** 顶层 pluginId 的插件规则（loader 形）+ 一条普通规则做对照。 */
    const createRules = (withPlain = false): void => {
      registry.create({
        name: 'plugin-rule',
        projectId: null,
        source: { kind: 'claude-event', event: 'PostToolUse' },
        handler: { type: 'inject', template: 'plugin-hit' },
        pluginId: 'demo-plugin',
      });
      if (withPlain) {
        registry.create({
          name: 'plain-rule',
          projectId: null,
          source: { kind: 'claude-event', event: 'PostToolUse' },
          handler: { type: 'inject', template: 'plain-hit' },
        });
      }
    };

    beforeEach(() => {
      states = new PluginStateRepository(db);
    });

    it('未同步项目回落全局：states 开 → 命中（现状语义）', async () => {
      states.setEnabled('demo-plugin', true);
      createRules();
      const outcome = await makeGated().onIngest(ctx());
      expect(outcome.additionalContext).toContain('plugin-hit');
    });

    it('已同步未启用 → 不命中；非插件规则不受门控影响（fail-closed 只限插件规则）', async () => {
      states.setEnabled('demo-plugin', true);
      projects.setMeta(project.id, {
        plugins: { syncedAt: '2026-01-01T00:00:00.000Z', enabled: {} },
      });
      project = projects.getById(project.id)!;
      createRules(true);
      const outcome = await makeGated().onIngest(ctx());
      expect(outcome.additionalContext).toContain('plain-hit');
      expect(outcome.additionalContext).not.toContain('plugin-hit');
    });

    it('显式启用 → 命中（即使全局为关）', async () => {
      states.setEnabled('demo-plugin', false);
      projects.setMeta(project.id, {
        plugins: { syncedAt: null, enabled: { 'demo-plugin': true } },
      });
      project = projects.getById(project.id)!;
      createRules();
      const outcome = await makeGated().onIngest(ctx());
      expect(outcome.additionalContext).toContain('plugin-hit');
    });

    it('显式禁用 → 不命中（即使全局为开）', async () => {
      states.setEnabled('demo-plugin', true);
      projects.setMeta(project.id, {
        plugins: { syncedAt: null, enabled: { 'demo-plugin': false } },
      });
      project = projects.getById(project.id)!;
      createRules();
      const outcome = await makeGated().onIngest(ctx());
      expect(outcome.additionalContext).toBeUndefined();
      expect(dispatches.list()).toHaveLength(0);
    });

    it('反向闭环：全局关（loader 级联规则停用）+ 项目同步 + 显式开 → 命中', async () => {
      states.setEnabled('demo-plugin', false);
      projects.setMeta(project.id, {
        plugins: { syncedAt: '2026-01-01T00:00:00.000Z', enabled: { 'demo-plugin': true } },
      });
      project = projects.getById(project.id)!;
      // 全局关 → loader 级联把规则级 enabled 写 false（本批不动 plugin-loader，等值模拟）
      registry.create({
        name: 'plugin-rule',
        projectId: null,
        source: { kind: 'claude-event', event: 'PostToolUse' },
        handler: { type: 'inject', template: 'plugin-hit' },
        pluginId: 'demo-plugin',
        enabled: false,
      });
      const outcome = await makeGated().onIngest(ctx());
      expect(outcome.additionalContext).toContain('plugin-hit');
    });

    it('项目无显式记录 → 规则级停用不被 effective 回落 true 复活（presets/规则级关语义保留）', async () => {
      // 无全局 plugin_states 行（presets 形）：effective 回落 true，但 rule.enabled 仍否决
      registry.create({
        name: 'plugin-rule',
        projectId: null,
        source: { kind: 'claude-event', event: 'PostToolUse' },
        handler: { type: 'inject', template: 'plugin-hit' },
        pluginId: 'demo-plugin',
        enabled: false,
      });
      const outcome = await makeGated().onIngest(ctx());
      expect(outcome.additionalContext).toBeUndefined();
      expect(dispatches.list()).toHaveLength(0);
    });

    it('门控下非插件停用规则仍不命中（enabled 预滤语义不变）', async () => {
      registry.create({
        name: 'plain-off',
        projectId: null,
        source: { kind: 'claude-event', event: 'PostToolUse' },
        handler: { type: 'inject', template: 'plain-hit' },
        enabled: false,
      });
      const outcome = await makeGated().onIngest(ctx());
      expect(outcome.additionalContext).toBeUndefined();
      expect(dispatches.list()).toHaveLength(0);
    });
  });
});
