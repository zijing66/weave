import { call } from './daemon.js';
import { t } from '../i18n/index.js';
import type { MessageKey } from '../i18n/dict/index.js';
import type { Command, CommandContext } from '../parser.js';

/** 多列对齐输出（formatTable 只支持两列；padEnd 与既有实现同宽语义）。 */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    '  ' + cells.map((c, i) => (c ?? '').padEnd(widths[i]! + 2)).join('');
  return [line(headers), ...rows.map(line)].join('\n');
}

/**
 * `weave hooks` — 规则开关的终端入口（dashboard 深链覆盖不到的脚本化场景）。
 * 只做 list / enable / disable：规则创建涉及嵌套结构编辑，留给 dashboard
 * （statusline 先例：CLI 只读写开关，配置编辑在面板）。
 *
 * ID 支持唯一前缀（uuid 太长，终端里复制不友好）。
 */
interface HookRuleRow {
  id: string;
  name: string;
  enabled: boolean;
  projectId: number | null;
  source: { kind: string; event?: string; routeId?: string };
  handler: { type: string };
}

async function fetchRules(): Promise<HookRuleRow[]> {
  const data = await call<{ rules: HookRuleRow[] }>('/hooks/rules');
  return data.rules;
}

/** 精确或唯一前缀匹配规则 ID；不唯一/找不到返回 undefined。 */
export function resolveRule(
  rules: HookRuleRow[],
  input: string,
): { rule?: HookRuleRow; ambiguous?: boolean } {
  const exact = rules.find((r) => r.id === input);
  if (exact) return { rule: exact };
  const matches = rules.filter((r) => r.id.startsWith(input));
  if (matches.length === 1) return { rule: matches[0] };
  if (matches.length > 1) return { ambiguous: true };
  return {};
}

async function toggle(context: CommandContext, enabled: boolean): Promise<void> {
  const id = context.positional[0];
  if (!id) {
    console.error(t('out.hooks.idRequired'));
    process.exit(1);
  }
  try {
    const rules = await fetchRules();
    const { rule, ambiguous } = resolveRule(rules, id);
    if (ambiguous) {
      console.error(t('out.hooks.ambiguous', { id }));
      process.exit(1);
    }
    if (!rule) {
      console.error(t('out.hooks.notFound', { id }));
      process.exit(1);
    }
    await call(`/hooks/rules/${rule.id}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
    const key: MessageKey = enabled ? 'out.hooks.enabled' : 'out.hooks.disabled';
    console.log(t(key, { name: rule.name }));
  } catch (err) {
    console.error(t('out.hooks.failed', { error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  }
}

interface PluginRow {
  id: string;
  name: string;
  version: string;
  status: 'active' | 'rejected' | 'disabled';
  scope: string;
  ruleCount: number;
  error?: string;
}

async function fetchPlugins(): Promise<PluginRow[]> {
  const data = await call<{ plugins: PluginRow[] }>('/hooks/plugins');
  return data.plugins;
}

export const hooksCommand: Command = {
  name: 'hooks',
  description: 'cmd.hooks.desc',
  subcommands: [
    {
      name: 'list',
      description: 'cmd.hooks.list.desc',
      async action() {
        try {
          const rules = await fetchRules();
          if (rules.length === 0) {
            console.log(t('out.hooks.empty'));
            return;
          }
          const rows = rules.map((r) => [
            r.enabled ? '●' : '○',
            // 兼容读形：hook-event（新）与 legacy claude-event 都取 event；webhook 单列。
            r.source.kind === 'webhook'
              ? `webhook:${r.source.routeId ?? ''}`
              : (r.source.event ?? ''),
            r.handler.type,
            r.name,
            r.projectId == null ? '*' : String(r.projectId),
            r.id.slice(0, 8),
          ]);
          console.log(
            renderTable(
              [
                t('out.hooks.col.status'),
                t('out.hooks.col.event'),
                t('out.hooks.col.handler'),
                t('out.hooks.col.name'),
                t('out.hooks.col.project'),
                t('out.hooks.col.id'),
              ],
              rows,
            ),
          );
        } catch (err) {
          console.error(t('out.hooks.failed', { error: err instanceof Error ? err.message : String(err) }));
          process.exit(1);
        }
      },
    },
    {
      name: 'enable',
      description: 'cmd.hooks.enable.desc',
      action: (context) => toggle(context, true),
    },
    {
      name: 'disable',
      description: 'cmd.hooks.disable.desc',
      action: (context) => toggle(context, false),
    },
    {
      name: 'plugins',
      description: 'cmd.hooks.plugins.desc',
      async action() {
        try {
          const plugins = await fetchPlugins();
          if (plugins.length === 0) {
            console.log(t('out.hooks.plugins.empty'));
            return;
          }
          const rows = plugins.map((p) => [
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
        } catch (err) {
          console.error(t('out.hooks.failed', { error: err instanceof Error ? err.message : String(err) }));
          process.exit(1);
        }
      },
    },
  ],
};
