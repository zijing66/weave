import type { PromptTerminal } from '../hooks/message-deliverer.js';
import type { AgentInstanceRepository } from '../repositories/agent-instances.js';
import { RuntimeSupervisor } from './supervisor.js';
import { HeadlessTerminal } from './headless-terminal.js';
import type { TerminalGateway } from './terminal/session-gateway.js';

/**
 * 层② 合并通道（B1 收尾）：headless 实例优先（pane id = instanceId，定位走
 * WEAVE_INSTANCE_ID 直连），回落既有外部终端通道。MessageDeliverer 的层序与
 * 层② 语义零改动——两个供给者按 pane id 形自然分流。
 */
export function mergedTerminalChannel(
  external: PromptTerminal,
  repo: AgentInstanceRepository,
  supervisor?: RuntimeSupervisor,
  gateway?: TerminalGateway,
): PromptTerminal {
  const headless = supervisor ? new HeadlessTerminal(supervisor, repo, gateway) : null;
  const viaHeadless = (paneId: string): boolean =>
    headless !== null && !/^(wez:|wt:|konsole:|iterm:)/.test(paneId);
  return {
    available: () => headless?.available() ?? external.available(),
    listPanes: async () => {
      const own = headless ? await headless.listPanes() : [];
      return [...own, ...(await external.listPanes())];
    },
    locatePane: async (env) => {
      const own = headless ? await headless.locatePane(env) : null;
      return own ?? (external.locatePane ? await external.locatePane(env) : null);
    },
    // 会话分块是外部终端世界的语义（headless 实例不占屏幕），原样透传。
    ...(external.locateScreens ? { locateScreens: external.locateScreens.bind(external) } : {}),
    sendText: async (paneId, text) =>
      viaHeadless(paneId) && headless ? headless.sendText(paneId, text) : external.sendText(paneId, text),
    sendKeys: async (paneId, keys) =>
      viaHeadless(paneId) && headless ? headless.sendKeys(paneId, keys) : external.sendKeys(paneId, keys),
    getPaneText: async (paneId) => {
      const own = headless && viaHeadless(paneId) ? await headless.getPaneText(paneId) : null;
      return own ?? external.getPaneText?.(paneId) ?? null;
    },
    closePane: async (paneId) =>
      viaHeadless(paneId) && headless ? headless.closePane(paneId) : external.closePane(paneId),
  };
}
