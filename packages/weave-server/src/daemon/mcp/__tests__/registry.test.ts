import { describe, it, expect } from 'vitest';
import { MCP_SERVERS, mcpServerForPath } from '../registry.js';
import { toolRequest as orchestrationToolRequest } from '../orchestration.js';

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

describe('MCP 注册表', () => {
  it('/mcp 裸路径指向编排（存量已装配置不断）', () => {
    const def = mcpServerForPath('/mcp');
    expect(def?.name).toBe('weave-orchestration');
    expect(def?.tools.length).toBe(10);
    expect(MCP_SERVERS.map((s) => s.path)).toContain('/mcp');
  });

  it('未知 /mcp/<server> 不命中注册表（server.ts 回 404）', () => {
    expect(mcpServerForPath('/mcp/sessions')).toBeNull();
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
});
