import type { PromptTerminal } from '../hooks/message-deliverer.js';
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from '../daemon/opener/shared.js';
import type { RuntimeSupervisor } from './supervisor.js';
import type { AgentInstanceRepository } from '../repositories/agent-instances.js';
import type { TerminalGateway } from './terminal/session-gateway.js';

/** 单枪 stdin 上限（ConPTY 输入缓冲实测安全边界内；1083 字符整包会截头）。 */
export const STDIN_CHUNK_BYTES = 512;
/** 块间让拍：pty 消化输入（ConPTY 环形缓冲翻转窗口）。 */
export const STDIN_CHUNK_GAP_MS = 25;

/** 按 UTF-8 字节切（不劈代理对/多字节序列；与 wezterm 后端 chunkByUtf8Bytes 同语义）。 */
export function chunkByUtf8Bytes(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text];
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let bytes = 0;
    while (end < text.length) {
      const code = text.codePointAt(end)!;
      const width = code > 0xffff ? 4 : code > 0x7f ? (code > 0x7ff ? 3 : 2) : 1;
      if (bytes + width > maxBytes) break;
      bytes += width;
      end += code > 0xffff ? 2 : 1;
    }
    if (end === start) end = start + 1; // 单字符超上限（不可能，防御）
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

  /** prompt 原文 + 提交键（等同既有 sendText 语义：一次粘贴 + CR）。粘贴语义必须
   *  手工包 bracketed paste——外部后端靠终端（wezterm send-text 自带包装），Host
   *  stdin 是裸字节，不包的话宿主把正文当逐字敲入、粘贴处理器不触发（带图路径
   *  不再转 `[Image #N]` + image block，2026-11-22 实测回归）。
   *
   * **大文本分块**（2026-11-25 实测定案）：一次性把 1KB+ 的 paste 写进 node-pty
   * （ConPTY）会截头——bswmanager 1083 字符的正文只剩尾部 251 字节 ×2（两截断点
   * 都在词中：`Resu|lt;`），ConPTY 输入缓冲翻丢前段。与外部 wezterm 后端的
   * 16KB 分块同款：按 UTF-8 字节切块、每块间让一拍（pty 消化输入），paste 标记
   * 各自成枪——宿主看到的仍是一次粘贴。 */
  async sendText(paneId: string, text: string): Promise<void> {
    if (text) {
      await this.supervisor.sendStdin(paneId, BRACKETED_PASTE_START);
      for (const chunk of chunkByUtf8Bytes(text, STDIN_CHUNK_BYTES)) {
        await this.supervisor.sendStdin(paneId, chunk);
        await sleep(STDIN_CHUNK_GAP_MS);
      }
      await this.supervisor.sendStdin(paneId, BRACKETED_PASTE_END);
    }
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
