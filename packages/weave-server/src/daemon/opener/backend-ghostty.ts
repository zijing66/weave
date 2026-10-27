import { captureCommand } from './wezterm-mux.js';
import { PRESET_CANDIDATES, TerminalBackend, type LaunchOrigin, type TerminalLaunch } from './backend.js';

/**
 * ghostty：Linux 上先走 `+new-window` IPC（窗口开进已运行实例，1.2.0+；GTK
 * 实现，见源码 src/apprt/gtk/ipc）——IPC 是短命 CLI、按退出码判成败，不能进
 * 候选表（trySpawn 只看进程起了没，会假成功），故覆写 open/run。无实例/未配
 * D-Bus 激活时非零退出 → 兜底独立进程候选。`-e` 后的 argv 原样直达（中间无
 * shell），与 send-text 路径不同、无需引号。反查无通道（无 list 类命令），
 * 不谎报。
 */
export class GhosttyBackend extends TerminalBackend {
  constructor(platform: NodeJS.Platform) {
    super('ghostty', false, platform);
  }

  candidates(dir: string, run?: string[]): TerminalLaunch[] {
    return PRESET_CANDIDATES.ghostty(dir, run, this.platform);
  }

  private async openViaIpcThenStandalone(dir: string, argv: string[]): Promise<void> {
    if (this.platform === 'linux') {
      const args = [
        '+new-window',
        `--working-directory=${dir}`,
        ...(argv.length > 0 ? ['-e', ...argv] : []),
      ];
      const r = await captureCommand('ghostty', args);
      if (r?.ok) return;
    }
    await this.spawnFirst(
      this.candidates(dir, argv.length > 0 ? argv : undefined),
      `Terminal preset "${this.preset}" is unavailable on this platform`,
    );
  }

  override open(dir: string): Promise<void> {
    return this.openViaIpcThenStandalone(dir, []);
  }

  override async run(dir: string, argv: string[]): Promise<LaunchOrigin | null> {
    await this.openViaIpcThenStandalone(dir, argv);
    return null;
  }
}
