import type { PromptTerminal } from '../hooks/message-deliverer.js';
import type { SessionTerminal } from '../daemon/opener.js';
import type { AgentInstanceRepository } from '../repositories/agent-instances.js';
import { RuntimeSupervisor } from './supervisor.js';
import { HeadlessTerminal } from './headless-terminal.js';
import type { TerminalGateway } from './terminal/session-gateway.js';

/**
 * 层② 合并通道（B1 收尾）：headless 实例优先（pane id = instanceId，定位走
 * WEAVE_INSTANCE_ID 直连），回落既有外部终端通道。MessageDeliverer 的层序与
 * 层② 语义零改动——两个供给者按 pane id 形自然分流。
 * 会话分块（locateScreens）：外部终端按 pane env 反查；**headless 会话（Web
 * 终端）并入同一份分块账**——同一项目（Runtime Host 同一个 Host 面板）合成
 * `web:<projectId>` 组，会话列表据此把 Web 终端会话也聚进「Web 终端」块。
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
  const webScreens = async (): Promise<Record<string, SessionTerminal | null>> => {
    const out: Record<string, SessionTerminal | null> = {};
    for (const [sessionId, projectId] of repo.liveGroupedSessions()) {
      out[sessionId] = { id: `web:${projectId}`, windowId: 0, tabId: 0, tabsInWindow: 1 };
    }
    return out;
  };
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
    ...(external.locateScreens
      ? {
          locateScreens: async (envs: Record<string, Record<string, string>>) => {
            const [ext, web] = await Promise.all([
              external.locateScreens!(envs),
              webScreens(),
            ]);
            // 外部账原样保留（真定位的分块与显式 null 摘除都是事实）；web 组只
            // 补两处——外部回 null 的（headless 会话也上报过 env、外部屏上没有）
            // 与外部账里缺席的活 headless 会话。外部真分块永远优先。
            const out: Record<string, SessionTerminal | null> = { ...ext };
            for (const [k, v] of Object.entries(web)) {
              if (out[k] === undefined || out[k] === null) out[k] = v;
            }
            return out;
          },
        }
      : { locateScreens: webScreens }),
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
