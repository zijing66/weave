import { ensureDaemonRunning } from './daemon.js';
import { t } from '../i18n/index.js';
import type { Command, CommandContext } from '../parser.js';
import { renderTable } from './hooks.js';
import { exportPlugin, searchPlugins } from '@weave/server';

/**
 * `weave plugins` — 插件分发通道的终端入口（A3）：
 * list / install（本地路径 | git URL）/ uninstall / enable / disable /
 * export / search（sources.json 索引源）。
 * 安装类操作经 daemon API 执行（daemon 内重扫即时生效）；export 走同一 API。
 */

interface PluginRow {
  id: string;
  name: string;
  version: string;
  scope: string;
  status: string;
  ruleCount: number;
  error?: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const handle = await ensureDaemonRunning();
  const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
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

async function list(): Promise<void> {
  const data = await call<{ plugins: PluginRow[] }>('/hooks/plugins');
  if (data.plugins.length === 0) {
    console.log(t('out.plugins.empty'));
    return;
  }
  const rows = data.plugins.map((p) => [
    p.status === 'active' ? '●' : p.status === 'disabled' ? '○' : '✗',
    p.id,
    p.version,
    p.scope,
    String(p.ruleCount),
    p.error ? `${p.name} (${p.error})` : p.name,
  ]);
  console.log(
    renderTable(
      [
        t('out.hooks.col.status'),
        t('out.hooks.plugins.col.id'),
        t('out.hooks.plugins.col.version'),
        t('out.hooks.plugins.col.scope'),
        t('out.hooks.plugins.col.rules'),
        t('out.hooks.plugins.col.name'),
      ],
      rows,
    ),
  );
}

async function requireId(context: CommandContext): Promise<string> {
  const id = context.positional[0];
  if (!id) {
    console.error(t('out.plugins.idRequired'));
    process.exit(1);
  }
  return id;
}

async function setEnabled(context: CommandContext, enabled: boolean): Promise<void> {
  const id = await requireId(context);
  try {
    await call(`/hooks/plugins/${encodeURIComponent(id)}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
    const key = enabled ? 'out.plugins.enabled' : 'out.plugins.disabled';
    console.log(t(key, { id }));
  } catch (err) {
    console.error(t('out.hooks.failed', { error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  }
}

export const pluginsCommand: Command = {
  name: 'plugins',
  description: 'cmd.plugins.desc',
  subcommands: [
    {
      name: 'list',
      description: 'cmd.plugins.list.desc',
      async action() {
        try {
          await list();
        } catch (err) {
          console.error(t('out.hooks.failed', { error: err instanceof Error ? err.message : String(err) }));
          process.exit(1);
        }
      },
    },
    {
      name: 'install',
      description: 'cmd.plugins.install.desc',
      async action(context) {
        const src = context.positional[0];
        if (!src) {
          console.error(t('out.plugins.installUsage'));
          process.exit(1);
        }
        try {
          const result = await call<{
            installed: Array<{ id: string; name: string; version: string }>;
            warnings: string[];
          }>('/hooks/plugins', { method: 'POST', body: JSON.stringify({ src }) });
          for (const w of result.warnings) console.warn(`⚠ ${w}`);
          for (const p of result.installed) {
            console.log(t('out.plugins.installed', { id: p.id, version: p.version }));
          }
        } catch (err) {
          console.error(t('out.hooks.failed', { error: err instanceof Error ? err.message : String(err) }));
          process.exit(1);
        }
      },
    },
    {
      name: 'uninstall',
      description: 'cmd.plugins.uninstall.desc',
      async action(context) {
        const id = await requireId(context);
        try {
          await call(`/hooks/plugins/${encodeURIComponent(id)}/uninstall`, { method: 'POST' });
          console.log(t('out.plugins.uninstalled', { id }));
        } catch (err) {
          console.error(t('out.hooks.failed', { error: err instanceof Error ? err.message : String(err) }));
          process.exit(1);
        }
      },
    },
    {
      name: 'enable',
      description: 'cmd.plugins.enable.desc',
      action: (context) => setEnabled(context, true),
    },
    {
      name: 'disable',
      description: 'cmd.plugins.disable.desc',
      action: (context) => setEnabled(context, false),
    },
    {
      name: 'export',
      description: 'cmd.plugins.export.desc',
      async action(context) {
        const id = await requireId(context);
        const outDir = context.positional[1] ?? '.';
        try {
          // export/search 是本地文件/网络操作，直调 server 的 installer（无需经 daemon）。
          const dest = await exportPlugin(id, outDir);
          console.log(t('out.plugins.exported', { dest }));
        } catch (err) {
          console.error(t('out.hooks.failed', { error: err instanceof Error ? err.message : String(err) }));
          process.exit(1);
        }
      },
    },
    {
      name: 'search',
      description: 'cmd.plugins.search.desc',
      async action(context) {
        const term = context.positional[0] ?? '';
        try {
          const results = await searchPlugins(term);
          if (results.length === 0) {
            console.log(t('out.plugins.searchEmpty'));
            return;
          }
          console.log(
            renderTable(
              [t('out.hooks.plugins.col.id'), t('out.hooks.plugins.col.version'), t('out.plugins.col.desc')],
              results.map((p) => [p.id, p.version, p.description ?? p.name]),
            ),
          );
        } catch (err) {
          console.error(t('out.hooks.failed', { error: err instanceof Error ? err.message : String(err) }));
          process.exit(1);
        }
      },
    },
  ],
};
