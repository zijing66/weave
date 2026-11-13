import type { McpHttpContext, McpToolDef, McpToolRequest } from './registry.js';

/**
 * 项目域内置 MCP 服务 `weave-projects`：项目发现 / harness 配置（config 槽词表
 * 粒度）/ 插件装卸 / skill 清单 / 资源市场。工具面只转发 daemon 自己的 HTTP API，
 * **不缓存任何状态、不自带业务逻辑**——路径归属、托管键判据、词表白名单等一切
 * 裁决仍在 daemon。
 *
 * 边界（roadmap §六）：不暴露整键 raw JSON 写（web 的 raw 编辑器不在 MCP 复刻）、
 * 不暴露 profile 切换 / 覆盖类动作（那些走「先弹 diff 交用户确认」的既有裁决，
 * `confirm:true` 的直通口不给 MCP）。
 */

async function api<T>(
  ctx: McpHttpContext,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api${path}`, {
    method,
    headers: {
      'x-weave-origin': 'mcp',
      ...(ctx.token ? { 'x-weave-local': ctx.token } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  })();
  if (!res.ok) {
    const message =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return parsed as T;
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
};

const PROJECT_REF = { type: 'object', additionalProperties: true } as const;
const PLUGIN_REF = { type: 'object', additionalProperties: true } as const;
const SKILL_GROUP_REF = { type: 'object', additionalProperties: true } as const;
const MARKET_ITEM_REF = { type: 'object', additionalProperties: true } as const;

export const PROJECTS_TOOLS = [
  {
    name: 'list_projects',
    description:
      'List registered projects with the harnesses each one was initialized for (canStartSession / version / minVersion per harness). Returns { projects: ProjectRow[] }; token and UI-only fields are omitted.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: { projects: { type: 'array', items: PROJECT_REF } },
      required: ['projects'],
    },
  },
  {
    name: 'get_project',
    description:
      'Get one project row (same fields as list_projects). Returns { project }; throws when the id is unknown.',
    inputSchema: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'number' } } },
    outputSchema: { type: 'object', properties: { project: PROJECT_REF }, required: ['project'] },
  },
  {
    name: 'get_config_catalog',
    description:
      'Vocabulary of one harness config file (claude=JSON / codex=TOML): every manageable key with its shape/fields/valueType, plus env vars. Read this before get_config/set_config so you know what a value looks like. Returns { supported, rawFormat, files, keys, envVars }; supported=false when the harness has no config surface.',
    inputSchema: {
      type: 'object',
      required: ['harness'],
      properties: {
        harness: { type: 'string', enum: ['claude', 'codex'] },
        file: { type: 'string', enum: ['user', 'project', 'projectLocal', 'global'], description: 'default user' },
      },
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'get_config',
    description:
      'Read one harness config file: live values (vocabulary keys only; unknown keys are preserved on write but not shown), managed keys, and whether the file drifted from its snapshot baseline. project/projectLocal files need projectId. Returns { path, exists, values, managedKeys, drifted }.',
    inputSchema: {
      type: 'object',
      required: ['harness', 'file'],
      properties: {
        harness: { type: 'string', enum: ['claude', 'codex'] },
        file: { type: 'string', enum: ['user', 'project', 'projectLocal', 'global'] },
        projectId: { type: 'number', description: 'required for file=project/projectLocal' },
      },
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'set_config',
    description:
      'Write a draft of one harness config file (vocabulary keys; unknown keys are preserved, a backup is kept, the snapshot baseline re-syncs). This is the plain form save — it does NOT cover profile switching or file-restore, which require the user-facing diff confirmation and are intentionally not exposed here. Returns the refreshed view { path, exists, values, managedKeys, drifted }.',
    inputSchema: {
      type: 'object',
      required: ['harness', 'file', 'values'],
      properties: {
        harness: { type: 'string', enum: ['claude', 'codex'] },
        file: { type: 'string', enum: ['user', 'project', 'projectLocal', 'global'] },
        projectId: { type: 'number' },
        values: { type: 'object', additionalProperties: true, description: 'full draft at catalog-key granularity' },
      },
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'list_plugins',
    description:
      'List weave plugins (SPI load result across builtin/user/project roots) with load status and per-plugin rule counts. Returns { plugins: PluginInfo[] }; status rejected carries the reason in error.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: { plugins: { type: 'array', items: PLUGIN_REF } },
      required: ['plugins'],
    },
  },
  {
    name: 'install_plugin',
    description:
      'Install a weave plugin from a local directory or git URL into the global plugin root, then reload. Returns { installed: [{id,name,version,dir}], warnings }.',
    inputSchema: { type: 'object', required: ['src'], properties: { src: { type: 'string' } } },
    outputSchema: {
      type: 'object',
      properties: {
        installed: { type: 'array', items: { type: 'object', additionalProperties: true } },
        warnings: { type: 'array', items: { type: 'string' } },
      },
      required: ['installed'],
    },
  },
  {
    name: 'uninstall_plugin',
    description:
      'Uninstall a weave plugin by id (removes its directory from the global plugin root and reloads). Returns { ok }; 404 when the id is unknown.',
    inputSchema: { type: 'object', required: ['pluginId'], properties: { pluginId: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  },
  {
    name: 'list_skills',
    description:
      'List global skills of the host agents (claude/codex), grouped by source: personal dirs and installed plugins (plugin groups carry pluginKey + enabled). Returns { groups: SkillGroup[] }.',
    inputSchema: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'number' } } },
    outputSchema: {
      type: 'object',
      properties: { groups: { type: 'array', items: SKILL_GROUP_REF } },
      required: ['groups'],
    },
  },
  {
    name: 'list_market_items',
    description:
      'List resource-market sources (libraries): managed market copies vs legacy external dirs, with asset-type tags. Returns { items: MarketItem[] }; 503 when the market subsystem is unavailable.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: { items: { type: 'array', items: MARKET_ITEM_REF } },
      required: ['items'],
    },
  },
  {
    name: 'new_session',
    description:
      "Start a new harness session in the project's terminal (bin from the resume surface; no resume args). Opens a terminal itself if none exists; optional worktree=true isolates the session in a fresh git worktree; optional target = a targetId from list_terminals to attach into that exact tab as a split (enumerable presets only — wezterm/wt; a gone or full target fails with the reason instead of silently moving elsewhere); optional title renames the session after it registers (pass the current task, e.g. 'fix login race'). Sessions started via MCP are hidden from the taskbar by default — bring them back with set_terminal_visibility {visibility:'show'}. Returns { ok, command, cwd, worktree? }; 501 when the harness cannot start, 409 when not integrated.",
    inputSchema: {
      type: 'object',
      required: ['projectId', 'harness'],
      properties: {
        projectId: { type: 'number' },
        harness: { type: 'string', enum: ['claude', 'codex'] },
        worktree: { type: 'boolean' },
        target: { type: 'string', description: 'targetId from list_terminals — attach into that tab as a split' },
        title: { type: 'string', description: 'rename the session to this after it registers (use the current task)' },
      },
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'list_terminals',
    description:
      "Attachable terminal targets of a project across all enumerable backends (wezterm tabs, wt named windows), with per-tab pane counts and titles. all=true also lists tabs of OTHER projects (each row carries cwd) — those targets work as split destinations for cross-project side-by-side sessions. Returns { projectId, terminals: AttachTarget[] } — empty when none open or the preset cannot enumerate.",
    inputSchema: {
      type: 'object',
      required: ['projectId'],
      properties: { projectId: { type: 'number' }, all: { type: 'boolean' } },
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'set_terminal_visibility',
    description:
      "System-level hide/show (SW_HIDE/SW_SHOW — gone from taskbar and Alt+Tab too) of a project's terminal windows: either one target (targetId) or all of the project's open windows (omit targetId). win32 only. Returns { ok, changed, failed } for the bulk form, { ok, visibility } for the single-target form.",
    inputSchema: {
      type: 'object',
      required: ['projectId', 'visibility'],
      properties: {
        projectId: { type: 'number' },
        targetId: { type: 'string', description: 'omit to toggle ALL of the project\'s open terminal windows' },
        visibility: { type: 'string', enum: ['hide', 'show'] },
      },
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'check_updates',
    description:
      "Detect drift between the project's installed assets and their market/init sources: skills, mcp, file assets, plugin templates, init files. Returns { skills, mcp, files, pluginTemplates, initFiles, available, needsInit, initVersionBehind, initVersion, weaveVersion } — available counts auto-syncable outdated items; initVersionBehind means the recorded weave init version predates the current weave (suggest re-running weave init).",
    inputSchema: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'number' } } },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'install_asset',
    description:
      "Install one asset from a market library into a project (scope=project) or the global host location (scope=user): skills, commands, agents, rules, mcp, workflows, output-styles. Returns 201 { category, name, scope, agent, path }.",
    inputSchema: {
      type: 'object',
      required: ['projectId', 'category', 'name', 'scope', 'source'],
      properties: {
        projectId: { type: 'number' },
        category: {
          type: 'string',
          enum: ['skill', 'mcp', 'command', 'agent', 'workflow', 'rule', 'output-style'],
        },
        name: { type: 'string' },
        scope: { type: 'string', enum: ['project', 'user'] },
        agent: { type: 'string', enum: ['claude', 'codex'] },
        source: { type: 'string', description: 'sourceDir (dir assets) / sourceFile (file assets) / mcpConfig JSON (mcp)' },
      },
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
] as const satisfies readonly McpToolDef[];

type Args = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const idOf = (args: Args): number => num(args.projectId) ?? 0;

/** 配置视图的策展整形（profiles/backups/liveText 是 web 快照面板的专用字段）。 */
function configView(data: unknown): unknown {
  const v = data as Record<string, unknown>;
  return {
    path: v.path,
    exists: v.exists,
    values: v.values,
    managedKeys: v.managedKeys,
    drifted: v.drifted,
  };
}

/**
 * 工具 → 它转发的 daemon 请求（对账测试遍历这张映射，逐条比对 daemon 路由表）。
 */
export function toolRequest(name: string, args: Args): McpToolRequest {
  switch (name) {
    case 'list_projects':
      return { method: 'GET', path: '/projects' };
    case 'get_project':
      // 服务端没有单条 GET（只有列表）：按 id 过滤，找不到明确报错，
      // 绝不让 SPA 的 HTML 兜底页冒充项目行。
      return { method: 'GET', path: '/projects' };
    case 'get_config_catalog':
      return {
        method: 'GET',
        path: `/harness-config/catalog${qs({ harness: str(args.harness), file: str(args.file) })}`,
      };
    case 'get_config':
      return {
        method: 'GET',
        path: `/harness-config${qs({
          harness: str(args.harness),
          file: str(args.file),
          projectId: num(args.projectId),
        })}`,
      };
    case 'set_config':
      return {
        method: 'PUT',
        path: '/harness-config/values',
        body: {
          harness: args.harness,
          file: args.file,
          ...(num(args.projectId) !== undefined ? { projectId: num(args.projectId) } : {}),
          values: args.values,
        },
      };
    case 'list_plugins':
      return { method: 'GET', path: '/hooks/plugins' };
    case 'install_plugin':
      return { method: 'POST', path: '/hooks/plugins', body: { src: args.src } };
    case 'uninstall_plugin':
      return { method: 'POST', path: `/hooks/plugins/${encodeURIComponent(str(args.pluginId) ?? '')}/uninstall` };
    case 'list_skills':
      return { method: 'GET', path: `/projects/${idOf(args)}/skills/global` };
    case 'list_market_items':
      return { method: 'GET', path: '/market' };
    case 'new_session':
      return {
        method: 'POST',
        path: `/projects/${idOf(args)}/new-session`,
        body: {
          harness: args.harness,
          ...(args.worktree === undefined ? {} : { worktree: args.worktree }),
          ...(args.target === undefined ? {} : { target: args.target }),
          ...(args.title === undefined ? {} : { title: args.title }),
          __viaMcp: true,
        },
      };
    case 'list_terminals':
      return {
        method: 'GET',
        path: `/projects/${idOf(args)}/terminals${args.all === true ? '?all=1' : ''}`,
      };
    case 'set_terminal_visibility':
      return {
        method: 'POST',
        path: args.targetId
          ? `/projects/${idOf(args)}/terminal-visibility`
          : '/terminals/visibility',
        body: args.targetId
          ? { targetId: args.targetId, visibility: args.visibility }
          : { visibility: args.visibility },
      };
    case 'check_updates':
      return { method: 'GET', path: `/projects/${idOf(args)}/updates` };
    case 'install_asset': {
      const category = str(args.category) ?? '';
      const isFileAsset = ['command', 'agent', 'rule', 'workflow', 'output-style'].includes(category);
      return {
        method: 'POST',
        path: `/projects/${idOf(args)}/install`,
        body: {
          category,
          name: args.name,
          scope: args.scope,
          ...(args.agent === undefined ? {} : { agent: args.agent }),
          // 目录资产走 sourceDir，文件资产走 sourceFile，MCP 走 mcpConfig JSON
          ...(category === 'mcp'
            ? { mcpConfig: args.source }
            : isFileAsset
              ? { sourceFile: args.source }
              : { sourceDir: args.source }),
        },
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** 转发回包的策展整形（token 等敏感/UI 专用字段不进 MCP 回包）。 */
function postProcess(name: string, data: unknown, args: Args): unknown {
  switch (name) {
    case 'list_projects': {
      const rows = (data as { projects: Array<Record<string, unknown>> }).projects;
      return {
        projects: rows.map((p) => ({
          id: p.id,
          path: p.path,
          name: p.name,
          source: p.source,
          registeredAt: p.registeredAt,
          lastSeenAt: p.lastSeenAt,
          archivedAt: p.archivedAt,
          hidden: p.hidden,
          harnesses: p.harnesses,
        })),
      };
    }
    case 'get_project': {
      const rows = (data as { projects: Array<Record<string, unknown>> }).projects;
      const found = rows.find((p) => p.id === num(args.projectId));
      if (!found) throw new Error(`Project not found: ${String(args.projectId)}`);
      const { projects: curated } = postProcess('list_projects', { projects: [found] }, args) as {
        projects: Array<Record<string, unknown>>;
      };
      return { project: curated[0] };
    }
    case 'get_config_catalog': {
      const v = data as Record<string, unknown>;
      return {
        supported: v.supported,
        ...(v.supported === true
          ? { rawFormat: v.rawFormat, files: v.files, keys: v.keys, envVars: v.envVars }
          : {}),
      };
    }
    case 'get_config':
    case 'set_config':
      return configView(data);
    case 'list_plugins': {
      const rows = (data as { plugins: Array<Record<string, unknown>> }).plugins;
      return {
        plugins: rows.map((p) => ({
          id: p.id,
          name: p.name,
          version: p.version,
          scope: p.scope,
          status: p.status,
          ruleCount: p.ruleCount,
          ...(p.error === undefined ? {} : { error: p.error }),
        })),
      };
    }
    case 'list_skills': {
      const groups = (data as { groups: Array<Record<string, unknown>> }).groups;
      return {
        groups: groups.map((g) => ({
          source: g.source,
          label: g.label,
          ...(g.pluginKey === undefined ? {} : { pluginKey: g.pluginKey }),
          ...(g.enabled === undefined ? {} : { enabled: g.enabled }),
          skills: (g.skills as Array<Record<string, unknown>>).map((s) => ({
            name: s.name,
            dir: s.dir,
            form: s.form,
          })),
        })),
      };
    }
    case 'list_market_items': {
      const items = (data as { items: Array<Record<string, unknown>> }).items;
      return {
        items: items.map((m) => ({
          id: m.id,
          kind: m.kind,
          path: m.path,
          managed: m.managed,
          builtin: m.builtin,
          ...(m.namespace === undefined ? {} : { namespace: m.namespace }),
          source: m.source,
          tags: m.tags,
        })),
      };
    }
    default:
      return data;
  }
}

export async function callTool(ctx: McpHttpContext, name: string, args: Args): Promise<unknown> {
  const req = toolRequest(name, args);
  const data = await api(ctx, req.method, req.path, req.body);
  return postProcess(name, data, args);
}
