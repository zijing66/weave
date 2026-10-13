import { logger } from '@weavecode/core';
import { executeUninstall, type UninstallServerResult } from '../init/uninstall.js';
import { t } from '../i18n/index.js';
import type { Command } from '../parser.js';

/** server 注销回执：removed → 成功行（带清理计数），failed → 警告，absent 静默。 */
function reportServerResult(server: UninstallServerResult): void {
  if (server.outcome === 'removed') {
    logger.dim(
      t('out.uninstall.serverRemoved', {
        name: server.name ?? '',
        events: server.purged?.events ?? 0,
        dispatches: server.purged?.dispatches ?? 0,
        sessions: server.purged?.sessions ?? 0,
      }),
    );
  } else if (server.outcome === 'failed') {
    logger.warn(t('out.uninstall.serverFailed', { error: server.error ?? '' }));
  }
}

export const uninstallCommand: Command = {
  name: 'uninstall',
  description: 'cmd.uninstall.desc',
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
    logger.info(t('out.uninstall.banner', { target: targetDir }));

    const result = await executeUninstall({ targetDir });
    if (result.status === 'not-initialized') {
      logger.warn(t('out.uninstall.notInitialized'));
      reportServerResult(result.server);
      return;
    }

    logger.success(
      t('out.uninstall.done', {
        files: result.removedFiles.length,
        dirs: result.removedDirs.length,
      }),
    );
    if (result.modifiedFiles.length > 0) {
      logger.dim(t('out.uninstall.modified', { count: result.modifiedFiles.length }));
    }
    if (result.keptUserFiles.length > 0) {
      logger.dim(t('out.uninstall.keptUser', { count: result.keptUserFiles.length }));
      for (const file of result.keptUserFiles) logger.dim(`    ${file}`);
    }
    if (result.restoredFromBackup) {
      logger.dim(t('out.uninstall.restored', { path: result.restoredFromBackup }));
    }
    reportServerResult(result.server);

    switch (result.git) {
      case 'reset':
        logger.dim(t('out.uninstall.gitReset', { sha: result.gitSha ?? '' }));
        break;
      case 'committed':
        logger.dim(
          t('out.uninstall.gitCommit', {
            sha: result.gitSha ?? '',
            count: result.removedFiles.length + result.modifiedFiles.length,
          }),
        );
        break;
      case 'no-changes':
        logger.dim(t('out.uninstall.gitNoChanges'));
        break;
      case 'skipped-dirty-index':
        logger.warn(t('out.uninstall.gitDirty'));
        break;
      case 'skipped-not-repo':
        logger.dim(t('out.uninstall.gitNotRepo'));
        break;
      case 'failed':
        logger.warn(t('out.uninstall.gitFailed', { error: result.gitError ?? '' }));
        break;
    }
  },
};
