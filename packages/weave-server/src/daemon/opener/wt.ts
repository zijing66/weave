import { createHash } from 'node:crypto';
import { TERMINAL_LOCATOR_ENV } from '@weavecode/core';
import { captureCommand, normalizeDirKey, type WeztermMuxPane } from './wezterm-mux.js';

// ---- Windows Terminal 通道（win32）：进程树反查 + 命名窗口落子 ----
//
// wt 无官方枚举 API，但进程树即真相：每个 pane 的 shell 是
// WindowsTerminal.exe 的直接子进程（OpenConsole.exe 是 ConPTY 宿主、兄弟
// 进程），shell 的 PEB cwd（ReadProcessMemory 走读）就是 pane 实时工作目录。
// 一枪 PowerShell 拉全进程表（实测 ~3.4s，含 Add-Type 编译），Node 侧建树。

/** 一次 PowerShell 拉全进程表：pid|ppid|name|created|cwd（`|` 是 Windows
 * 路径非法字符，可放心当分隔符；cwd 读不到 = 空列）。行内 C# 走 PEB：
 * ProcessParameters+0x38 的 CurrentDirectory（UNICODE_STRING）。 */
const WT_PROC_DUMP = [
  '$ErrorActionPreference = \'SilentlyContinue\'',
  "$src = @'",
  'using System; using System.Runtime.InteropServices;',
  'public class WeaveWtCwd {',
  '  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI pbi, int size, out int rl);',
  '  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int a, bool inh, int pid);',
  '  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);',
  '  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);',
  '  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr r1; public IntPtr Peb; public IntPtr r2; public IntPtr r3; public IntPtr Pid; public IntPtr r4; }',
  '  static IntPtr ReadPtr(IntPtr h, IntPtr addr) { var b = new byte[8]; IntPtr r; if (!ReadProcessMemory(h, addr, b, 8, out r)) return IntPtr.Zero; long v = BitConverter.ToInt64(b, 0); return v == 0 ? IntPtr.Zero : (IntPtr)v; }',
  '  static ushort ReadU16(IntPtr h, IntPtr addr) { var b = new byte[2]; IntPtr r; if (!ReadProcessMemory(h, addr, b, 2, out r)) return 0; return BitConverter.ToUInt16(b, 0); }',
  '  public static string GetCwd(int pid) {',
  '    var h = OpenProcess(0x0410, false, pid);',
  '    if (h == IntPtr.Zero) return null;',
  '    try {',
  '      var pbi = new PBI(); int rl;',
  '      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(typeof(PBI)), out rl) != 0) return null;',
  '      var pp = ReadPtr(h, (IntPtr)((long)pbi.Peb + 0x20));',
  '      if (pp == IntPtr.Zero) return null;',
  '      ushort len = ReadU16(h, (IntPtr)((long)pp + 0x38));',
  '      var buf = ReadPtr(h, (IntPtr)((long)pp + 0x40));',
  '      if (buf == IntPtr.Zero || len == 0 || len > 2048) return null;',
  '      var b = new byte[len]; IntPtr r;',
  '      if (!ReadProcessMemory(h, buf, b, len, out r)) return null;',
  "      return System.Text.Encoding.Unicode.GetString(b).TrimEnd('\\0');",
  '    } finally { CloseHandle(h); }',
  '  }',
  '}',
  "'@",
  'Add-Type -TypeDefinition $src',
  'foreach ($p in Get-CimInstance Win32_Process) {',
  '  $cwd = [WeaveWtCwd]::GetCwd($p.ProcessId)',
  "  if ($null -ne $cwd -or $p.Name -eq 'WindowsTerminal.exe' -or $p.Name -eq 'OpenConsole.exe') {",
  "    $created = if ($p.CreationDate) { $p.CreationDate.ToString('yyyyMMddHHmmss') } else { '' }",
  "    '{0}|{1}|{2}|{3}|{4}' -f $p.ProcessId, $p.ParentProcessId, $p.Name, $created, $cwd",
  '  }',
  '}',
].join('\n');

/** wt 进程表超时：实测 ~3.4s（Add-Type 编译 + 全表 PEB 走读），负载下放宽。 */
const WT_DUMP_TIMEOUT_MS = 15000;

/** wt 进程表一行（name 已归一小写）。 */
export interface WtProcRow {
  pid: number;
  parentPid: number;
  name: string;
  created: string;
  cwd: string | null;
}

export function parseWtProcDump(text: string): WtProcRow[] {
  const rows: WtProcRow[] = [];
  for (const line of text.split('\n')) {
    const cols = line.trimEnd().split('|');
    if (cols.length !== 5) continue;
    const pid = Number(cols[0]);
    const parentPid = Number(cols[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || pid <= 0 || parentPid < 0) continue;
    if (!cols[2]) continue;
    rows.push({
      pid,
      parentPid,
      name: cols[2]!.toLowerCase(),
      created: cols[3]!,
      cwd: cols[4] === '' ? null : cols[4]!,
    });
  }
  return rows;
}

/** shell 家族（链尾跟踪到最深的一个 = 用户当下所在的 shell）。 */
const WT_SHELL_EXES = new Set([
  'bash.exe',
  'zsh.exe',
  'sh.exe',
  'fish.exe',
  'pwsh.exe',
  'powershell.exe',
  'cmd.exe',
]);

/**
 * pane 反查（纯函数）：pane 根 = WindowsTerminal 直接子进程里非 OpenConsole
 * 的那些（shell 启动器 / cmd 包装 / claude 直跑……）。cwd 取「最深 shell 链
 * 尾」：Git Bash 的 bin/bash 只是启动器（cwd 停在启动目录），真正交互的
 * usr/bin/bash 是它的子进程；非 shell 根（如 claude）取根自己的 cwd——
 * 它的工具子进程不是 pane，不该跟。
 */
export function wtPanes(rows: readonly WtProcRow[]): { pid: number; cwd: string | null }[] {
  const wtPids = new Set(
    rows.filter((r) => r.name === 'windowsterminal.exe').map((r) => r.pid),
  );
  if (wtPids.size === 0) return [];
  const byParent = new Map<number, WtProcRow[]>();
  for (const r of rows) {
    if (r.parentPid === r.pid) continue;
    const list = byParent.get(r.parentPid) ?? [];
    list.push(r);
    byParent.set(r.parentPid, list);
  }
  const panes: { pid: number; cwd: string | null }[] = [];
  for (const r of rows) {
    if (!wtPids.has(r.parentPid) || r.name === 'openconsole.exe') continue;
    let node = r;
    while (WT_SHELL_EXES.has(node.name)) {
      const shells = (byParent.get(node.pid) ?? []).filter((k) => WT_SHELL_EXES.has(k.name));
      if (shells.length === 0) break;
      node = shells.reduce((a, b) =>
        b.created > a.created || (b.created === a.created && b.pid > a.pid) ? b : a,
      );
    }
    panes.push({ pid: r.pid, cwd: node.cwd });
  }
  return panes;
}

/** 计数口径：每 pane 一个独立窗口键（wt 归属不到窗口；前端文案「N 个终端
 * 已打开」对 pane 数成立，窗口级的 wezterm 也落在同一文案下）。 */
export function wtPanesAsWindows(
  panes: readonly { pid: number; cwd: string | null }[],
): WeztermMuxPane[] {
  return panes.map((p) => ({ muxKey: `wt:${p.pid}`, windowId: p.pid, cwd: p.cwd }));
}

async function listWtPanes(): Promise<{ pid: number; cwd: string | null }[]> {
  if (process.platform !== 'win32') return [];
  const r = await captureCommand(
    'powershell.exe',
    ['-NoProfile', '-Command', WT_PROC_DUMP],
    undefined,
    WT_DUMP_TIMEOUT_MS,
  );
  if (!r?.ok) return [];
  return wtPanes(parseWtProcDump(r.out));
}

/** 探活结果短缓存（10s，同 muxCache）：一枪 ~3.4s 的 PowerShell，角标轮询
 * 每 30s 打多枪必吃缓存。落点决策也吃它——wt 命名窗口「不在则重建」自愈，
 * 不像 wezterm 会把分屏落进刚关掉的 pane。 */
let wtPaneCache: { at: number; panes: { pid: number; cwd: string | null }[] } | null = null;

export async function wtPanesCached(): Promise<{ pid: number; cwd: string | null }[]> {
  if (wtPaneCache && Date.now() - wtPaneCache.at < 10000) return wtPaneCache.panes;
  const panes = await listWtPanes();
  wtPaneCache = { at: Date.now(), panes };
  return panes;
}

/**
 * 项目命名窗口名：路径归一键 → 净化 + 短哈希（同路径稳定；净化后撞名的
 * 两个目录靠哈希区分）。wt 窗口名在窗口切换器里用户可见，保留可读前缀。
 */
export function wtWindowSlug(dir: string): string {
  const key = normalizeDirKey(dir, 'win32') ?? 'root';
  const sanitized = key.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 8);
  return `weave-${sanitized.slice(0, 48) || 'root'}-${hash}`;
}

/** 定点目标 id ↔ 命名窗口名；坏 id → null。落点窗口由 dir 重derive（picker
 * 条目可能陈旧，dir 才是会话真身）。 */
export function parseWtTargetId(id: string): string | null {
  const m = /^wt:(weave-[a-z0-9-]+)$/.exec(id);
  return m ? m[1]! : null;
}


/** wt 的 pane id ↔ 会话进程号；坏 id → null。 */
export function parseWtPaneId(id: string): number | null {
  const m = /^wt:(\d+)$/.exec(id);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * 上报的 pane env → wt 要打键的那个 pid；不是 wt 会话（缺世界标记或 pid）→ null。
 * 纯函数：环境判定与取值一处写，投递路径只做存在性校验。
 */
export function wtPanePidFromEnv(env: Record<string, string>): number | null {
  const [worldKey, pidKey] = TERMINAL_LOCATOR_ENV.wt;
  if (!env[worldKey]) return null;
  const raw = env[pidKey];
  if (!raw || !/^\d+$/.test(raw)) return null;
  const pid = Number(raw);
  return pid > 0 ? pid : null;
}

export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';

/**
 * wt 的击键通道：**附着到会话进程的 console 写输入记录**（AttachConsole +
 * WriteConsoleInput）——WT 不给 per-pane 写入口，而它的每个 pane 都是一个
 * ConPTY，输入记录写进去与真按键等价（实测：ESC/Tab/CR/方向键/文本字节级到达，
 * 且**不需要窗口在前台**，不抢焦点）。
 *
 * 落地方式：daemon 侧没有可直接调 Win32 的运行时，故起一个 PowerShell 把同一段
 * C# 现编现用（`Add-Type`，~1s；这是每次击键一条的一次性子进程，不进循环）。
 * 键串与 pid 走 env 传递（键串 base64）——不拼进脚本文本，免引号注入。
 *
 * 失败一律 throw（消息/作答转可见失败，不静默丢）——console 附着不上通常意味着
 * 目标进程已不是那个 pane 的客户端（换了终端/已退出），正是该让用户看见的真相。
 */
export async function wtInjectKeys(pid: number, keys: string): Promise<void> {
  const r = await captureCommand(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', wtInjectEncodedScript()],
    {
      ...process.env,
      WEAVE_WT_PID: String(pid),
      WEAVE_WT_KEYS: Buffer.from(keys, 'utf8').toString('base64'),
    },
    15000,
  );
  if (!r) throw new Error('powershell is unavailable — cannot send keys into Windows Terminal');
  if (r.ok) return;
  if (r.timedOut) throw new Error('Windows Terminal key injection timed out');
  throw new Error(`Windows Terminal key injection failed: ${r.err || r.out || 'unknown error'}`);
}

/** PowerShell 脚本（base64/UTF-16，`-EncodedCommand` 免引号转义）；纯函数，单测覆盖。 */
export function wtInjectEncodedScript(): string {
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${WT_KEY_EVENT_CS}
'@
$keys = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:WEAVE_WT_KEYS))
$r = [WeaveWtKeys]::Send([uint32]$env:WEAVE_WT_PID, $keys)
if (-not $r.StartsWith('ok:')) { [Console]::Error.WriteLine($r); exit 3 }
`;
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * 输入记录的最小 P/Invoke 面（ATTACH → 打开 CONIN$ → 写记录 → 释放）。
 * 控制字符给真 VK（ESC/CR/Tab/BS）——其余字符 VK=0 靠 UnicodeChar 直接成字，
 * 给错 VK 会变成别的键（如 `-` 曾按 VK_INSERT 翻成 `ESC[2~`，实测踩到）。
 *
 * **缓冲必须手写、stride 恒 20 字节**：wincon.h 的 INPUT_RECORD = WORD EventType
 * (+2 pad) + KEY_EVENT_RECORD 16（BOOL 4 + WORD×3 + WCHAR 2 + DWORD 4），union
 * 对齐 4 不对齐 8——x64 上就是 20，**不是 24**。stride 写错时第 0 条恰好落在
 * 真实槽 0、后续条全部错位（24 与 20 只在 0 和 120 字节处重合），表现即「只有
 * 第一个字符能到、其余被 conhost 当垃圾丢掉」（实测 'PQRS'→'P'、'ABC中文DEF'→
 * 'AD'，与错位公式逐条吻合）。手写而非结构体数组 marshal，是为了让 stride 与
 * 字段偏移一眼可见、不再受 C# 布局规则摆布。
 */
const WT_KEY_EVENT_CS = `using System;
using System.Runtime.InteropServices;

public static class WeaveWtKeys
{
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WriteConsoleInputW(IntPtr h, IntPtr recs, uint len, out uint written);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr h);

    static ushort VkOf(char c)
    {
        if (c == (char)0x1B) return 0x1B;
        if (c == (char)0x0D) return 0x0D;
        if (c == (char)0x09) return 0x09;
        if (c == (char)0x08) return 0x08;
        if (c == (char)0x03) return 0x43; // Ctrl+C：裸 \x03 不是击键，要 VK_C + CTRL 按下
        return 0;
    }

    static uint CtrlOf(char c)
    {
        return c == (char)0x03 ? 0x8u : 0u; // LEFT_CTRL_PRESSED
    }

    public static string Send(uint pid, string keys)
    {
        FreeConsole();
        if (!AttachConsole(pid)) return "attach:" + Marshal.GetLastWin32Error();
        IntPtr h = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (h == new IntPtr(-1))
        {
            int e = Marshal.GetLastWin32Error();
            FreeConsole();
            return "conin:" + e;
        }
        // 20 字节/条：WORD EventType; WORD pad; BOOL bKeyDown; WORD repeat; WORD vk;
        // WORD scan; WCHAR unicodeChar; DWORD controlKeyState（union 对齐 4，见上）。
        const int REC = 20;
        IntPtr buf = Marshal.AllocHGlobal(keys.Length * 2 * REC);
        try
        {
            for (int i = 0; i < keys.Length; i++)
            {
                char c = keys[i];
                ushort vk = VkOf(c);
                uint ctrl = CtrlOf(c);
                for (int down = 0; down < 2; down++)
                {
                    IntPtr r = new IntPtr(buf.ToInt64() + (i * 2 + down) * REC);
                    Marshal.WriteInt16(r, 0, 1);                  // EventType = KEY_EVENT
                    Marshal.WriteInt16(r, 2, 0);                  // padding（union 对齐 4）
                    Marshal.WriteInt32(r, 4, down == 0 ? 1 : 0);  // bKeyDown
                    Marshal.WriteInt16(r, 8, 1);                  // wRepeatCount
                    Marshal.WriteInt16(r, 10, (short)vk);         // wVirtualKeyCode
                    Marshal.WriteInt16(r, 12, 0);                 // wVirtualScanCode
                    Marshal.WriteInt16(r, 14, (short)c);          // UnicodeChar
                    Marshal.WriteInt32(r, 16, ctrl);              // dwControlKeyState
                }
            }
            uint written;
            bool ok = WriteConsoleInputW(h, buf, (uint)(keys.Length * 2), out written);
            int err = Marshal.GetLastWin32Error();
            return ok ? "ok:" + written : "write:" + err;
        }
        finally { Marshal.FreeHGlobal(buf); CloseHandle(h); FreeConsole(); }
    }
}`;


/**
 * Konsole（KDE，Linux）：每个会话自带一条 D-Bus 路径（`KONSOLE_DBUS_SERVICE` +
 * `KONSOLE_DBUS_SESSION`，hook 子进程天然继承），会话对象自己就有 `sendText`
 * 与 `sendKey`——不抢焦点、不依赖窗口在前台，与 wt 那条 console 通道同级别。
 * pane id = `konsole:<服务名>|<会话路径>`。
 *
 * **本机（Windows）无法实机验证**：按 Konsole 公开的 D-Bus 接口写（见
 * docs/DECISIONS.md），调用失败一律抛真相，不静默降级成「送到了」。
 */
