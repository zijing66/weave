import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PORT,
  getDbPath,
  openDatabase,
  ProjectRepository,
  readDaemonState,
} from '@weavecode/server';
import { formatTable, logger } from '@weavecode/core';
import { checkHarness } from '../init/harness-checks.js';
import { probeDaemon } from './daemon.js';
import { t } from '../i18n/index.js';
import type { Command } from '../parser.js';

/** 本机注册表命中项（路径按平台口径归一后比较）。 */
interface RegistryHit {
  id: number;
  source: 'init' | 'scan';
  archived: boolean;
  token: string;
}

const normalizePath = (p: string): string => {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/**
 * 在 daemon 的 SQLite 注册表里按路径找这条项目。DB 文件不存在 = 从未注册过项目，
 * 直接判未注册——不 openDatabase，免得一个只读检查凭空建库。
 */
function lookupRegistered(dir: string): RegistryHit | null {
  if (!existsSync(getDbPath())) return null;
  const db = openDatabase();
  try {
    const projects = new ProjectRepository(db);
    const target = normalizePath(dir);
    const row = [...projects.list(), ...projects.listArchived()].find(
      (r) => normalizePath(r.path) === target,
    );
    return row
      ? { id: row.id, source: row.source, archived: row.archivedAt !== null, token: row.token }
      : null;
  } finally {
    db.close();
  }
}

/** `<project>/.weave/token` 的内容；缺席返回 null。 */
function readLocalToken(dir: string): string | null {
  const file = path.join(dir, '.weave', 'token');
  return existsSync(file) ? readFileSync(file, 'utf-8').trim() : null;
}

/**
 * `weave doctor` — 诊断本机与 weave server 的接线。
 *
 * `weave status` 只看项目目录里的文件；本命令补上它看不见的一侧：这条检出是否
 * 已在 daemon 注册表中（典型故障 = 仓库重拉取后带着 weave 文件却从没在本机 init）。
 */
export const doctorCommand: Command = {
  name: 'doctor',
  description: 'cmd.doctor.desc',
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
    const dir = path.resolve(String(ctx.flags.dir ?? process.cwd()));
    const initialized = existsSync(path.join(dir, '.weave', 'config.yaml'));

    const state = readDaemonState();
    const port = state?.port ?? DEFAULT_PORT;
    const running = await probeDaemon(port);

    const hit = lookupRegistered(dir);
    const token = readLocalToken(dir);

    let tokenState: string;
    if (token === null) tokenState = t('out.doctor.tokenMissing');
    else if (!hit) tokenState = t('out.doctor.tokenUnregistered');
    else if (token === hit.token) tokenState = t('out.doctor.tokenOk');
    else tokenState = t('out.doctor.tokenStale');

    logger.info(t('out.doctor.header'));
    console.log(
      formatTable([
        [t('out.doctor.dir'), dir],
        [t('out.doctor.initialized'), initialized ? t('out.doctor.yes') : t('out.doctor.no')],
        [
          t('out.doctor.daemon'),
          running ? t('out.doctor.daemonRunning', { port }) : t('out.doctor.daemonStopped'),
        ],
        [
          t('out.doctor.registered'),
          hit
            ? t(hit.archived ? 'out.doctor.registeredArchived' : 'out.doctor.registeredYes', {
                id: hit.id,
                source: hit.source,
              })
            : t('out.doctor.registeredNo'),
        ],
        [t('out.doctor.token'), tokenState],
      ]),
    );
    console.log();

    const issues = await checkHarness(dir);
    if (issues.length > 0) {
      logger.warn(t('out.status.issuesFound', { count: issues.length }));
      for (const issue of issues) {
        logger.warn(t('out.status.issue', { message: issue.message }));
        logger.dim(t('out.status.fix', { fix: issue.fix }));
      }
      console.log();
    }

    if (!hit) {
      logger.warn(t('out.doctor.warnNotRegistered'));
      logger.dim(t('out.doctor.fixInit'));
      if (!initialized) logger.dim(t('out.doctor.fixScan', { dir }));
      return;
    }
    if (hit.archived) {
      logger.warn(t('out.doctor.warnArchived'));
      return;
    }
    if (token === null) {
      logger.warn(t('out.doctor.warnTokenMissing'));
      logger.dim(t('out.doctor.fixInit'));
      return;
    }
    if (token !== hit.token) {
      logger.warn(t('out.doctor.warnTokenStale'));
      logger.dim(t('out.doctor.fixInit'));
      return;
    }

    logger.success(t('out.doctor.ok'));
    if (!running) logger.dim(t('out.doctor.fixDaemon'));
  },
};
