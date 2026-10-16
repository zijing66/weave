import {
  type Preset,
  type HooksConfig,
  type Harness,
  PresetSchema,
  HARNESS_KEYS,
  logger,
  formatTable,
  resolveComponents,
} from '@weavecode/core';
import { executeInit } from '../init/executor.js';
import { registerProject } from '@weavecode/server';
import { t } from '../i18n/index.js';
import type { Command } from '../parser.js';

/** 可经 --hooks 裁剪的采集事件（与 settings-gen 输出一一对应）。 */
const HOOK_KEYS = [
  'preToolUse',
  'postToolUse',
  'userPromptSubmit',
  'sessionStart',
  'stop',
  'subagentStop',
  'notification',
  'preCompact',
] as const;

/**
 * 解析 `--hooks` 裁剪 flag：
 * - 空/缺省 → `{}`（全部取默认值，即全开）
 * - `none` → 全关
 * - 逗号列表 → 只开列出的事件（未列出的关）
 */
function parseHooksFlag(raw: string): Partial<HooksConfig> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const allOff = Object.fromEntries(HOOK_KEYS.map((k) => [k, false])) as Partial<HooksConfig>;
  if (trimmed === 'none') return allOff;
  const listed = new Set(trimmed.split(',').map((s) => s.trim()).filter(Boolean));
  const unknown = [...listed].filter((k) => !(HOOK_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) logger.warn(t('init.hooksUnknownKeys', { keys: unknown.join(', ') }));
  return Object.fromEntries(HOOK_KEYS.map((k) => [k, listed.has(k)])) as Partial<HooksConfig>;
}

/**
 * 解析 `--harness` flag（仿 `parseHooksFlag`，批 5）：
 * - 空/缺省 → `undefined`（交给交互多选 / 默认 `['claude']` 两级）
 * - 逗号列表 → 只留合法项（去重保序）；非法项 warn 忽略
 * - 全非法 → 回落默认 `['claude']`
 */
export function parseHarnessFlag(raw: string): Harness[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const listed = trimmed.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const valid = [
    ...new Set(
      listed.filter((k): k is Harness => (HARNESS_KEYS as readonly string[]).includes(k)),
    ),
  ];
  const unknown = listed.filter((k) => !(HARNESS_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) logger.warn(t('init.harnessUnknownKeys', { keys: unknown.join(', ') }));
  return valid.length > 0 ? valid : ['claude'];
}

export const initCommand: Command = {
  name: 'init',
  description: 'cmd.init.desc',
  options: [
    {
      name: 'preset',
      short: 'p',
      description: 'flag.init.preset',
      type: 'string',
      default: 'default',
      choices: ['minimal', 'default', 'full'],
    },
    {
      name: 'force',
      short: 'f',
      description: 'flag.init.force',
      type: 'boolean',
      default: false,
    },
    {
      name: 'no-interactive',
      description: 'flag.init.noInteractive',
      type: 'boolean',
      default: false,
    },
    {
      name: 'dir',
      short: 'd',
      description: 'flag.dir',
      type: 'string',
      default: process.cwd(),
    },
    {
      name: 'hooks',
      description: 'flag.init.hooks',
      type: 'string',
      default: '',
    },
    {
      name: 'harness',
      description: 'flag.init.harness',
      type: 'string',
      default: '',
    },
  ],

  async action(ctx) {
    const preset = PresetSchema.parse(ctx.flags.preset ?? 'default') as Preset;
    const force = Boolean(ctx.flags.force);
    // 裸 `--no-interactive` 被 parser 的 `--no-` 前缀语义落在 flags.interactive=false，
    // `--no-interactive=true` 形落在 flags.noInteractive——两种形都认。
    const interactive = ctx.flags.noInteractive !== true && ctx.flags.interactive !== false;
    const targetDir = String(ctx.flags.dir ?? process.cwd());

    logger.info(t('init.banner'));
    logger.dim(t('init.presetTarget', { preset, target: targetDir }));

    const components = resolveComponents(preset);

    let result;
    try {
      result = await executeInit({
        targetDir,
        force,
        interactive,
        preset,
        harnesses: parseHarnessFlag(String(ctx.flags.harness ?? '')),
        components,
        hooks: parseHooksFlag(String(ctx.flags.hooks ?? '')),
        skills: {},
        commands: {},
        agents: {},
        mcp: {},
      });
    } catch (err) {
      // A hard failure (e.g. the platform refuses to create the instruction
      // symlink) must fail loudly rather than leave a half-configured project.
      logger.error(t('init.failed', { error: err instanceof Error ? err.message : String(err) }));
      process.exit(1);
    }

    // Output summary
    if (result.success) {
      registerProject(targetDir, 'init');
      logger.success(t('init.complete'));

      const entries: [string, string][] = [
        [t('init.table.directories'), String(result.created.directories.length)],
        [t('init.table.filesCreated'), String(result.created.files.length)],
        [t('init.table.filesMerged'), String(result.merged.length)],
        [t('init.table.weaveUpdated'), String(result.updated.length)],
        [t('init.table.skills'), String(result.summary.skillsCount)],
        [t('init.table.commands'), String(result.summary.commandsCount)],
        [t('init.table.agents'), String(result.summary.agentsCount)],
      ];
      console.log(formatTable(entries));
      console.log();

      if (result.merged.length > 0) {
        logger.dim(t('init.merged', { count: result.merged.length }));
      }
      if (result.updated.length > 0) {
        logger.dim(t('init.refreshed', { count: result.updated.length }));
      }
      if (result.removed.length > 0) {
        logger.dim(t('init.removed', { count: result.removed.length }));
      }
      if (result.skipped.length > 0) {
        logger.dim(t('init.skipped', { count: result.skipped.length }));
      }
    } else {
      logger.error(t('init.completedWithErrors'));
      for (const err of result.errors) {
        logger.error(t('init.errorLine', { error: err }));
      }
    }
  },
};
