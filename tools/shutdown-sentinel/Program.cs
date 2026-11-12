using System.Runtime.InteropServices;

namespace WeaveShutdownSentinel;

/// <summary>
/// weave daemon 的系统关机哨兵：一个隐藏的原生消息窗口，专收 Windows 关机/注销
/// 广播（WM_QUERYENDSESSION / WM_ENDSESSION）。node 进程没有窗口收不到这组消息
/// （SIGTERM 在 Windows 关机路径上不会送达控制台进程），所以由这个几十行的
/// .NET 进程代持：收到关机广播 → stdout 打一行 "shutdown" → daemon（读 pipe）
/// 跑优雅停机链（WAL checkpoint 并回主库再退）。生命周期 = daemon 生命周期
/// （stdin EOF → 退出，与宠物窗同法）。
/// </summary>
public static class Program
{
    private const int WM_QUERYENDSESSION = 0x0011;
    private const int WM_ENDSESSION = 0x0016;

    [DllImport("user32.dll")]
    private static extern IntPtr DefWindowProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern ushort RegisterClassW(ref WNDCLASS lpWndClass);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateWindowExW(
        uint exStyle, [MarshalAs(UnmanagedType.LPWStr)] string className,
        [MarshalAs(UnmanagedType.LPWStr)] string windowName, uint style,
        int x, int y, int width, int height,
        IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

    [DllImport("user32.dll")]
    private static extern bool GetMessageW(out MSG msg, IntPtr hWnd, uint min, uint max);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG msg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessageW(ref MSG msg);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int stdHandle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandleW(string? name);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASS
    {
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    private static IntPtr _wndProcRef;

    public static void Main()
    {
        _wndProcRef = Marshal.GetFunctionPointerForDelegate<WndProcDelegate>(WndProc);
        var cls = new WNDCLASS
        {
            lpfnWndProc = _wndProcRef,
            hInstance = GetModuleHandleW(null),
            lpszClassName = "WeaveShutdownSentinelWnd",
        };
        if (RegisterClassW(ref cls) == 0) return;
        // HWND_MESSAGE = 仅消息窗口（不显示、不进任务栏、不参与 Z 序）
        var hwndMessageOnly = new IntPtr(-3);
        var hwnd = CreateWindowExW(0, cls.lpszClassName, "weave-shutdown-sentinel",
            0, 0, 0, 0, 0, hwndMessageOnly, IntPtr.Zero, cls.hInstance, IntPtr.Zero);
        if (hwnd == IntPtr.Zero) return;

        // stdin EOF = daemon 退出（无论哪条路径），哨兵随之退——生命周期对齐
        _ = Task.Run(() =>
        {
            try
            {
                using var sin = Console.OpenStandardInput();
                _ = sin.ReadByte();
            }
            catch { /* stdin 已关 */ }
            Environment.Exit(0);
        });

        Console.WriteLine("sentinel-ready");
        Console.Out.Flush();
        while (GetMessageW(out var msg, IntPtr.Zero, 0, 0))
        {
            TranslateMessage(ref msg);
            DispatchMessageW(ref msg);
        }
    }

    private delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    private static IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (msg == WM_QUERYENDSESSION || msg == WM_ENDSESSION)
        {
            try
            {
                var line = System.Text.Encoding.UTF8.GetBytes("shutdown\n");
                using var so = GetStdHandle(-11) != IntPtr.Zero ? Console.OpenStandardOutput() : null;
                if (so != null) so.Write(line, 0, line.Length);
                so?.Flush();
            }
            catch { /* 通知不到就算了：OS 照常关机 */ }
            // 回 TRUE：允许关机继续（我们只借信号，不拦流程；daemon 有 3s 兜底强退）
            return (IntPtr)1;
        }
        return DefWindowProc(hWnd, msg, wParam, lParam);
    }
}
