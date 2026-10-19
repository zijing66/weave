import type { HarnessDriver } from '../driver.js';
import { CLAUDE_ASSETS } from './assets.js';
import { CLAUDE_CAPTURE } from './capture.js';
import { CLAUDE_EVENT_SOURCE } from './event-source.js';
import { CLAUDE_MESSAGING } from './messaging.js';
import { CLAUDE_PLUGINS } from './plugins.js';
import { CLAUDE_PLUGIN_STATE } from './plugin-state.js';
import { CLAUDE_BLOCKING_PROMPT as CLAUDE_QUESTIONS } from './questions.js';
import { CLAUDE_RESUME } from './resume.js';
import { CLAUDE_DETECTOR } from './detect.js';

export { ClaudeEventSource, CLAUDE_EVENT_SOURCE, frameFacts, expandPayloadRefs } from './event-source.js';
export type { ClaudeFrameFacts, FramePayloadLike } from './event-source.js';
export { CLAUDE_PLUGINS, createClaudePluginSurface, WEAVE_MARKETPLACE } from './plugins.js';
export type { PluginExecutor, PluginExecResult } from './plugins.js';
export { CLAUDE_PLUGIN_STATE } from './plugin-state.js';
export { CLAUDE_RESUME } from './resume.js';
export { CLAUDE_DETECTOR } from './detect.js';
export { CLAUDE_MESSAGING } from './messaging.js';
export { CLAUDE_BLOCKING_PROMPT } from './questions.js';
export { CLAUDE_PROMPT_RELAY } from './prompt.js';
export { CLAUDE_PROMPT_INBOX } from './prompt-inbox.js';
export { CLAUDE_SIDE_QUESTION } from './side-question.js';
export { interruptMarkerAt, currentModelAt, currentModeAt } from './transcript.js';
export { modelAliasTargets, aliasOfModel, startedModelOf, switchedModelOf, type ModelAliasTarget } from './model-aliases.js';
export { resolveClaudePeer } from './peers.js';
export {
  CLAUDE_CAPTURE,
  generateHookHandler,
  captureHookGroup,
  sweepWeaveHookEvents,
  groupIsWeave,
  captureGroupsPresent,
  readUserCapture,
  installUserCapture,
  uninstallUserCapture,
  stripProjectCapture,
  HOOK_HANDLER_MARKER,
} from './capture.js';
export {
  generateSettingsJson,
  mergeSettingsJson,
  stripWeaveSettings,
  type SettingsGeneratorInput,
} from './settings-gen.js';
export { generateMcpJson, mergeMcpJson, stripWeaveMcp, type McpGeneratorInput } from './mcp-gen.js';
export { generateAutoMemoryHook } from './helpers-gen.js';

/**
 * Claude 接入模块的驱动：批 4a 补 assets、批 4b 补 events/resume、批 5 补
 * detect、批 3 补 plugins、P2 补 pluginState、session-orchestration 批 1 补
 * messaging、阻塞式问答补 questions、tool-object-model §6-2 补 capture——
 * init 槽不在此（init 实现半球留 cli，由 init/wiring 携带）。
 */
export const CLAUDE_DRIVER: HarnessDriver = {
  id: 'claude',
  displayName: 'Claude Code',
  capabilities: [
    'assets',
    'events',
    'resume',
    'detect',
    'plugins',
    'pluginState',
    'messaging',
    'questions',
    'capture',
  ],
  assets: CLAUDE_ASSETS,
  events: CLAUDE_EVENT_SOURCE,
  resume: CLAUDE_RESUME,
  detect: CLAUDE_DETECTOR,
  plugins: CLAUDE_PLUGINS,
  pluginState: CLAUDE_PLUGIN_STATE,
  messaging: CLAUDE_MESSAGING,
  questions: CLAUDE_QUESTIONS,
  capture: CLAUDE_CAPTURE,
};
