import { spawn } from 'node:child_process';
import {
  HARNESS_DRIVERS,
  HARNESS_INSTALL,
  ensureClaudeTrustAccepted,
  ensureCodexTrustAccepted,
} from '@weavecode/harness';
import { probeBinVersion } from '@weavecode/server';
import { logger, type Harness } from '@weavecode/core';
import type { PromptPort } from './prompt.js';
import { t } from '../i18n/index.js';

/**
 * init 的环境备置步骤（executor Step 1 之后）：安装检测（未装经一次确认代跑
 * 官方安装命令）、多形态冲突检查（provision 槽：codex 桌面端/CLI 版本漂移）与
 * 文件夹信任预写（替用户答掉宿主首开的「是否信任该文件夹」）。各步都不阻断
 * init——失败降级为 warn，文件面照常生成。
 */

/** 探测/安装动作的注入口（测试桩；缺省真跑子进程）。 */
export interface ProvisionIo {
  versionOf(bin: string): Promise<string | null>;
  runInstall(command: string): Promise<void>;
}

const defaultIo: ProvisionIo = {
  versionOf: (bin) => probeBinVersion(bin),
  runInstall: (command) =>
    new Promise<void>((resolve, reject) => {
      // shell:true 解析 npm 的 .cmd shim（win32）；stdio 继承让用户看见 npm 进度
      const child = spawn(command, { shell: true, stdio: 'inherit', windowsHide: true });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    }),
};

/**
 * 逐 harness 检测安装状态：已装报版本（低于 `resume.minVersion` 只提示升级、
 * 不自动升）；未装经 `prompt.confirm` 一次确认后代跑安装命令并复验。非交互
 * （confirm 静默 true 的语义不适用于安装这种重操作）——`canPrompt` 为假时
 * 只提示命令、不提问也不安装。
 *
 * 已装的再过一遍 provision 槽（多形态冲突检查）：codex 桌面端与 CLI 共享
 * `~/.codex`，daemon 版本漂移会让旧一方用旧快照回写 config.toml——冲突与
 * 官方修法命令如实提示，weave 不代跑（会重启 daemon、中断在跑的任务）。
 */
export async function ensureHarnessInstalled(
  selected: readonly Harness[],
  prompt: PromptPort,
  io: ProvisionIo = defaultIo,
): Promise<void> {
  const canPrompt = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  for (const h of selected) {
    const spec = HARNESS_DRIVERS[h].resume;
    if (!spec?.bin) continue;
    const command = HARNESS_INSTALL[h].command;
    const version = await io.versionOf(spec.bin);
    if (version !== null) {
      const min = spec.minVersion;
      if (min && !atLeast(version, min)) {
        logger.warn(t('init.install.versionLow', { harness: h, version, min, command }));
      } else {
        logger.dim(t('init.install.installed', { harness: h, version }));
      }
      await warnProvisionConflicts(h, spec.bin);
      continue;
    }
    logger.info(t('init.install.notFound', { harness: h }));
    if (!canPrompt) {
      logger.warn(t('init.install.declined', { command }));
      continue;
    }
    const npm = await io.versionOf('npm');
    if (npm === null) {
      logger.warn(t('init.install.npmMissing', { command }));
      continue;
    }
    if (!(await prompt.confirm(t('init.install.confirm', { harness: h }), t('init.install.detail', { command })))) {
      logger.warn(t('init.install.declined', { command }));
      continue;
    }
    logger.dim(t('init.install.running', { harness: h }));
    try {
      await io.runInstall(command);
    } catch (err) {
      logger.warn(t('init.install.verifyFailed', { harness: h, command }));
      continue;
    }
    const after = await io.versionOf(spec.bin);
    if (after !== null) logger.success(t('init.install.done', { harness: h, version: after }));
    else logger.warn(t('init.install.verifyFailed', { harness: h, command }));
  }
}

/** provision 槽的冲突提示（槽缺席 = 该 harness 单形态无冲突；检查失败只 warn 不阻断）。 */
async function warnProvisionConflicts(h: Harness, bin: string): Promise<void> {
  const provision = HARNESS_DRIVERS[h].provision;
  if (!provision) return;
  try {
    const check = await provision.check(bin);
    for (let i = 0; i < check.warnings.length; i++) {
      const hint = check.hints[i];
      logger.warn(t('init.provision.conflict', { harness: h, warning: check.warnings[i], hint: hint ?? '' }));
    }
  } catch (err) {
    logger.warn(t('init.provision.checkFailed', { harness: h, error: (err as Error).message }));
  }
}

/** init 时预写所选 harness 的文件夹信任（幂等；失败只 warn，不阻断 init）。 */
const TRUST_PREWRITE: Partial<Record<Harness, (projectPath: string) => Promise<void>>> = {
  claude: ensureClaudeTrustAccepted,
  codex: ensureCodexTrustAccepted,
};

export async function prewriteTrust(
  selected: readonly Harness[],
  targetDir: string,
): Promise<void> {
  for (const h of selected) {
    const ensure = TRUST_PREWRITE[h];
    if (!ensure) continue;
    try {
      await ensure(targetDir);
      logger.dim(t('init.trust.prewritten', { harness: h }));
    } catch (err) {
      logger.warn(t('init.trust.failed', { harness: h, error: (err as Error).message }));
    }
  }
}

function atLeast(version: string, min: string): boolean {
  const v = version.split('.').map((n) => Number.parseInt(n, 10));
  const m = min.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const dv = (v[i] ?? 0) - (m[i] ?? 0);
    if (dv !== 0) return dv > 0;
  }
  return true;
}
