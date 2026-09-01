/**
 * @weave/server — Weave daemon.
 *
 * Data layer, HTTP server, and hook ingestion are implemented across the
 * db/, repositories/, and daemon/ modules. This file re-exports the public
 * surface.
 */

export { openDatabase } from './db/db.js';
export { getDataDir, getDbPath, getDaemonStatePath } from './db/paths.js';

export { ProjectRepository } from './repositories/projects.js';
export type { ProjectRow, RegisterProjectInput } from './repositories/projects.js';

export { HookEventRepository } from './repositories/hook-events.js';
export type { HookEventInput, HookEventRow } from './repositories/hook-events.js';

export { LibraryRepository } from './repositories/libraries.js';
export type { LibraryRow } from './repositories/libraries.js';

export { DEFAULT_PORT, DAEMON_HOST, isPortFree, findFreePort } from './daemon/port.js';
export { readDaemonState, writeDaemonState, clearDaemonState } from './daemon/state.js';
export type { DaemonState } from './daemon/state.js';
export { generateToken, extractBearerToken } from './daemon/auth.js';
export { createWeaveServer, DAEMON_VERSION } from './daemon/server.js';
export type { WeaveServerDeps } from './daemon/server.js';
export { resolveStaticDir } from './daemon/static.js';
export { startDaemon } from './daemon/start.js';
export { registerProject } from './registry.js';
export type { RegisterResult } from './registry.js';

// --- watch service (filesystem observation, in-memory cache only) ---
export { classifyAsset, normalizeRelPath } from './watch/classifier.js';
export { WatchCache } from './watch/cache.js';
export { WatchService } from './watch/watch-service.js';
export type { WatchServiceOptions } from './watch/watch-service.js';
export { SyncScheduler } from './watch/sync-scheduler.js';
export type { SyncSchedulerOptions } from './watch/sync-scheduler.js';
export type { AssetCategory, AssetEntry, AssetChangeKind, AssetChangeEvent } from './watch/types.js';

// --- hooks ingestion (agent hook normalization + persistence) ---
export { ClaudeCodeAdapter } from './hooks/adapter.js';
export type { HookAdapter } from './hooks/adapter.js';
export type { HookReport, NormalizedHookPayload } from './hooks/types.js';

// --- install / uninstall (asset lifecycle on the filesystem) ---
export { scanLibrarySkills, scanLibraryMcp, scanLibraryFileAssets } from './install/scanner.js';
export type { SkillAsset, McpTemplate, FileAssetTemplate } from './install/scanner.js';
export {
  FILE_ASSET_SPECS,
  FILE_ASSET_CATEGORIES,
  fileAssetTargetDir,
  isFileAssetCategory,
} from './install/file-assets.js';
export type { FileAssetCategory, FileAssetSpec } from './install/file-assets.js';
export {
  installSkill,
  uninstallSkill,
  installFileAsset,
  uninstallFileAsset,
  installMcp,
  uninstallMcp,
  InstallConflictError,
  AssetNotFoundError,
} from './install/installer.js';
export type { McpServerConfig } from './install/installer.js';
export { readMcpServers, readMcpJson } from './install/installer.js';
export { buildLibraryIndex, findSkillSource, findFileAssetSource } from './install/library-index.js';
export type { SkillSource, LibraryIndex, FileAssetSource } from './install/library-index.js';
export { hashSkillDir, maxMtimeDir, hashMcpConfig, hashFile, FingerprintCache } from './install/fingerprint.js';
export type { FingerprintCacheEntry } from './install/fingerprint.js';
export { detectUpdates, detectSkillUpdates, detectFileAssetUpdates } from './install/updates.js';
export type { SkillUpdate, McpUpdate, FileAssetUpdate, UpdateReport } from './install/updates.js';
export {
  readProjectFile,
  resolveProjectFile,
  PathEscapeError,
  FileTooLargeError,
} from './install/reader.js';
export type { ProjectFile } from './install/reader.js';
export {
  readGlobalClaudeJson,
  readGlobalMcpServers,
  writeGlobalMcpServer,
  removeGlobalMcpServer,
  readGlobalSkills,
  installGlobalSkill,
  uninstallGlobalSkill,
  ClaudeJsonCorruptError,
  globalPersonalSkillRoots,
  resolveGlobalSkillDir,
  listGlobalSkillFiles,
  readGlobalSkillFile,
} from './install/global-config.js';
export type {
  GlobalSkillSource,
  GlobalSkillEntry,
  GlobalSkillGroup,
} from './install/global-config.js';
export { readMcpEnableMap, setMcpEnableState } from './install/settings-mcp.js';
export type { McpEnableState, McpEnableMap } from './install/settings-mcp.js';
export {
  readProjectConfig,
  writeProjectConfig,
  markSynced,
  DEFAULT_PROJECT_CONFIG,
} from './install/project-config.js';
export type { ProjectConfig } from './install/project-config.js';
export { applyUpdate, syncAll, refreshStatusline } from './install/apply-update.js';
export type { ApplyUpdateInput } from './install/apply-update.js';

// --- statusline management (ccstatusline-style config + script generation) ---
export {
  DEFAULT_STATUSLINE_CONFIG,
  SEGMENT_ORDER,
  LEGACY_IDENTITY_LINE,
  LEGACY_METRICS_LINE,
} from './statusline/config.js';
export type {
  StatuslineConfig,
  StatuslineSegment,
  StatuslineColor,
  SegmentKey,
} from './statusline/config.js';
export { generateStatuslineScript } from './statusline/generator.js';
export {
  readStatuslineConfig,
  writeStatuslineConfig,
  readGlobalStatuslineConfig,
  writeGlobalStatuslineConfig,
  applyStatuslineConfig,
  ensureSettingsStatusLine,
  readStatuslineScript,
} from './statusline/manager.js';

/**
 * File URL of the standalone daemon entry. Resolves to the TS source under the
 * `development` condition and to the compiled JS in production, so the CLI can
 * spawn the correct entry either way.
 */
export const daemonEntryUrl = new URL('./daemon/entry.ts', import.meta.url).href;
