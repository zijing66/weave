import path from 'node:path';
import { ensureDaemonRunning } from './daemon.js';
import { t } from '../i18n/index.js';
import type { Command, CommandContext } from '../parser.js';
import { renderTable } from './hooks.js';

/**
 * `weave toolkit` — 批 10 内置工具包扫描管理的终端入口：
 * list / enable / disable（项目级开关，--project 缺省取当前目录）+
 * add-dir / remove-dir（外置目录注册 → sources.json，移除时级联卸载）。
 * 全部经 daemon API 执行（扫描与落盘都在 daemon 侧）。
 */

interface ToolkitPackRow {
  id: string;
  name: string;
  version: string;
  kind: string;
  provenance: string;
  targets: string[];
  enabled: boolean;
}

interface ProjectRowLite {
  id: number;
  path: string;
}

async function call<T>(route: string, init?: RequestInit): Promise<T> {
  const handle = await ensureDaemonRunning();
  const res = await fetch(`http://127.0.0.1:${handle.port}${route}`, {
    ...init,
    headers: {
      authorization: `Bearer ${handle.token}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
}

/** 解析目标项目：--project 路径 > 当前目录；须已注册（init/scan）。 */
async function resolveProjectId(context: CommandContext): Promise<number> {
  const flag = context.flags['project'];
  const want = path.resolve(typeof flag === 'string' && flag ? flag : process.cwd());
  const data = await call<{ projects: ProjectRowLite[] }>('/projects');
  const hit = data.projects.find((p) => path.resolve(p.path) === want);
  if (!hit) {
    console.error(t('out.toolkit.projectNotRegistered', { path: want }));
    process.exit(1);
  }
  return hit.id;
}

function requireId(context: CommandContext): string {
  const id = context.positional[0];
  if (!id) {
    console.error(t('out.toolkit.idRequired'));
    process.exit(1);
  }
  return id;
}

async function list(context: CommandContext): Promise<void> {
  const projectId = await resolveProjectId(context);
  const data = await call<{ packs: ToolkitPackRow[]; dirs: string[] }>(
    `/projects/${projectId}/toolkit`,
  );
  if (data.packs.length === 0) {
    console.log(t('out.toolkit.empty'));
    return;
  }
  console.log(
    renderTable(
      [
        t('out.toolkit.col.state'),
        t('out.toolkit.col.id'),
        t('out.toolkit.col.name'),
        t('out.toolkit.col.kind'),
        t('out.toolkit.col.source'),
        t('out.toolkit.col.targets'),
      ],
      data.packs.map((p) => [
        p.enabled ? '●' : '○',
        p.id,
        p.name,
        p.kind,
        p.provenance,
        p.targets.join('+'),
      ]),
    ),
  );
  if (data.dirs.length > 0) {
    console.log(`\n${t('out.toolkit.dirs')}`);
    for (const dir of data.dirs) console.log(`  ${dir}`);
  }
}

async function setEnabled(context: CommandContext, enabled: boolean): Promise<void> {
  const id = requireId(context);
  const projectId = await resolveProjectId(context);
  const action = enabled ? 'enable' : 'disable';
  try {
    const result = await call<{ pack: ToolkitPackRow; warnings: string[] }>(
      `/projects/${projectId}/toolkit/${encodeURIComponent(id)}/${action}`,
      { method: 'POST' },
    );
    for (const w of result.warnings) console.warn(`⚠ ${w}`);
    console.log(
      enabled
        ? t('out.toolkit.enabled', { id: result.pack.id })
        : t('out.toolkit.disabled', { id: result.pack.id }),
    );
  } catch (err) {
    console.error(
      err instanceof Error && /未找到|not found/i.test(err.message)
        ? t('out.toolkit.notFound', { id })
        : t('out.toolkit.failed', { error: err instanceof Error ? err.message : String(err) }),
    );
    process.exit(1);
  }
}

async function addDir(context: CommandContext): Promise<void> {
  const dir = context.positional[0];
  if (!dir) {
    console.error(t('out.toolkit.dirRequired'));
    process.exit(1);
  }
  try {
    const result = await call<{ dirs: string[] }>('/toolkit/dirs', {
      method: 'POST',
      body: JSON.stringify({ path: path.resolve(dir) }),
    });
    console.log(t('out.toolkit.dirAdded', { path: path.resolve(dir), n: result.dirs.length }));
  } catch (err) {
    console.error(t('out.toolkit.failed', { error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  }
}

async function removeDir(context: CommandContext): Promise<void> {
  const dir = context.positional[0];
  if (!dir) {
    console.error(t('out.toolkit.dirRequired'));
    process.exit(1);
  }
  try {
    const result = await call<{ dirs: string[]; disabled: string[] }>('/toolkit/dirs/remove', {
      method: 'POST',
      body: JSON.stringify({ path: path.resolve(dir) }),
    });
    console.log(
      t('out.toolkit.dirRemoved', {
        path: path.resolve(dir),
        ids: result.disabled.length > 0 ? result.disabled.join(', ') : '-',
      }),
    );
  } catch (err) {
    console.error(t('out.toolkit.failed', { error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  }
}

const projectOption = {
  name: 'project',
  type: 'string' as const,
  description: 'flag.toolkit.project',
};

export const toolkitCommand: Command = {
  name: 'toolkit',
  description: 'cmd.toolkit.desc',
  subcommands: [
    {
      name: 'list',
      description: 'cmd.toolkit.list.desc',
      options: [projectOption],
      action: (context) => list(context),
    },
    {
      name: 'enable',
      description: 'cmd.toolkit.enable.desc',
      options: [projectOption],
      action: (context) => setEnabled(context, true),
    },
    {
      name: 'disable',
      description: 'cmd.toolkit.disable.desc',
      options: [projectOption],
      action: (context) => setEnabled(context, false),
    },
    {
      name: 'add-dir',
      description: 'cmd.toolkit.addDir.desc',
      action: (context) => addDir(context),
    },
    {
      name: 'remove-dir',
      description: 'cmd.toolkit.removeDir.desc',
      action: (context) => removeDir(context),
    },
  ],
};
