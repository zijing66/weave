import path from 'node:path';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import {
  fileExists,
  logger,
  formatTable,
  HARNESS_DIRS,
  HARNESS_INSTRUCTION_FILES,
  HARNESS_KEYS,
  type Harness,
} from '@weavecode/core';
import { createRuntimeRegistry, type AssetSurface, type FileAssetCategory } from '@weavecode/harness';
import { WEAVE_VERSION } from '@weavecode/server';
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

/** 一行表面项：(表头标签, 目标根相对路径)。 */
type SurfaceRow = [string, string];

/** 表面项的呈现行：标签 + 存在性文案。 */
async function surfaceRow(label: string, relPath: string, targetDir: string): Promise<SurfaceRow> {
  return [label, t(await checkFile(relPath, targetDir))];
}

/**
 * 经 AssetSurface 取某资产类别在项目内的相对路径（posix 归一）；该 harness
 * 无此项目表面（`targetDir` 抛错）返回 null。
 */
function projectSurfaceRel(
  surface: AssetSurface | undefined,
  category: FileAssetCategory,
  targetDir: string,
): string | null {
  if (!surface) return null;
  try {
    const abs = surface.targetDir(category, 'project', targetDir, os.homedir());
    return path.relative(targetDir, abs).split(path.sep).join('/');
  } catch {
    return null;
  }
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
    // 不再硬编码 marker。
    const reg = createRuntimeRegistry();
    const detected = reg
      .byCapability('detect')
      .flatMap((d) =>
        d.detect && d.detect.detect(targetDir).present ? [d.id] : [],
      );

    const entries: SurfaceRow[] = [
      // 两行分开：「CLI 版本」是当下跑的这个命令的版本（WEAVE_VERSION 实时）；
      // 「init 版本」是本项目 init 生成物当初的版本（config.initVersion，重跑
      // init 才更新）——混在一行会让人拿着 0.1.0 以为 CLI 是旧的。
      [t('out.status.col.cliVersion'), WEAVE_VERSION],
      [t('out.status.col.initVersion'), config.initVersion ?? t('out.status.unknown')],
      [t('out.status.col.initialized'), config.initTimestamp ?? t('out.status.unknown')],
      [t('out.status.col.preset'), config.preset ?? t('out.status.unknown')],
      [t('out.status.col.harness'), detected.length > 0 ? detected.join(', ') : t('out.status.unknown')],
    ];

    // 表面行：默认 harness（名表首项）持有 weave 的完整项目表面，其余 detected
    // harness 只暴露 skills 面（其 init 其余步骤 skip）。目录/文件名由 HARNESS_DIRS
    // + AssetSurface 派生——本文件不写 harness 名或 `.claude/*` 路径字面量，接新
    // harness 无需改动。
    const base: Harness = HARNESS_KEYS[0];
    const baseDir = HARNESS_DIRS[base].projectDir;
    const baseSurface = reg.get(base)?.assets;

    for (const name of HARNESS_INSTRUCTION_FILES[base]) {
      entries.push(await surfaceRow(name, name, targetDir));
    }
    entries.push(await surfaceRow('settings.json', `${baseDir}/settings.json`, targetDir));
    entries.push(await surfaceRow('.mcp.json', '.mcp.json', targetDir));
    entries.push(await surfaceRow('helpers', `${baseDir}/helpers`, targetDir));
    const baseSkills = baseSurface?.projectSkillsRoots()[0] ?? `${baseDir}/skills`;
    entries.push(await surfaceRow(path.posix.basename(baseSkills), baseSkills, targetDir));
    const baseCategories: readonly (readonly [string, FileAssetCategory])[] = [
      ['commands', 'command'],
      ['agents', 'agent'],
    ];
    for (const [label, category] of baseCategories) {
      const rel = projectSurfaceRel(baseSurface, category, targetDir) ?? `${baseDir}/${label}`;
      entries.push(await surfaceRow(path.posix.basename(rel), rel, targetDir));
    }
    for (const h of detected) {
      if (h === base) continue;
      const rel = reg.get(h)?.assets?.projectSkillsRoots()[0] ?? `${HARNESS_DIRS[h].projectDir}/skills`;
      entries.push(await surfaceRow(rel, rel, targetDir));
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
