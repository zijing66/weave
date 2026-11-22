import type { PromptTerminal } from '../hooks/message-deliverer.js';
import type { RuntimeSupervisor } from './supervisor.js';
import type { AgentInstanceRepository } from '../repositories/agent-instances.js';
import type { TerminalGateway } from './terminal/session-gateway.js';

/**
 * headless 实例的层② 终端通道（B1 收尾，agent-runtime-host-design.md §5.2）：
 * 实现 PromptTerminal——pane id = instanceId，sendText/sendKeys 即 Host stdin。
 * 既有层序与能力矩阵零改动（MessageDeliverer 只多一个供给者）。
 *
 * instanceId 形 pane id 不与任何 TerminalBackend 的表示法冲突（wezterm 三段 /
 * wt:pid / konsole:svc|path / iterm:tid），ownsPaneId 判据据此永真。
 */
export class HeadlessTerminal implements PromptTerminal {
  constructor(
    private readonly supervisor: RuntimeSupervisor,
    private readonly repo: AgentInstanceRepository,
    private readonly gateway?: TerminalGateway,
  ) {}

  /** Host 在线 = 通道可用（headless 实例能不能投还要看实例本身活着）。 */
  available(): boolean {
    return this.supervisor.connected;
  }

  /** 活实例清单（标题/工作目录照 DB 行填；无 pane 概念的枚举语义）。 */
  async listPanes(): Promise<Array<{ id: string; title: string | null; cwd: string | null }>> {
    return this.repo
      .listHeadless()
      .filter((row) => row.status === 'running' || row.status === 'starting')
      .map((row) => ({
        id: row.id,
        title: row.harnessSessionId ?? null,
        cwd: row.workingDirectory,
      }));
  }

  /** hook 旁路上报的 env → instance pane：headless 实例注入 WEAVE_INSTANCE_ID。 */
  async locatePane(env: Record<string, string>): Promise<string | null> {
    const id = env.WEAVE_INSTANCE_ID;
    if (!id) return null;
    const row = this.repo.get(id);
    if (!row || row.status === 'exited' || row.status === 'failed') return null;
    return id;
  }

  /** prompt 原文 + 提交键（等同既有 sendText 语义：一次粘贴 + CR）。 */
  async sendText(paneId: string, text: string): Promise<void> {
    await this.supervisor.sendStdin(paneId, text);
    await this.supervisor.sendStdin(paneId, '\r');
  }

  /** 裸键序（中断 ESC / 作答键原子）——不经粘贴语义，原样进 stdin。 */
  async sendKeys(paneId: string, keys: string): Promise<void> {
    await this.supervisor.sendStdin(paneId, keys);
  }

  /**
   * 读屏（中断确认 / 提交探针 / rewind 面板判据用）= Gateway ring 尾部原始输出
   * 剥 ANSI 后的纯文本（外部后端 capture-pane 同口径）。ring 空（daemon 刚重启 /
   * 无输出）→ null——读不到 ≠ 事实，判据侧自会「不动作」，绝不猜。
   * 控制序列里 CR 是换行语义（TUI 整屏重绘流里 LF 只进 scrollback），对齐外部
   * 后端读屏按行给文本的形态。
   */
  async getPaneText(paneId: string): Promise<string | null> {
    const raw = this.gateway?.tailText(paneId);
    if (!raw) return null;
    return stripAnsi(raw).replace(/\r\n?/g, '\n');
  }

  /** 关掉实例（会话收尾）——温和 kill，落库走 daemon 事件泵。 */
  async closePane(paneId: string): Promise<void> {
    await this.supervisor.killInstance(paneId).catch(() => {});
  }
}

/** CSI/OSC/控制序列剥除（读屏判据只吃可见文本；与外部后端 capture-pane 同口径）。 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
