import { describe, it, expect, vi } from 'vitest';
// 配置面的 user 档落 <homedir>/.claude——homedir 隔离到临时目录，别碰真本机文件
const paths = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => paths.home,
}));
import { MCP_SERVERS, mcpServerForPath } from '../registry.js';
import { toolRequest as orchestrationToolRequest } from '../orchestration.js';
import { toolRequest as sessionsToolRequest, SESSIONS_TOOLS } from '../sessions.js';
import { toolRequest as projectsToolRequest, PROJECTS_TOOLS } from '../projects.js';
import { toolRequest as eventsToolRequest, EVENTS_TOOLS } from '../events.js';

/**
 * MCP-1 对账测试（「及时更新」的机器侧底线）：每个工具转发的 path 必须命中
 * daemon 路由表——路由改名后 MCP 工具静默 404 是最可能发生的漂移形态。
 *
 * 手法 = 起真 daemon（createWeaveServer，测试夹具仓储），把每条
 * `toolRequest` 的 method+path 实际打一遍：命中路由 = 非 404；不命中 = 404，
 * 测试当场报出是哪个工具踩了哪条死路由。
 */
const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  list_orchestrations: {},
  get_orchestration: { id: 1 },
  create_orchestration: {
    name: 't',
    nodes: [{ id: 's', kind: 'session' }],
    edges: [{ id: 'e', from: 's', to: 's', text: 'x' }],
  },
  update_orchestration: { id: 1 },
  delete_orchestration: { id: 1 },
  trigger_orchestration: { id: 1 },
  list_runs: {},
  get_run: { id: 1 },
  cancel_run: { id: 1 },
  list_sessions: {},
};

const SESSION_SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  list_sessions: {},
  get_session: { sessionId: 's1' },
  send_message: { sessionId: 's1', text: 'hi' },
  list_questions: {},
  answer_question: { sessionId: 's1', answers: [{ questionKey: 'q', options: [0] }] },
  interrupt_session: { sessionId: 's1' },
  watch_session: { sessionId: 's1', on: ['idle'] },
  get_session_edits: { sessionId: 's1' },
  get_session_activity: { sessionId: 's1' },
};

describe('MCP 注册表', () => {
  it('/mcp 裸路径指向编排（存量已装配置不断）', () => {
    const def = mcpServerForPath('/mcp');
    expect(def?.name).toBe('weave-orchestration');
    expect(def?.tools.length).toBe(10);
    expect(MCP_SERVERS.map((s) => s.path)).toContain('/mcp');
  });

  it('未知 /mcp/<server> 不命中注册表（server.ts 回 404）', () => {
    expect(mcpServerForPath('/mcp/nope')).toBeNull();
  });

  it('/mcp/sessions 指向 weave-sessions；工具面 = 9 个、各自带 outputSchema', () => {
    const def = mcpServerForPath('/mcp/sessions');
    expect(def?.name).toBe('weave-sessions');
    expect(def?.tools).toHaveLength(SESSIONS_TOOLS.length);
    expect(SESSIONS_TOOLS.map((t) => t.name)).toEqual([
      'list_sessions',
      'get_session',
      'send_message',
      'list_questions',
      'answer_question',
      'interrupt_session',
      'watch_session',
      'get_session_edits',
      'get_session_activity',
    ]);
    for (const tool of SESSIONS_TOOLS) {
      expect(tool.outputSchema.type, `${tool.name} outputSchema`).toBeTruthy();
    }
  });

  it('weave-sessions e2e：tools/list 出 9 工具、list_sessions/get_session 走通真返回', { timeout: 30_000 }, async () => {
    const { openDatabase } = await import('../../../db/db.js');
    const { ProjectRepository } = await import('../../../repositories/projects.js');
    const { createWeaveServer } = await import('../../../daemon/server.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const projectDir = mkdtempSync(join(tmpdir(), 'weave-mcp-sessions-'));
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const projectId = projects.register({ path: projectDir, name: 'e2e', token: 't', source: 'init' }).id;
    const { SessionRepository } = await import('../../../repositories/sessions.js');
    const sessions = new SessionRepository(db);
    for (const id of ['s1', 's2']) sessions.touch(id, projectId);
    const { HookEventRepository } = await import('../../../repositories/hook-events.js');
    const { QuestionTracker } = await import('../../../hooks/question-tracker.js');
    const questionTracker = new QuestionTracker({ sessions, hookEvents: new HookEventRepository(db) });
    const { createServer: netCreate } = await import('node:net');
    const probe = netCreate();
    const port = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port));
    }).finally(() => new Promise<void>((resolve) => probe.close(() => resolve())));
    const httpServer = createWeaveServer({ projects, port, hookSessions: sessions, questionTracker });
    await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));
    const call = async (method: string, params?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
      });
      return { status: res.status, body: await res.json() };
    };
    try {
      const listed = await call('tools/list');
      expect(listed.status).toBe(200);
      const names = (listed.body.result.tools as Array<{ name: string }>).map((t) => t.name);
      expect(names).toHaveLength(9);
      expect(names).toContain('send_message');

      const list = await call('tools/call', { name: 'list_sessions', arguments: {} });
      expect(list.status).toBe(200);
      const listedSessions = list.body.result.structuredContent?.sessions;
      expect(
        listedSessions ?? `isError: ${(list.body.result.content as Array<{ text: string }>)[0]?.text}`,
      ).toHaveLength(2);

      const got = await call('tools/call', { name: 'get_session', arguments: { sessionId: 's1' } });
      expect(got.body.result.structuredContent?.session?.sessionId).toBe('s1');

      const missing = await call('tools/call', { name: 'get_session', arguments: { sessionId: 'nope' } });
      expect(missing.body.result.isError).toBe(true);

      const questions = await call('tools/call', { name: 'list_questions', arguments: {} });
      expect(questions.body.result.structuredContent).toMatchObject({ questions: [] });
    } finally {
      httpServer.close();
      db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('对账：weave-sessions 每个工具转发的请求都命中 daemon 路由（非 404）', { timeout: 30_000 }, async () => {
    const { openDatabase } = await import('../../../db/db.js');
    const { ProjectRepository } = await import('../../../repositories/projects.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const projectDir = mkdtempSync(join(tmpdir(), 'weave-mcp-sessions-recon-'));
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projects.register({ path: projectDir, name: 'recon', token: 't', source: 'init' });
    const { createWeaveServer } = await import('../../../daemon/server.js');
    const httpServer = createWeaveServer({ projects, port: 0 });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as { port: number }).port;
    try {
      for (const tool of SESSIONS_TOOLS) {
        const req = sessionsToolRequest(tool.name, SESSION_SAMPLE_ARGS[tool.name] ?? {});
        const res = await fetch(`http://127.0.0.1:${port}/api${req.path}`, {
          method: req.method,
          headers: req.body === undefined ? {} : { 'content-type': 'application/json' },
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
        });
        // 404 = 路由表里没有这条 path；其余（200/201/400/409/503…）= 命中了路由
        expect(res.status, `tool "${tool.name}" -> ${req.method} ${req.path} is a dead route`)
          .not.toBe(404);
      }
    } finally {
      httpServer.close();
      db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('既有 /mcp 调用回归：tools/list 出 10 工具、tools/call 走通编排转发', { timeout: 30_000 }, async () => {
    const { openDatabase } = await import('../../../db/db.js');
    const { ProjectRepository } = await import('../../../repositories/projects.js');
    const { createWeaveServer } = await import('../../../daemon/server.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const projectDir = mkdtempSync(join(tmpdir(), 'weave-mcp-e2e-'));
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const projectId = projects.register({ path: projectDir, name: 'e2e', token: 't', source: 'init' }).id;
    const { OrchestrationRepository, OrchestrationRunRepository } = await import(
      '../../../repositories/orchestrations.js'
    );
    const { SessionRepository } = await import('../../../repositories/sessions.js');
    const sessions = new SessionRepository(db);
    for (const id of ['s1', 's2']) sessions.touch(id, projectId);
    // MCP 工具的转发目标 = deps.port（ctx.port）——先探一个空端口再起 server，
    // 让 deps.port 与实际监听一致（port:0 的随机分配拿不到 deps 里的回填）。
    const { createServer: netCreate } = await import('node:net');
    const probe = netCreate();
    const port = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port));
    }).finally(() => new Promise<void>((resolve) => probe.close(() => resolve())));
    const httpServer = createWeaveServer({
      projects,
      port,
      orchestrations: new OrchestrationRepository(db),
      orchestrationRuns: new OrchestrationRunRepository(db),
      hookSessions: sessions,
    });
    await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));
    const call = async (method: string, params?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
      });
      return { status: res.status, body: await res.json() };
    };
    try {
      const listed = await call('tools/list');
      expect(listed.status).toBe(200);
      const names = (listed.body.result.tools as Array<{ name: string }>).map((t) => t.name);
      expect(names).toContain('list_orchestrations');
      expect(names).toHaveLength(10);

      const created = await call('tools/call', {
        name: 'create_orchestration',
        arguments: {
          name: 'recon',
          nodes: [{ id: 's1', kind: 'session' }, { id: 's2', kind: 'session' }],
          edges: [{ id: 'e1', from: 's1', to: 's2', text: 'x' }],
        },
      });
      expect(created.status).toBe(200);
      // 工具转发失败会在 isError 里（不是 structuredContent）——失败即断言失败并带出文本
      expect(
        created.body.result.structuredContent ??
          `isError: ${(created.body.result.content as Array<{ text: string }>)[0]?.text}`,
      ).toMatchObject({ ok: true });
      expect(created.body.result.structuredContent.orchestration.name).toBe('recon');

      const runs = await call('tools/call', { name: 'list_runs', arguments: {} });
      expect(runs.body.result.structuredContent).toMatchObject({ runs: [] });
    } finally {
      httpServer.close();
      db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('对账：每个工具转发的请求都命中 daemon 路由（非 404）', { timeout: 30_000 }, async () => {
    const { openDatabase } = await import('../../../db/db.js');
    const { ProjectRepository } = await import('../../../repositories/projects.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const projectDir = mkdtempSync(join(tmpdir(), 'weave-mcp-recon-'));
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const projectId = projects.register({ path: projectDir, name: 'recon', token: 't', source: 'init' }).id;
    void projectId;
    const { createWeaveServer } = await import('../../../daemon/server.js');
    const httpServer = createWeaveServer({ projects, port: 0 });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as { port: number }).port;
    try {
      for (const tool of mcpServerForPath('/mcp')!.tools) {
        const req = orchestrationToolRequest(tool.name, SAMPLE_ARGS[tool.name] ?? {});
        const res = await fetch(`http://127.0.0.1:${port}/api${req.path}`, {
          method: req.method,
          headers: req.body === undefined ? {} : { 'content-type': 'application/json' },
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
        });
        // 404 = 路由表里没有这条 path；其余（200/201/400/409/503…）= 命中了路由
        expect(res.status, `tool "${tool.name}" -> ${req.method} ${req.path} is a dead route`)
          .not.toBe(404);
      }
    } finally {
      httpServer.close();
      db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('/mcp/projects 指向 weave-projects；工具面 = 10 个、各自带 outputSchema', () => {
    const def = mcpServerForPath('/mcp/projects');
    expect(def?.name).toBe('weave-projects');
    expect(def?.tools).toHaveLength(PROJECTS_TOOLS.length);
    expect(PROJECTS_TOOLS.map((t) => t.name)).toEqual([
      'list_projects',
      'get_project',
      'get_config_catalog',
      'get_config',
      'set_config',
      'list_plugins',
      'install_plugin',
      'uninstall_plugin',
      'list_skills',
      'list_market_items',
    ]);
    for (const tool of PROJECTS_TOOLS) {
      expect(tool.outputSchema.type, `${tool.name} outputSchema`).toBeTruthy();
    }
  });

  it('/mcp/events 指向 weave-events；工具面 = 4 个、各自带 outputSchema', () => {
    const def = mcpServerForPath('/mcp/events');
    expect(def?.name).toBe('weave-events');
    expect(def?.tools).toHaveLength(EVENTS_TOOLS.length);
    expect(EVENTS_TOOLS.map((t) => t.name)).toEqual([
      'list_events',
      'get_dashboard',
      'query_api_logs',
      'get_session_usage',
    ]);
    for (const tool of EVENTS_TOOLS) {
      expect(tool.outputSchema.type, `${tool.name} outputSchema`).toBeTruthy();
    }
  });

  it('内置 MCP 目录 = 四枚内置服务（user 档）', () => {
    expect(MCP_SERVERS.map((s) => s.path)).toEqual([
      '/mcp',
      '/mcp/sessions',
      '/mcp/projects',
      '/mcp/events',
    ]);
  });

  it('weave-projects e2e：tools/list 出 10 工具、list_projects/set_config 走通真返回', { timeout: 30_000 }, async () => {
    const { openDatabase } = await import('../../../db/db.js');
    const { ProjectRepository } = await import('../../../repositories/projects.js');
    const { createWeaveServer } = await import('../../../daemon/server.js');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    // 配置面读真 homedir 下的 ~/.claude——mock 已把它隔离到临时目录
    const root = mkdtempSync(join(tmpdir(), 'weave-mcp-projects-'));
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    paths.home = home;
    const projectDir = join(root, 'proj');
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    writeFileSync(join(projectDir, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }), 'utf8');
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const projectId = projects.register({ path: projectDir, name: 'e2e', token: 't', source: 'init' }).id;
    const { createServer: netCreate } = await import('node:net');
    const probe = netCreate();
    const port = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port));
    }).finally(() => new Promise<void>((resolve) => probe.close(() => resolve())));
    const httpServer = createWeaveServer({ projects, port });
    await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));
    const call = async (method: string, params?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
      });
      return { status: res.status, body: await res.json() };
    };
    try {
      const listed = await call('tools/list');
      expect(listed.status).toBe(200);
      const names = (listed.body.result.tools as Array<{ name: string }>).map((t) => t.name);
      expect(names).toHaveLength(10);
      expect(names).toContain('set_config');

      const list = await call('tools/call', { name: 'list_projects', arguments: {} });
      expect(list.status).toBe(200);
      const rows = list.body.result.structuredContent?.projects;
      expect(rows ?? `isError: ${(list.body.result.content as Array<{ text: string }>)[0]?.text}`).toHaveLength(1);
      expect(rows[0].path).toBe(projectDir);
      expect(rows[0].token).toBeUndefined();

      const got = await call('tools/call', { name: 'get_project', arguments: { projectId } });
      expect(got.body.result.structuredContent?.project?.id).toBe(projectId);

      const missing = await call('tools/call', { name: 'get_project', arguments: { projectId: 999 } });
      expect(missing.body.result.isError).toBe(true);

      const read = await call('tools/call', {
        name: 'get_config',
        arguments: { harness: 'claude', file: 'project', projectId },
      });
      expect(read.body.result.structuredContent).toMatchObject({ values: { model: 'opus' } });

      const write = await call('tools/call', {
        name: 'set_config',
        arguments: { harness: 'claude', file: 'project', projectId, values: { model: 'sonnet' } },
      });
      expect(write.body.result.structuredContent).toMatchObject({ values: { model: 'sonnet' } });
    } finally {
      paths.home = '';
      httpServer.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('weave-events e2e：tools/list 出 4 工具、get_dashboard/list_events 走通真返回、outputSchema 断言', { timeout: 30_000 }, async () => {
    const { openDatabase } = await import('../../../db/db.js');
    const { ProjectRepository } = await import('../../../repositories/projects.js');
    const { createWeaveServer } = await import('../../../daemon/server.js');
    const { DashboardRateCache } = await import('../../../hooks/dashboard-rate.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const projectDir = mkdtempSync(join(tmpdir(), 'weave-mcp-events-'));
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const projectId = projects.register({ path: projectDir, name: 'e2e', token: 't', source: 'init' }).id;
    const { HookEventRepository } = await import('../../../repositories/hook-events.js');
    const hookEvents = new HookEventRepository(db);
    hookEvents.insert({
      projectId,
      source: 'claude',
      eventType: 'UserPromptSubmit',
      sessionId: 's1',
      payload: JSON.stringify({ raw: { prompt: 'hi' } }),
    });
    const { SessionRepository } = await import('../../../repositories/sessions.js');
    const sessions = new SessionRepository(db);
    sessions.touch('s1', projectId);
    const { createServer: netCreate } = await import('node:net');
    const probe = netCreate();
    const port = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port));
    }).finally(() => new Promise<void>((resolve) => probe.close(() => resolve())));
    const httpServer = createWeaveServer({ projects, port, hookEvents, hookSessions: sessions, dashboardRate: new DashboardRateCache() });
    await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));
    const call = async (method: string, params?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
      });
      return { status: res.status, body: await res.json() };
    };
    try {
      const listed = await call('tools/list');
      expect(listed.status).toBe(200);
      const tools = listed.body.result.tools as Array<{ name: string; outputSchema: Record<string, unknown> }>;
      expect(tools).toHaveLength(4);
      for (const t of tools) expect(t.outputSchema.type).toBeTruthy();

      const dash = await call('tools/call', { name: 'get_dashboard', arguments: {} });
      expect(dash.status).toBe(200);
      expect(
        dash.body.result.structuredContent?.totals ?? `isError: ${(dash.body.result.content as Array<{ text: string }>)[0]?.text}`,
      ).toMatchObject({ projects: 1, events: 1 });
      expect(Array.isArray(dash.body.result.structuredContent?.series)).toBe(true);

      const events = await call('tools/call', { name: 'list_events', arguments: { projectId } });
      const rows = events.body.result.structuredContent?.events;
      expect(rows ?? `isError: ${(events.body.result.content as Array<{ text: string }>)[0]?.text}`).toHaveLength(1);
      expect(rows[0]).toMatchObject({ eventType: 'UserPromptSubmit', sessionId: 's1' });

      const usage = await call('tools/call', { name: 'get_session_usage', arguments: { sessionId: 's1' } });
      expect(usage.body.result.structuredContent).toMatchObject({ supported: false, usage: null });
    } finally {
      httpServer.close();
      db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('对账：weave-projects / weave-events 每个工具转发的请求都命中 daemon 路由（非 404）', { timeout: 30_000 }, async () => {
    const { openDatabase } = await import('../../../db/db.js');
    const { ProjectRepository } = await import('../../../repositories/projects.js');
    const { createWeaveServer } = await import('../../../daemon/server.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const projectDir = mkdtempSync(join(tmpdir(), 'weave-mcp-pe-recon-'));
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const projectId = projects.register({ path: projectDir, name: 'recon', token: 't', source: 'init' }).id;
    void projectId;
    const { createServer: netCreate } = await import('node:net');
    const probe = netCreate();
    const port = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port));
    }).finally(() => new Promise<void>((resolve) => probe.close(() => resolve())));
    const httpServer = createWeaveServer({ projects, port });
    await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));
    const PROJECT_SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
      list_projects: {},
      get_project: { projectId },
      get_config_catalog: { harness: 'claude' },
      get_config: { harness: 'claude', file: 'project', projectId },
      set_config: { harness: 'claude', file: 'project', projectId, values: {} },
      list_plugins: {},
      install_plugin: { src: 'x' },
      uninstall_plugin: { pluginId: 'p' },
      list_skills: { projectId },
      list_market_items: {},
    };
    const EVENT_SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
      list_events: { projectId },
      get_dashboard: {},
      query_api_logs: {},
      get_session_usage: { sessionId: 's1' },
    };
    try {
      for (const [toolRequest, sample, tools] of [
        [projectsToolRequest, PROJECT_SAMPLE_ARGS, PROJECTS_TOOLS],
        [eventsToolRequest, EVENT_SAMPLE_ARGS, EVENTS_TOOLS],
      ] as const) {
        for (const tool of tools) {
          const req = toolRequest(tool.name, sample[tool.name] ?? {});
          const res = await fetch(`http://127.0.0.1:${port}/api${req.path}`, {
            method: req.method,
            headers: req.body === undefined ? {} : { 'content-type': 'application/json' },
            body: req.body === undefined ? undefined : JSON.stringify(req.body),
          });
          // 404 = 路由表里没有这条 path；其余（200/201/400/409/503…）= 命中了路由
          expect(res.status, `tool "${tool.name}" -> ${req.method} ${req.path} is a dead route`)
            .not.toBe(404);
        }
      }
    } finally {
      httpServer.close();
      db.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
