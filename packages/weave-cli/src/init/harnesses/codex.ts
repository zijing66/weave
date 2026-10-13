import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import {
  type InitComponents,
  type SkillsConfig,
  DEFAULT_SKILLS,
  HARNESS_DIRS,
  ensureDir,
  logger,
  resolveComponents,
  writeFileIfAbsent,
} from '@weavecode/core';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — weave-templates is symlinked via pnpm workspaces
import { templateRegistry } from '@weavecode/templates';
import { InitPipeline, type InitContext } from '@weavecode/harness';
import { type SurfaceRecords } from '../types.js';
import { t } from '../../i18n/index.js';

/**
 * Codex init 模板（批 5 新建）：能力矩阵 ⚠ —— 仅 ensureDirs（`.codex/skills`
 * 按 `HARNESS_DIRS.codex`）与 copySkills 真执行，其余 6 个钩子 `skip(step, 无对等面)`
 * （dim warn 走 CLI i18n dict）。仅当用户显式选择 codex 才会跑
 * （默认 `['claude']` 保证存量零变化）。
 */
export class CodexInitTemplate extends InitPipeline {
  readonly records: SurfaceRecords = {
    created: { directories: [], files: [] },
    skipped: [],
    merged: [],
    updated: [],
    removed: [],
  };
  private readonly force: boolean;
  private readonly components: InitComponents;
  private readonly skills: SkillsConfig;
  private readonly codexDir: string;
  private readonly skillsDir: string;

  constructor(ctx: InitContext) {
    super(ctx);
    const components = resolveComponents(ctx.preset, ctx.components);
    const codexDir = path.join(ctx.targetDir, HARNESS_DIRS.codex.projectDir);
    this.force = ctx.force;
    this.components = components;
    this.skills = { ...DEFAULT_SKILLS, ...ctx.skills };
    this.codexDir = codexDir;
    this.skillsDir = path.join(codexDir, 'skills');
  }

  protected async ensureDirs(): Promise<void> {
    await ensureDir(this.codexDir);
    this.records.created.directories.push(this.codexDir);
    if (this.components.skills) {
      await ensureDir(this.skillsDir);
      this.records.created.directories.push(this.skillsDir);
    }
  }

  protected writeSettings(): void {
    this.skipNoFace('writeSettings');
  }

  protected writeMcp(): void {
    this.skipNoFace('writeMcp');
  }

  protected async copySkills(): Promise<void> {
    if (this.components.skills && this.skills.core) {
      const srcDir = templateRegistry.getSkillsSourceDir();
      await copyTemplateDir(srcDir, this.skillsDir, this.force, this.records);
    }
  }

  protected copyCommands(): void {
    this.skipNoFace('copyCommands');
  }

  protected copyAgents(): void {
    this.skipNoFace('copyAgents');
  }

  protected override injectPluginTemplates(): void {
    this.skipNoFace('injectPluginTemplates');
  }

  protected writeHelpers(): void {
    this.skipNoFace('writeHelpers');
  }

  /** 无对等面跳过：步骤名/原因入 `skipped`/`skipReasons`，并即时 dim 提示。 */
  private skipNoFace(step: string): void {
    const reason = t('init.noPeerFace');
    this.skip(step, reason);
    logger.dim(t('init.stepSkipped', { step, reason }));
  }
}

/**
 * Copy template files into the codex skills surface, recording per-file
 * results（与 claude 模板的同名 helper 行为等价：force 覆写，否则已有文件跳过）。
 */
async function copyTemplateDir(
  srcDir: string,
  destDir: string,
  force: boolean,
  records: SurfaceRecords,
): Promise<void> {
  try {
    for (const srcFile of await walkDir(srcDir)) {
      const rel = path.relative(srcDir, srcFile);
      const destFile = path.join(destDir, rel);
      const content = await readFile(srcFile, 'utf-8');
      const wrote = await writeFileIfAbsent(destFile, content, force);
      if (wrote) records.created.files.push(destFile);
      else records.skipped.push(destFile);
    }
  } catch (err) {
    logger.warn(t('init.copyTemplatesFailed', { srcDir, error: String(err) }));
  }
}

async function walkDir(dir: string): Promise<string[]> {
  const result: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) result.push(...(await walkDir(full)));
      else result.push(full);
    }
  } catch {
    return result;
  }
  return result;
}
