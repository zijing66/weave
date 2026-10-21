import path from 'node:path';
import { detectPlatform } from '@weavecode/core';

/** Absolute path to the global weave data directory (`<configDir>/weave`). */
export function getDataDir(): string {
  return path.join(detectPlatform().configDir, 'weave');
}

/**
 * 数据目录的三档（导出/导入迁移的唯一分档口径，落盘点一律先在这里归档）：
 *
 * - `data/`  实体数据 —— **迁移**整档带走（库、资源市场副本、上传图片、已安装插件内容）
 * - `local/` 本机专属身份 —— **不迁移**（换机器要重设口令、重填 key、重签证书、重开自启）
 * - `cache/` 可弃产物 —— **不迁移**（索引、日志、statusline 缓存、hook 流水、临时安装、daemon 状态）
 */
export interface DataRoots {
  /** 实体数据根；`libraries.path` 的相对基也是它。 */
  data: string;
  /** 本机专属身份根。 */
  local: string;
  /** 可弃缓存与运行期产物根。 */
  cache: string;
}

export function dataRoots(dir: string = getDataDir()): DataRoots {
  return {
    data: path.join(dir, 'data'),
    local: path.join(dir, 'local'),
    cache: path.join(dir, 'cache'),
  };
}

/** 实体数据根 `data/`（市场副本、上传、已装插件、库文件）。 */
export function getDataRoot(dir?: string): string {
  return dataRoots(dir).data;
}

/** Absolute path to the SQLite database file. */
export function getDbPath(dir?: string): string {
  return path.join(dataRoots(dir).data, 'weave.db');
}

/** 已安装插件内容（SPI 扫描根）；随数据迁移。 */
export function getPluginsDir(dir?: string): string {
  return path.join(dataRoots(dir).data, 'plugins');
}

/** 会话图片上传的落盘根（内容寻址 `<sha256>.<ext>`；绝对路径由 harness 引用）。 */
export function getUploadsDir(dir?: string): string {
  return path.join(dataRoots(dir).data, 'uploads');
}

/** Absolute path to the daemon auth file (password hash + secrets, 0600). */
export function getAuthPath(dir?: string): string {
  return path.join(dataRoots(dir).local, 'auth.json');
}

/** Absolute path to the one-shot initial-password marker (0600; 首个 CLI 命令领取后即删). */
export function getInitialPasswordPath(dir?: string): string {
  return path.join(dataRoots(dir).local, 'initial-password');
}

/** Absolute path to the AI assistant key file (`{ apiKey }`, 0600; 密钥不进 settings 表). */
export function getAiKeyPath(dir?: string): string {
  return path.join(dataRoots(dir).local, 'ai.json');
}

/** Absolute path to the Web Push VAPID keypair file (`{ publicKey, privateKey }`, 0600). */
export function getPushKeysPath(dir?: string): string {
  return path.join(dataRoots(dir).local, 'push.json');
}

/**
 * harness 配置快照根（`<local>/harness-config/<harness>/`）：整份配置文件快照里
 * 可能带 API key，属本机专属 → 落 `local/`、不进 settings 表、不随迁移带走。
 */
export function getHarnessConfigDir(dir?: string): string {
  return path.join(dataRoots(dir).local, 'harness-config');
}

/** 自签证书目录（局域网 HTTPS）。 */
export function getCertsDir(dir?: string): string {
  return path.join(dataRoots(dir).local, 'certs');
}

/** 开机自启脚本（win32 的 VBS）。 */
export function getAutoStartScriptPath(dir?: string): string {
  return path.join(dataRoots(dir).local, 'weave-autostart.vbs');
}

/** Absolute path to the daemon state file (`{ pid, port, startedAt }`). */
export function getDaemonStatePath(dir?: string): string {
  return path.join(dataRoots(dir).cache, 'daemon.json');
}

/** 日志根（接口日志 + 每 harness 的事件采集游标）。 */
export function getLogsDir(dir?: string): string {
  return path.join(dataRoots(dir).cache, 'logs');
}

/** 接口日志根（按小时 JSONL：`api-YYYY-MM-DDTHH.jsonl`，见 daemon/api-log.ts）。 */
export function getApiLogsDir(dir?: string): string {
  return path.join(getLogsDir(dir), 'api');
}

/** hook 文件化管道的落点根（inbox / mirror / outbox 分片、旁路凭据、promptbox）。 */
export function getHooksDir(dir?: string): string {
  return path.join(dataRoots(dir).cache, 'hooks');
}

/** statusline 渲染缓存（短命 helper 进程写、daemon 定期回收）。 */
export function getStatuslineDir(dir?: string): string {
  return path.join(dataRoots(dir).cache, 'statusline');
}

/** 安装等一次性操作的临时区。 */
export function getTmpDir(dir?: string): string {
  return path.join(dataRoots(dir).cache, 'tmp');
}

/** 项目文件索引快照（`<projectId>.json`，见 daemon/project-files.ts）。 */
export function getIndexDir(dir?: string): string {
  return path.join(dataRoots(dir).cache, 'index');
}
