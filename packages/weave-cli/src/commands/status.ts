import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists, logger, formatTable } from '@weavecode/core';
import { createRuntimeRegistry } from '@weavecode/harness';
import { checkHarness } from '../init/harness-checks.js';
import { t } from '../i18n/index.js';
import type { Command } from '../parser.js';

/** Read the runtime config YAML and display harness status */
async function readRuntimeConfig(targetDir: string): Promise<Record<string, string> | null> {
  const configPath = path.join(targetDir, '.weave', 'config.yaml');
  if (!(await fileExists(configPath))) return null;

  try {
    const raw = await readFile(configPath, 'utf-8');
    const result: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    return result;
  } catch {
    return null;
  }
}

async function checkFile(
  relPath: string,
  targetDir: string,
): Promise<'out.status.present' | 'out.status.missing'> {
  const exists = await fileExists(path.join(targetDir, relPath));
  return exists ? 'out.status.present' : 'out.status.missing';
}

export const statusCommand: Command = {
  name: 'status',
  description: 'cmd.status.desc',
  options: [
    {
      name: 'dir',
      short: 'd',
      description: 'flag.dir',
      type: 'string',
      default: process.cwd(),
    },
  ],

  async action(ctx) {
    const targetDir = String(ctx.flags.dir ?? process.cwd());
    const config = await readRuntimeConfig(targetDir);

    if (!config) {
      logger.warn(t('out.status.notInitialized'));
      return;
    }

    logger.info(t('out.status.header'));

    // harness 识别经 Detector（批 5）：认 `.claude`/`CLAUDE.md` 与 `.codex`/`AGENTS.md`，
    // 不再硬编码 marker；下方存量 claude 表面行与 checkHarness 健康检查保持不动。
    const reg = createRuntimeRegistry();
    const detected = reg
      .byCapability('detect')
      .flatMap((d) =>
        d.detect && d.detect.detect(targetDir).present ? [d.id] : [],
      );

    const entries: [string, string][] = [
      [t('out.status.col.version'), config.initVersion ?? t('out.status.unknown')],
      [t('out.status.col.initialized'), config.initTimestamp ?? t('out.status.unknown')],
      [t('out.status.col.preset'), config.preset ?? t('out.status.unknown')],
      [t('out.status.col.harness'), detected.length > 0 ? detected.join(', ') : t('out.status.unknown')],
      ['CLAUDE.md', t(await checkFile('CLAUDE.md', targetDir))],
      ['settings.json', t(await checkFile('.claude/settings.json', targetDir))],
      ['.mcp.json', t(await checkFile('.mcp.json', targetDir))],
      ['helpers', t(await checkFile('.claude/helpers', targetDir))],
      ['skills', t(await checkFile('.claude/skills', targetDir))],
      ['commands', t(await checkFile('.claude/commands', targetDir))],
      ['agents', t(await checkFile('.claude/agents', targetDir))],
    ];
    if (detected.includes('codex')) {
      entries.push(['.codex/skills', t(await checkFile('.codex/skills', targetDir))]);
    }

    console.log(formatTable(entries));
    console.log();

    // Health checks run after the table so the summary stays readable; they
    // cover the failure modes that are invisible until something downstream
    // misbehaves (a symlink checked out as text, a stale absolute path).
    const issues = await checkHarness(targetDir);
    if (issues.length > 0) {
      logger.warn(t('out.status.issuesFound', { count: issues.length }));
      for (const issue of issues) {
        logger.warn(t('out.status.issue', { message: issue.message }));
        logger.dim(t('out.status.fix', { fix: issue.fix }));
      }
      console.log();
    }
  },
};
