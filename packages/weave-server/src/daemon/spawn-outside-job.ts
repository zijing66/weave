import { spawn } from 'node:child_process';

/**
 * Windows 上把进程交给 Job 外面的创建者（WMI）拉起，成功返回 true。
 *
 * 直接 `spawn` 的进程会继承调用方所在终端 tab 的 Job（Windows Terminal 给每个
 * pane 建的是 kill-on-close 的 Job），而 libuv 的 detached 并不能真的逃离不允许
 * breakaway 的 Job：关掉那个 tab、tsx watch 热重启杀树都会把它带走。WMI 由
 * WmiPrvSE 创建进程，创建者本身在 Job 外，继承链由此断开。
 *
 * Runtime Host 依赖这条通道活过 daemon 重启（agent-runtime-host-design.md §1）；
 * CLI 的 daemon start 同源（自 daemon.ts 提炼，唯一实现）。
 */
export async function spawnOutsideJob(exe: string, args: string[]): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
  // ShowWindow=0（SW_HIDE）：Win32_Process.Create 出来的控制台程序默认**新建
  // 可见窗口**——startup 里压掉它（[wmiclass] 强类型才能过 Invoke-CimMethod 的
  // 类型推断）。
  const script =
    "$ErrorActionPreference='Stop';" +
    "$su=[wmiclass]'Win32_ProcessStartup';" +
    '$psi=$su.CreateInstance();' +
    '$psi.ShowWindow=0;' +
    "$proc=[wmiclass]'Win32_Process';" +
    '$r=$proc.Create(' +
    `${literal([exe, ...args].map(quote).join(' '))},` +
    `${literal(process.cwd())},` +
    '$psi);' +
    'if($r.ReturnValue -ne 0){exit 1}';
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: 'ignore',
    });
    ps.on('error', () => resolve(false));
    ps.on('exit', (code) => resolve(code === 0));
  });
}
