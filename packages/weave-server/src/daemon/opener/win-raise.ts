import { captureCommand } from './wezterm-mux.js';

/** 一次唤出要向 Win32 问的三件事：窗口属于谁、标题叫什么、抬哪一个。 */
export interface WinRaiseRequest {
  /** 窗口属主 pid（wezterm：一个 GUI 进程装多个窗口）。 */
  guiPid?: number;
  /** 或者给 pane 里的进程，由脚本往上找 exe 命中的那个进程（wt：一窗一进程）。 */
  panePids?: readonly number[];
  /** 窗口所属进程 exe（小写，如 `windowsterminal.exe`）。 */
  exe?: string;
  /** 认窗口用的标题候选，**按可信度排序**（OS 窗口标题 = 该窗口某个 pane 的标题）。 */
  titles?: readonly string[];
}

/**
 * 唤出已开终端的 Windows 抓手 = 抬 HWND。终端都不给 CLI 窗口号：`wezterm cli
 * activate-pane` 只切 mux 内部焦点，实测既不抬窗口也不解最小化（`set-tab-title`
 * / `set-window-title` 也不落到 OS 标题上）；wt 更是只有 stdin 通道。能用的对应
 * 关系只有一条——**OS 窗口标题 = 该窗口某个 pane 的标题**（ConPTY 把 pane 的标题
 * 当终端标题上报），所以先按进程/exe 收窄到那家的窗口，再用标题消歧。
 *
 * 标题匹配必须**先归一**（脚本里做）：claude 的 title 带头部 spinner 字（`✳`/`◐`），
 * OS 标题停在 pane 上一次上报的那一帧、常常比此刻的 pane 标题差一格；wezterm 还会
 * 给多 tab 窗口的标题前缀 `[活动 tab/总数]`。
 *
 * 另一条实测约束写在脚本里：`SetForegroundWindow` 会被 Windows 的前台锁吞掉，抬之前
 * 必须把输入队列接到当前前台线程上。
 */
export async function winRaiseTerminalWindow(req: WinRaiseRequest): Promise<void> {
  const titles = (req.titles ?? []).filter((t) => t && !t.includes('|'));
  const r = await winRaiseOnce(req, titles);
  if (r.ok) return;
  if (r.code === 3) throw new Error('Could not find that terminal window — is it still open?');
  if (r.code === 4) throw new Error('Could not tell which window hosts that terminal — click it in the taskbar');
  throw new Error(`Could not bring the terminal to the front: ${r.err || 'unknown error'}`);
}

export async function winRaiseOnce(
  req: WinRaiseRequest,
  titles: readonly string[],
): Promise<{ ok: boolean; code: number; err: string }> {
  const r = await captureCommand(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', winRaiseEncodedScript()],
    {
      ...process.env,
      WEAVE_RAISE_PIDS: req.guiPid ? String(req.guiPid) : '',
      WEAVE_RAISE_PANE_PIDS: (req.panePids ?? []).join(','),
      WEAVE_RAISE_EXE: req.exe ?? '',
      WEAVE_RAISE_TITLES: titles.join('|'),
    },
    15000,
  );
  if (!r) {
    return { ok: false, code: -1, err: 'powershell is unavailable — cannot bring the terminal to the front' };
  }
  if (r.ok) return { ok: true, code: 0, err: '' };
  const err = `${r.err || ''} ${r.out || ''}`.trim();
  const code = r.timedOut ? -2 : /status\|ambiguous/.test(r.out) ? 4 : /status\|none/.test(r.out) ? 3 : -3;
  return { ok: false, code, err };
}

/** PowerShell 脚本（base64/UTF-16，`-EncodedCommand` 免引号转义）；纯函数，单测覆盖。 */
export function winRaiseEncodedScript(): string {
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${WIN_RAISE_CS}
'@
$exe = $env:WEAVE_RAISE_EXE
if (-not $exe) { $exe = '' }
$exe = $exe.ToLower()
$pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
foreach ($p in (($env:WEAVE_RAISE_PANE_PIDS + '') -split ',')) {
  if ($p -eq '') { continue }
  $a = [WeaveRaise]::Ancestor([uint32]$p, $exe)
  if ($a -ne 0) { [void]$pids.Add($a) }
}
foreach ($p in (($env:WEAVE_RAISE_PIDS + '') -split ',')) {
  if ($p -eq '') { continue }
  [void]$pids.Add([uint32]$p)
}
function Norm([string]$s) {
  if (-not $s) { return '' }
  $s = $s.Trim()
  $s = $s -replace '^\\[\\d+/\\d+\\]\\s*', ''
  $s = $s -replace '^[^\\p{L}\\p{N}]+', ''
  $s = $s -replace '\\s+', ' '
  return $s.Trim().ToLower()
}
$rows = [WeaveRaise]::Owned($pids, $exe)
foreach ($r in $rows) { $r.Title = Norm $r.Title }
$pick = $null
if ($rows.Count -eq 1) { $pick = $rows[0] }
else {
  foreach ($c in ($env:WEAVE_RAISE_TITLES -split '\\|')) {
    $c = Norm $c
    if ($c -eq '') { continue }
    $hit = @()
    foreach ($r in $rows) { if ($r.Title -eq $c) { $hit += $r } }
    if ($hit.Count -eq 1) { $pick = $hit[0]; break }
  }
}
if ($pick -eq $null) {
  foreach ($r in $rows) { '{0}|{1}|{2}' -f [int64]$r.Handle, $r.Pid, $r.Title }
  $code = 3
  if ($rows.Count -gt 1) { $code = 4; 'status|ambiguous' } else { 'status|none' }
  exit $code
}
$res = [WeaveRaise]::Raise([int64]$pick.Handle)
if ($res -ne 'ok') { [Console]::Error.WriteLine('raise:' + $res); exit 5 }
'exactly ' + [int64]$pick.Handle
exit 0
`;
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** 抬窗口的最小 P/Invoke 面（列窗口 → 按 pid/exe/标题认一个 → 接到前台线程再抬）。 */
const WIN_RAISE_CS = `using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class WeaveWindow
{
    public IntPtr Handle;
    public uint Pid;
    public string Title;
}

public static class WeaveRaise
{
    delegate bool EnumProc(IntPtr h, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLengthW(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool join);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder sb, ref uint size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W entry);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    static List<WeaveWindow> Windows()
    {
        List<WeaveWindow> list = new List<WeaveWindow>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            int len = GetWindowTextLengthW(h);
            if (len == 0 || !IsWindowVisible(h)) return true;
            StringBuilder sb = new StringBuilder(len + 2);
            GetWindowTextW(h, sb, sb.Capacity);
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            WeaveWindow w = new WeaveWindow();
            w.Handle = h;
            w.Pid = pid;
            w.Title = sb.ToString();
            list.Add(w);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    static string ExeOf(uint pid)
    {
        IntPtr h = OpenProcess(0x1000, false, pid);
        if (h == IntPtr.Zero) return "";
        try
        {
            StringBuilder sb = new StringBuilder(1024);
            uint size = 1024;
            if (!QueryFullProcessImageNameW(h, 0, sb, ref size)) return "";
            string path = sb.ToString();
            int slash = path.LastIndexOf('\\\\');
            return (slash >= 0 ? path.Substring(slash + 1) : path).ToLowerInvariant();
        }
        finally { CloseHandle(h); }
    }

    /** pane 里的进程往上找窗口宿主进程（wt 一窗一进程；wezterm 全窗口同一个 GUI，不适用）。 */
    public static uint Ancestor(uint pid, string exeLower)
    {
        if (exeLower.Length == 0) return 0;
        Dictionary<uint, uint> parents = new Dictionary<uint, uint>();
        Dictionary<uint, string> exes = new Dictionary<uint, string>();
        IntPtr snap = CreateToolhelp32Snapshot(0x2, 0);
        if (snap == (IntPtr)(-1)) return 0;
        try
        {
            PROCESSENTRY32W entry = new PROCESSENTRY32W();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            if (Process32FirstW(snap, ref entry))
            {
                do {
                    parents[entry.th32ProcessID] = entry.th32ParentProcessID;
                    exes[entry.th32ProcessID] = entry.szExeFile == null ? "" : entry.szExeFile.ToLowerInvariant();
                } while (Process32NextW(snap, ref entry));
            }
        }
        finally { CloseHandle(snap); }
        uint cur = pid;
        for (int i = 0; i < 16; i++)
        {
            if (!parents.ContainsKey(cur)) return 0;
            uint parent = parents[cur];
            if (parent == 0) return 0;
            string name;
            exes.TryGetValue(parent, out name);
            if (name == exeLower) return parent;
            cur = parent;
        }
        return 0;
    }

    public static List<WeaveWindow> Owned(HashSet<uint> pids, string exeLower)
    {
        List<WeaveWindow> list = new List<WeaveWindow>();
        foreach (WeaveWindow w in Windows())
        {
            if (pids.Count > 0 && !pids.Contains(w.Pid)) continue;
            if (exeLower.Length > 0 && ExeOf(w.Pid) != exeLower) continue;
            list.Add(w);
        }
        return list;
    }

    /** 还原最小化并抢前台：前台锁要接当前前台线程的输入队列，接目标窗口线程才压得住它们的焦点。 */
    public static string Raise(long hwnd)
    {
        IntPtr h = new IntPtr(hwnd);
        ShowWindow(h, 9);
        IntPtr fg = GetForegroundWindow();
        uint ignored;
        uint me = GetCurrentThreadId();
        uint fgThread = GetWindowThreadProcessId(fg, out ignored);
        uint targetThread = GetWindowThreadProcessId(h, out ignored);
        bool a = AttachThreadInput(me, fgThread, true);
        bool b = targetThread != me && AttachThreadInput(me, targetThread, true);
        if (!SetForegroundWindow(h)) { BringWindowToTop(h); SetFocus(h); }
        if (b) AttachThreadInput(me, targetThread, false);
        if (a) AttachThreadInput(me, fgThread, false);
        return (GetForegroundWindow() == h || !IsIconic(h)) ? "ok" : "nofg";
    }
}`;
