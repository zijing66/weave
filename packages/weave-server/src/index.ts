/**
 * @weavecode/server — Weave daemon.
 *
 * Data layer, HTTP server, and hook ingestion are implemented across the
 * db/, repositories/, and daemon/ modules. This file re-exports the public
 * surface.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export { openDatabase } from './db/db.js';
export { getDataDir, getDbPath, getDaemonStatePath, getAuthPath, getInitialPasswordPath } from './db/paths.js';

export { ProjectRepository } from './repositories/projects.js';
export type { ProjectRow, RegisterProjectInput } from './repositories/projects.js';

export { HookEventRepository } from './repositories/hook-events.js';
export type { HookEventInput, HookEventRow } from './repositories/hook-events.js';
export { SessionRepository } from './repositories/sessions.js';
export type { SessionRow } from './repositories/sessions.js';

export { LibraryRepository } from './repositories/libraries.js';
export type { LibraryRow } from './repositories/libraries.js';

export { DEFAULT_PORT, DAEMON_HOST, isPortFree, findFreePort } from './daemon/port.js';
export { readDaemonState, writeDaemonState, clearDaemonState } from './daemon/state.js';
export type { DaemonState } from './daemon/state.js';
export { generateToken } from './daemon/auth.js';
export { createWeaveServer, weaveRequestHandler, DAEMON_VERSION } from './daemon/server.js';
export type { WeaveServerDeps } from './daemon/server.js';
export { accessUrls, lanIps, ensureDaemonCert, startTlsServer, daemonCertsDir } from './daemon/tls.js';
export type { AccessUrl, DaemonCert, TlsListener } from './daemon/tls.js';
export {
  readDaemonSettings,
  writeDaemonSettings,
  terminalPresetsFor,
  resolveLocale,
  DEFAULT_DAEMON_SETTINGS,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
} from './daemon/settings.js';
export type { DaemonSettings, TerminalSettings, TerminalPreset, TerminalPresetMeta, Locale } from './daemon/settings.js';
export {
  resolveTerminalLaunch,
  resolveExplorerLaunch,
  openInExplorer,
  openInTerminal,
  runInTerminal,
  defaultProjectOpener,
} from './daemon/opener.js';
export type { ProjectOpener, TerminalLaunch } from './daemon/opener.js';
export { resolveStaticDir } from './daemon/static.js';
export { startDaemon } from './daemon/start.js';
export { registerProject, unregisterProject } from './registry.js';
export type { RegisterResult, UnregisterResult } from './registry.js';

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
// hook 文件化管道：inbox 消费（worker/测试）与注入计划镜像
export { drainInboxOnce, handleIngestedRecords } from './hooks/inbox-worker.js';
export type { InboxRecord, InboxDrainDeps } from './hooks/inbox-worker.js';
export { MirrorWriter, hooksRoot, hookShardId, appendOutbox } from './hooks/mirror.js';
export type { HookMirrorDoc, MirrorRule } from './hooks/mirror.js';

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
export {
  codexConfigFile,
  readCodexMcpServers,
  writeCodexMcpServer,
  removeCodexMcpServer,
  codexMcpExists,
  readCodexMcpFromText,
  upsertCodexMcpInText,
  removeCodexMcpFromText,
  upsertCodexPluginEnabledInText,
  parseDottedKey,
  sectionHeaderKey,
  renderTomlHeader,
  renderTomlKey,
  renderTomlString,
  splitTomlSections,
  upsertTomlSection,
  removeTomlSection,
  parseSectionEntries,
  CodexTomlCorruptError,
} from './install/codex-toml.js';
export type { TomlSection } from './install/codex-toml.js';
export { buildLibraryIndex, findSkillSource, findFileAssetSource } from './install/library-index.js';
export type { SkillSource, LibraryIndex, FileAssetSource } from './install/library-index.js';
export { hashSkillDir, maxMtimeDir, hashMcpConfig, hashFile, FingerprintCache } from './install/fingerprint.js';
export type { FingerprintCacheEntry } from './install/fingerprint.js';
export { projectFileNamespaces, projectPackFiles } from './hooks/toolkit.js';
export {
  detectUpdates,
  detectSkillUpdates,
  detectFileAssetUpdates,
  detectProjectUpdateCounts,
} from './install/updates.js';
export type { SkillUpdate, McpUpdate, FileAssetUpdate, UpdateReport } from './install/updates.js';
export { detectPluginTemplateUpdates } from './install/plugin-templates.js';
export type { PluginTemplateUpdate, PluginTemplateCategory } from './install/plugin-templates.js';
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
export { mcpOverrideOf, resolveMcpEffective, setMcpEnableOverride } from './install/settings-mcp.js';
export { readMcpRows } from './install/mcp-rows.js';
export type { McpToolRow } from './install/mcp-rows.js';
export { readPluginRows } from './install/plugin-rows.js';
export type { PluginToolRow } from './install/plugin-rows.js';
export { installPluginPack } from './install/plugin-install.js';
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
  POWERLINE_DEFAULT_GLYPHS,
  SEGMENT_ORDER,
  LEGACY_IDENTITY_LINE,
  LEGACY_METRICS_LINE,
  NAMED_COLORS,
  SEGMENT_TOKENS,
  SEGMENT_DEFAULT_FORMAT,
  CONTEXT_STYLE_FORMAT,
  PLAIN_STATUSLINE_CONFIG,
} from './statusline/config.js';
export type {
  StatuslineConfig,
  StatuslinePowerline,
  StatuslineSegment,
  StatuslineColor,
  StatuslineNamedColor,
  StatuslineBar,
  SegmentKey,
} from './statusline/config.js';
export { WEAVE_VERSION } from './version.js';
export { generateStatuslineScript, statuslineCacheDir } from './statusline/generator.js';
export { StatuslineCacheSweeper, startStatuslineCacheSweeper } from './statusline/cache-sweeper.js';
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
 * Absolute path of the standalone daemon entry, resolved beside this module:
 * the compiled `entry.js` when running from dist (production), the TS source
 * under the `development` condition. Only the TS form needs tsx to spawn —
 * published bundles carry no tsx.
 */
export function resolveDaemonEntry(): { path: string; isTs: boolean } {
  const js = fileURLToPath(new URL('./daemon/entry.js', import.meta.url));
  if (existsSync(js)) return { path: js, isTs: false };
  const ts = fileURLToPath(new URL('./daemon/entry.ts', import.meta.url));
  return { path: ts, isTs: true };
}

// 插件分发通道（A3）：供 dashboard / REST 层调用（install/uninstall/export/search）。
export {
  installPlugin,
  uninstallPlugin,
  exportPlugin,
  searchPlugins,
  globalPluginRoot,
  isGitSource,
} from './hooks/plugin-installer.js';
export type { InstallResult, PluginIndexEntry } from './hooks/plugin-installer.js';
