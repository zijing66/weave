/**
 * Daemon API client. All routes are prefixed with /api — in dev the Vite proxy
 * strips /api and forwards to the daemon; in production the daemon strips /api
 * itself and statically hosts the SPA for everything else.
 *
 * 按域拆分：类型与方法各归各的域文件（lib/api/<域>.ts），此处合回单个 `api`
 * 对象并 re-export 全部类型——调用方 `@/lib/api` 单入口不变。
 */

import { projectApi } from './projects';
import { hooksApi } from './hooks';
import { sessionApi } from './sessions';
import { messageApi } from './messages';
import { orchestrationApi } from './orchestration';
import { uploadApi } from './uploads';
import { marketApi } from './market';
import { installApi } from './install';
import { updatesApi } from './updates';
import { statuslineApi } from './statusline-api';
import { configApi } from './config';
import { settingsApi } from './settings';
import { refreshDashboard, eventsUrl } from './client';

export const api = {
  ...projectApi,
  ...hooksApi,
  ...sessionApi,
  ...messageApi,
  ...orchestrationApi,
  ...uploadApi,
  ...marketApi,
  ...installApi,
  ...updatesApi,
  ...statuslineApi,
  ...configApi,
  ...settingsApi,
  refreshDashboard,
  eventsUrl,
};

export { API_BASE } from './client';
export type { AssetAgent, AssetEntry, AssetChangeEvent } from './assets';
export type {
  HookEventRow,
  HookRuleSource,
  HookRuleFilter,
  HandlerConfig,
  HookRule,
  HookPlugin,
  ToolkitPack,
  ToolkitListResult,
  ToolkitToggleResult,
  HookRuleInput,
  HookDispatchStatus,
  HookDispatchMode,
  HookDispatch,
} from './hooks';
export { normalizeHookRuleSource, hookSourceHarness, CLAUDE_HOOK_EVENTS, INJECTABLE_HOOK_EVENTS } from './hooks';
export type {
  SessionRow,
  SessionListResult,
  HarnessCommandRow,
  CommandExecutionRow,
  SessionPlan,
  SessionEditHunk,
  SessionEdits,
  SessionFileEntry,
  RecognizedRef,
  SessionFileListing,
  SideQuestionRow,
} from './sessions';
export type {
  SessionMessageRow,
  MessagingCapability,
  WatchOn,
  SessionWatchRow,
  PendingQuestionOption,
  PendingQuestion,
  AnswerPick,
  PendingQuestionEntry,
} from './messages';
export type {
  OrchestrationEdge,
  OrchestrationNodeKind,
  OrchestrationNode,
  OrchestrationTrigger,
  OrchestrationRunStatus,
  OrchestrationRow,
  OrchestrationRunEvent,
  OrchestrationRunState,
  OrchestrationRunRow,
  OrchestrationInput,
} from './orchestration';
export type { UploadFile, SessionUploadsResult, UploadsOverview } from './uploads';
export type {
  LibraryRow,
  MarketUpdateStatus,
  MarketUpdateCheck,
  MarketItem,
  BrowseRoot,
  BrowseChild,
  SkillAsset,
  McpTemplate,
  FileAssetTemplate,
  MarketPluginAsset,
} from './market';
export type {
  FileAssetCategory,
  InstallBody,
  AssetScope,
  InstallCategory,
  CategoryCapability,
  StatuslineCapability,
  InstallCapabilities,
  McpStdioConfig,
  McpHttpConfig,
  McpServerConfig,
  McpRow,
  ProjectFile,
} from './install';
export { FILE_ASSET_CATEGORIES } from './install';
export type {
  SkillUpdate,
  FileAssetUpdate,
  McpUpdate,
  PluginTemplateUpdate,
  InitFileUpdate,
  UpdateReport,
  ProjectUpdateSummary,
  GlobalSkillSource,
  GlobalSkillEntry,
  GlobalSkillGroup,
  PluginRow,
  PluginRuntime,
} from './updates';
export { skillSourceRuntime } from './updates';
export type {
  StatuslineNamedColor,
  StatuslineColor,
  SegmentKey,
  StatuslineSegment,
  StatuslineBar,
  StatuslineAlign,
  StatuslineSource,
  StatuslineConfig,
} from './statusline';
export { NAMED_COLORS, WEAVE_VERSION, SEGMENT_TOKENS, SEGMENT_DEFAULT_FORMAT, CONTEXT_STYLE_FORMAT } from './statusline';
export type {
  ConfigFileId,
  ConfigKeySpec,
  ConfigFieldSpec,
  ConfigEnvVarSpec,
  ConfigCatalogResponse,
  ConfigProfileMeta,
  ConfigView,
  ConfigUpdate,
  ConfigModelOption,
  ConfigModelsResponse,
  ConfigPreviewResponse,
} from './config';
export type {
  ProjectConfig,
  TerminalPreset,
  TerminalSettings,
  Locale,
  DaemonSettings,
  HtmlExportProfile,
  HtmlExportSettings,
  TerminalPresetMeta,
  AccessUrl,
  DaemonSettingsBundle,
  CaptureRow,
} from './settings';
export type { ProjectHarness, ProjectRow, TerminalTarget, TerminalPane, SessionTerminal, HarnessCheck, ProjectStorage, ProjectStorageResult } from './projects';
