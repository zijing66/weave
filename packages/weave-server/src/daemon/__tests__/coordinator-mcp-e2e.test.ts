import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
// homedir 隔离到临时目录：配置面的 user 档 / codex home 探测都不碰真本机文件
const paths = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => paths.home,
}));
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer as netCreate } from 'node:net';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { createRuntimeRegistry } from '@weavecode/harness';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { MessageDeliverer } from '../../hooks/message-deliverer.js';
import { readPromptbox } from '../../hooks/promptbox.js';
import { createWeaveServer } from '../../daemon/server.js';
import { setDaemonSettingsDb, writeDaemonSettings } from '../../daemon/settings.js';
import { RpgRoleRepository, RpgGrowthRepository } from '../../rpg/roles.js';
import type { ProjectOpener } from '../../daemon/opener.js';

/**
 * 协调者 MCP 全链验收（波门 C2 后验）：外部 agent 经内置 MCP 的协调者流程——
 * ① MCP weave-projects list_projects（基线可见项目集）→
 * ② REST POST /rpg/coordinator（协调者脚手架，幂等）→
 * ③ REST POST /rpg/roles（建角色 = 项目注册 + RPG 行）→
 * ④ REST new-session（角色会话起在角色项目目录，fake opener 不起真终端）→
 * ⑤ MCP weave-sessions send_message（层③ 入队，落 promptbox 即算送达链通）。
 * 终态断言：角色项目出现在 MCP list_projects、会话行落库、send_message 非 404。
 */
describe('协调者 MCP 全链（weave-projects → rpg → weave-sessions）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let rolesRoot: string;
  let hooksTmp: string;
  let runDirs: string[];
  const tmpDirs: string[] = [];

  const rest = (method: string, url: string, body?: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/api${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const mcp = async (serverPath: string, method: string, params?: unknown): Promise<any> => {
    const res = await fetch(`http://127.0.0.1:${port}${serverPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
    });
    return res.json();
  };

  const mcpCall = async (serverPath: string, name: string, args: Record<string, unknown>) => {
    const body = await mcp(serverPath, 'tools/call', { name, arguments: args });
    if (body.result?.isError) throw new Error((body.result.content as Array<{ text: string }>)[0]?.text);
    return body.result.structuredContent;
  };

  beforeAll(async () => {
    paths.home = mkdtempSync(path.join(tmpdir(), 'weave-coord-mcp-home-'));
    tmpDirs.push(paths.home);
    db = openDatabase(':memory:');
    setDaemonSettingsDb(db);
    await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
    });
    rolesRoot = mkdtempSync(path.join(tmpdir(), 'weave-coord-mcp-roles-'));
    tmpDirs.push(rolesRoot);
    hooksTmp = mkdtempSync(path.join(tmpdir(), 'weave-coord-mcp-hooks-'));
    tmpDirs.push(hooksTmp);
    runDirs = [];
    const opener: ProjectOpener = {
      openExplorer: async () => {},
      openTerminal: async () => {},
      runInTerminal: async (dir) => {
        runDirs.push(dir);
      },
    };
    const projects = new ProjectRepository(db);
    const sessions = new SessionRepository(db);
    // MCP 工具转发回自己的 REST（127.0.0.1:${ctx.port}）⇒ port 必须先探好再装
    const probe = netCreate();
    port = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port));
    }).finally(() => new Promise<void>((resolve) => probe.close(() => resolve())));
    server = createWeaveServer({
      projects,
      port,
      hookSessions: sessions,
      harnesses: createRuntimeRegistry(),
      opener,
      hooksDir: hooksTmp,
      rpgRoles: new RpgRoleRepository(db),
      rpgGrowth: new RpgGrowthRepository(db),
      rpgRolesRoot: rolesRoot,
      messageDeliverer: new MessageDeliverer({
        sessions,
        projects,
        hookEvents: new HookEventRepository(db),
        hooksDir: hooksTmp,
        // 判活全查不到（不猜）：新会话照常入队，也避开 codex PowerShell 探针
        livenessOf: () => new Map(),
      }),
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    server.close();
    db.close();
    setDaemonSettingsDb(null);
    paths.home = '';
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('① 基线：MCP weave-projects list_projects 走通', async () => {
    const listed = await mcp('/mcp/projects', 'tools/list');
    expect((listed.result.tools as Array<{ name: string }>).map((t) => t.name)).toContain('list_projects');
    const out = await mcpCall('/mcp/projects', 'list_projects', {});
    expect(out.projects).toEqual([]);
  });

  let roleProjectId = 0;
  let rolePath = '';
  let roleToken = '';

  it('② 协调者脚手架：POST /rpg/coordinator', async () => {
    const res = await rest('POST', '/rpg/coordinator');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; created: string[]; rolesSeeded: number };
    expect(body.ok).toBe(true);
    expect(body.created).toEqual(['teams', 'roles', 'playbooks', 'state']);
    // 幂等：再敲一次不炸
    const again = await rest('POST', '/rpg/coordinator');
    expect(again.status).toBe(200);
  });

  it('③ 建角色：POST /rpg/roles → 项目注册 + RPG 行', async () => {
    const res = await rest('POST', '/rpg/roles', { name: 'frontend-dev', archetype: '创造' });
    expect(res.status).toBe(201);
    const role = (await res.json()) as { projectId: number; path: string; reused: boolean };
    expect(role.reused).toBe(false);
    expect(path.dirname(role.path)).toBe(rolesRoot);
    roleProjectId = role.projectId;
    rolePath = role.path;
  });

  it('④ 角色会话起在角色项目目录：new-session（fake opener）', async () => {
    const res = await rest('POST', `/projects/${roleProjectId}/new-session`, { harness: 'claude' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; cwd: string };
    expect(body.cwd).toBe(rolePath);
    expect(runDirs).toEqual([rolePath]);
  });

  it('⑤ MCP weave-sessions send_message：非 404、入队落 promptbox', async () => {
    roleToken = new ProjectRepository(db).getByPath(rolePath)!.token;
    const sessionId = 'coord-e2e-1';
    // 送达链前提：会话行 + 该会话至少一条 hook 事件（harness 归属判定）
    new SessionRepository(db).touch(sessionId, roleProjectId);
    new HookEventRepository(db).insert({
      projectId: roleProjectId,
      source: 'claude',
      eventType: 'Stop',
      sessionId,
      payload: '{}',
    });

    const out = await mcpCall('/mcp/sessions', 'send_message', { sessionId, text: '开始干活' });
    expect(out).toMatchObject({ ok: true, status: 'pending' });
    expect(typeof out.messageId).toBe('string');

    const box = readPromptbox(hooksTmp, roleToken);
    expect(box).toHaveLength(1);
    expect(box[0]!.sessionId).toBe(sessionId);
    expect(box[0]!.text.endsWith('开始干活')).toBe(true);
  });

  it('终态：角色项目出现在 MCP list_projects（token 不出栈）', async () => {
    const out = await mcpCall('/mcp/projects', 'list_projects', {});
    const found = (out.projects as Array<Record<string, unknown>>).find((p) => p.id === roleProjectId);
    expect(found).toMatchObject({ name: 'frontend-dev', path: rolePath, source: 'init' });
    expect(found?.token).toBeUndefined();
    const sessionsOut = await mcpCall('/mcp/sessions', 'list_sessions', { projectId: roleProjectId });
    expect((sessionsOut.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId)).toContain(
      'coord-e2e-1',
    );
  });
});
