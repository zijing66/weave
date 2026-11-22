import { execFile } from 'node:child_process';

/**
 * WSL2 tmux adapter（B2）：持久终端后端 = tmux session（命名 `weave-agent-<短码>`）。
 * 与 ConPTY（B1）的关键差异：tmux 的 capture-pane 是**重绘等价序列**（保 ANSI 色，
 * 丢 OSC/原始字节），重放语义 = 快照重建而非增量字节流——Gateway 侧按
 * `runtime/protocol.ts` 的 TerminalOutputEvent 统一序列号即可（快照一次一号）。
 * tmux 由 WSL 发行版内提供（本机 Ubuntu-26.04 / tmux 3.6 实测）。
 */

/** 会话名：短码 = instanceId 的安全子集（tmux 名不许 `.` `:`）。 */
export function tmuxSessionName(instanceId: string): string {
  const short = instanceId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-16);
  return `weave-agent-${short || 'x'}`;
}

function tmux(args: string[], timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'wsl.exe',
      ['-e', 'tmux', ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`tmux ${args.join(' ')}: ${stderr || err.message}`));
        else resolve(stdout);
      },
    );
  });
}

export interface TmuxSpawnOptions {
  instanceId: string;
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** 建 detached 会话并送入命令；成功返回 pane id（`%N`）。 */
export async function tmuxSpawn(opts: TmuxSpawnOptions): Promise<{ paneId: string }> {
  const session = tmuxSessionName(opts.instanceId);
  await tmux([
    'new-session',
    '-d',
    '-s',
    session,
    '-c',
    opts.cwd,
    // 起一个挂着 shell 的会话，命令下一步 send-keys 送入（new-session 直接带
    // 命令时 env 注入不便，且命令退出即杀会话——实例语义要的是活会话）
    'sh',
  ]);
  const envPrefix = Object.entries(opts.env)
    .filter(([k]) => !['PWD', 'SHLVL', '_'].includes(k))
    .map(([k, v]) => `${k}=${v.replace(/'/g, "'\\''")}`)
    .join(' ');
  const cmdline = `${envPrefix} '${opts.command.replace(/'/g, "'\\''")}' ${opts.args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`;
  await tmux(['send-keys', '-t', session, '-l', cmdline]);
  await tmux(['send-keys', '-t', session, 'Enter']);
  const pane = await tmux(['display-message', '-t', session, '-p', '#{pane_id}']);
  return { paneId: pane.trim() };
}

/** 键序/文本注入（-l 字面量；CR 由调用方给 `\r`）。 */
export async function tmuxSendKeys(session: string, keys: string): Promise<void> {
  await tmux(['send-keys', '-t', session, '-l', keys]);
}

/** 裸键（Enter/ESC 等 tmux 键名，不走 -l）。 */
export async function tmuxSendKey(session: string, key: string): Promise<void> {
  await tmux(['send-keys', '-t', session, key]);
}

/** 保 ANSI 的可视屏快照（重放/读屏判据两用）。 */
export async function tmuxCapture(session: string): Promise<string> {
  return tmux(['capture-pane', '-t', session, '-p', '-e']);
}

export async function tmuxResize(session: string, cols: number, rows: number): Promise<void> {
  await tmux(['resize-window', '-t', session, '-x', String(cols), '-y', String(rows)]);
}

export async function tmuxKill(session: string): Promise<void> {
  await tmux(['kill-session', '-t', session]).catch(() => {}); // 已死 = 目标态
}

/** 会话清单（`name paneId pid` 行）——对账用。 */
export async function tmuxListWeaveSessions(): Promise<Array<{ session: string; paneId: string; pid: number }>> {
  const out = await tmux(['list-sessions', '-F', '#{session_name} #{pane_id} #{pane_pid}'], 3_000).catch(() => '');
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('weave-agent-'))
    .map((l) => {
      const [session, paneId, pid] = l.split(/\s+/);
      return { session: session!, paneId: paneId!, pid: Number(pid) };
    });
}
