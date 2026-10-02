import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../db/db.js';
import type { DatabaseSync } from 'node:sqlite';
import { ProjectRepository, type ProjectRow } from '../../repositories/projects.js';
import { HookRuleRepository } from '../../repositories/hook-rules.js';
import { HookDispatchRepository } from '../../repositories/hook-dispatches.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { HookRuleRegistry } from '../registry.js';
import { HookEventBus, type HookBusMessage } from '../bus.js';
import { HookDispatcher, type IngestContext } from '../dispatcher.js';
import { setDaemonSettingsDir, writeDaemonSettings } from '../../daemon/settings.js';
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
  let settingsDir: string;
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
      ...over,
      payload: payload0,
    };
  };

  beforeEach(async () => {
    settingsDir = await mkdtemp(path.join(tmpdir(), 'weave-dispatcher-'));
    setDaemonSettingsDir(settingsDir);
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
      fetchImpl: (async (url: URL | string, init?: RequestInit) => {
        fetchCalls.push({ url: String(url), init: init ?? {} });
        return new Response('ok', { status: 200 });
      }) as typeof fetch,
    });
  });

  afterEach(() => {
    setDaemonSettingsDir(null);
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

  it('没有任何规则命中时返回空对象', async () => {
    expect(await dispatcher.onIngest(ctx())).toEqual({});
    expect(messages).toHaveLength(0);
  });
});
