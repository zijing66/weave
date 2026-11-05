using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;

namespace WeavePetWindow;

/// <summary>
/// weave 桌面宠物窗宿主：无边框、透明、置顶、不进任务栏的 WebView2 壳。
/// 用法：weave-pet-window &lt;url&gt; --cookie &lt;sessionValue&gt; [--size WxH] [--pos X,Y]
/// cookie 在首次导航前种进独立 profile——pet.html 与 dashboard 走同一条会话认证。
/// 回收通道两条：stdin 一行（daemon 侧）或页面 postMessage "close"（用户侧）；
/// 页面 postMessage "drag-start" 触发原生 DragMove。窗口标题恒为
/// weave-pet-window（daemon 找窗用）。
/// </summary>
public static class Program
{
    public const string WindowTitle = "weave-pet-window";
    public const string SessionCookieName = "weave_session";

    private const int WM_NCLBUTTONDOWN = 0xA1;
    private const int HTCAPTION = 2;

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);

    [STAThread]
    public static void Main(string[] args)
    {
        if (args.Length == 0)
        {
            MessageBox.Show("usage: weave-pet-window <url> --cookie <sessionValue> [--size WxH] [--pos X,Y]", WindowTitle);
            return;
        }

        var url = args[0];
        string? cookie = null;
        string? devtoolsPort = null;
        int width = 200, height = 240, x = -1, y = -1;
        for (int i = 1; i + 1 < args.Length; i += 2)
        {
            if (args[i] == "--size")
            {
                var parts = (args[i + 1] ?? "").Split('x');
                if (parts.Length == 2 && int.TryParse(parts[0], out var w) && int.TryParse(parts[1], out var h))
                {
                    width = Math.Clamp(w, 80, 2000);
                    height = Math.Clamp(h, 80, 2000);
                }
            }
            else if (args[i] == "--pos")
            {
                var parts = (args[i + 1] ?? "").Split(',');
                if (parts.Length == 2 && int.TryParse(parts[0], out var px) && int.TryParse(parts[1], out var py))
                {
                    x = px;
                    y = py;
                }
            }
            else if (args[i] == "--cookie")
            {
                cookie = args[i + 1];
            }
            else if (args[i] == "--devtools-port")
            {
                devtoolsPort = args[i + 1];
            }
        }

        var app = new Application();
        var window = BuildWindow(url, cookie, width, height, x, y, devtoolsPort);

        // daemon 回收通道：stdin 任一字节（含 EOF）→ UI 线程关窗。WinExe 子系统
        // 下 Console.ReadLine 吃 pipe 喂数不返回（实测），改读裸流一字节。
        _ = Task.Run(() =>
        {
            try
            {
                using var sin = Console.OpenStandardInput();
                _ = sin.ReadByte();
            }
            catch { /* stdin 已关 */ }
            window.Dispatcher.BeginInvoke(() => window.Close());
        });

        app.Run(window);
    }

    /// <summary>
    /// 窗口位置回执：WebView2 的 window.screenX/Y 不随宿主挪窗更新（实测加载后
    /// 恒为初值），页面据此做贴边吸附与记位，所以位置必须由宿主报真值。
    /// </summary>
    private static void PostPos(Microsoft.Web.WebView2.Core.CoreWebView2 core, Window window)
    {
        core.PostWebMessageAsString($"pos:{window.Left:0},{window.Top:0}");
    }

    private static Window BuildWindow(string url, string? cookie, int width, int height, int x, int y, string? devtoolsPort)
    {
        var webView = new Microsoft.Web.WebView2.Wpf.WebView2
        {
            DefaultBackgroundColor = System.Drawing.Color.Transparent,
        };

        // 1/255 透明底：分层窗(AllowsTransparency)的命中测试按 alpha 判，WebView2
        // 区域在 WPF 图层里 alpha=0 ⇒ 整窗点击穿透（右键/拖拽全收不到）。铺一层
        // 肉眼不可见的极淡 alpha 让整窗参与命中测试。
        var hitTestBrush = new SolidColorBrush(Color.FromArgb(1, 0, 0, 0));
        hitTestBrush.Freeze();

        var window = new Window
        {
            Title = WindowTitle,
            Width = width,
            Height = height,
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.NoResize,
            AllowsTransparency = true,
            Background = hitTestBrush,
            Topmost = true,
            ShowInTaskbar = false,
            ShowActivated = false,
            Content = webView,
        };
        if (x >= 0 && y >= 0)
        {
            window.WindowStartupLocation = WindowStartupLocation.Manual;
            window.Left = x;
            window.Top = y;
        }
        else
        {
            // 默认位：主屏工作区右下角（留 8px 边距；Loaded 后量实际尺寸再落，
            // 此处 Width/Height 是 DIP 值与工作区同单位，直接算即可）。
            window.WindowStartupLocation = WindowStartupLocation.Manual;
            var wa = SystemParameters.WorkArea;
            window.Left = Math.Max(8, wa.Right - width - 8);
            window.Top = Math.Max(8, wa.Bottom - height - 8);
        }

        window.Loaded += async (_, _) =>
        {
            try
            {
                // 独立用户数据目录：不污染用户 Edge 档，落在 weave cache（可弃档）
                var userDataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "weave", "cache", "pet-window-profile");
                Directory.CreateDirectory(userDataFolder);
                var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder,
                    string.IsNullOrEmpty(devtoolsPort)
                        ? null
                        : new CoreWebView2EnvironmentOptions(
                            $"--remote-debugging-port={devtoolsPort}"));
                await webView.EnsureCoreWebView2Async(env);
                var core = webView.CoreWebView2;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                // 会话 cookie 种进独立 profile：pet.html 的 fetch/EventSource 与
                // dashboard 同一条认证路径（同源自动带），daemon 不开 query token 面
                if (!string.IsNullOrEmpty(cookie))
                {
                    var target = new Uri(url);
                    var c = core.CookieManager.CreateCookie(
                        SessionCookieName, cookie, target.Host, "/");
                    core.CookieManager.AddOrUpdateCookie(c);
                }
                // 页面侧通道：drag-start / resize:WxH / close（宠物页拖拽、右键调大小
                // 与关闭走这里）。DragMove 是模态循环，期间页面收不到 mouseup——
                // 返回后回执 drag-end 让页面记位（screenX/Y 此时已是新位置）。
                core.WebMessageReceived += (_, e) =>
                {
                    var msg = e.TryGetWebMessageAsString() ?? "";
                    if (msg == "pos-query")
                    {
                        PostPos(core, window);
                    }
                    else if (msg == "drag-start")
                    {
                        // 不用 Window.DragMove：鼠标点在 WebView2 子窗上，WPF 自己
                        // 没收到按下（DragMove 会因「左键未按住」失败）。发
                        // NCLBUTTONDOWN/HTCAPTION 让系统按拖标题栏处理，模态移动。
                        var hwnd = new WindowInteropHelper(window).Handle;
                        ReleaseCapture();
                        SendMessage(hwnd, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
                        core.PostWebMessageAsString($"drag-end:{window.Left:0},{window.Top:0}");
                    }
                    else if (msg.StartsWith("resize:", StringComparison.Ordinal))
                    {
                        var parts = msg["resize:".Length..].Split('x');
                        if (parts.Length == 2
                            && int.TryParse(parts[0], out var rw) && int.TryParse(parts[1], out var rh))
                        {
                            window.Width = Math.Clamp(rw, 80, 2000);
                            window.Height = Math.Clamp(rh, 80, 2000);
                        }
                    }
                    else if (msg.StartsWith("region:", StringComparison.Ordinal))
                    {
                        // 命中区 = 精灵实际像素包围盒（页面按当前帧算）：窗区域外的
                        // 部分既不显示也不吃鼠标，点空白处直接穿透到桌面。
                        var parts = msg["region:".Length..].Split(',');
                        if (parts.Length == 4
                            && int.TryParse(parts[0], out var rx)
                            && int.TryParse(parts[1], out var ry)
                            && int.TryParse(parts[2], out var rw)
                            && int.TryParse(parts[3], out var rh)
                            && rw > 0 && rh > 0)
                        {
                            var hwnd = new WindowInteropHelper(window).Handle;
                            // SetWindowRgn 接管区域所有权：成功后不要自己删
                            SetWindowRgn(hwnd, CreateRectRgn(rx, ry, rx + rw, ry + rh), true);
                        }
                    }
                    else if (msg.StartsWith("moveto:", StringComparison.Ordinal))
                    {
                        // 贴边偷窥的目标位由页面算好（它知道自己在哪块屏），宿主哑执行
                        var parts = msg["moveto:".Length..].Split(',');
                        if (parts.Length == 2
                            && double.TryParse(parts[0], out var mx) && double.TryParse(parts[1], out var my))
                        {
                            window.Left = mx;
                            window.Top = my;
                            PostPos(core, window);
                        }
                    }
                    else if (msg == "close")
                        window.Close();
                    else if (msg.StartsWith("open:", StringComparison.Ordinal))
                    {
                        // 气泡/通知点击 → 默认浏览器开 dashboard：WebView2 的
                        // window.open 只在壳内开新窗（无 NewWindowRequested 处理
                        // 会吞掉），深链交给系统浏览器才「打开浏览器」。
                        var openUrl = msg["open:".Length..];
                        if (Uri.TryCreate(openUrl, UriKind.Absolute, out var u)
                            && (u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps))
                        {
                            try { Process.Start(new ProcessStartInfo(openUrl) { UseShellExecute = true }); }
                            catch { /* 打不开就吞：点气泡不该炸窗 */ }
                        }
                    }
                };
                core.Navigate(url);
            }
            catch (Exception ex)
            {
                // WebView2 runtime 缺失等启动失败：弹说明后退出，不留白窗
                MessageBox.Show(
                    "WebView2 initialization failed:\n" + ex.Message +
                    "\n\nInstall the Evergreen WebView2 Runtime: https://developer.microsoft.com/microsoft-edge/webview2/",
                    WindowTitle);
                window.Close();
            }
        };

        return window;
    }
}
