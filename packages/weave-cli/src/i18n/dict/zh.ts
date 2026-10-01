/** CLI 中文词典（help / 解析错误 / 命令与选项描述）。 */
export const zh = {
  // --- help 帮助输出 ---
  'help.tagline': 'weave v{version} — Claude Code harness 工具',
  'help.usage': '用法：weave <命令> [选项]',
  'help.commands': '命令：',
  'help.globalOptions': '全局选项：',
  // --- 解析与运行错误 ---
  'cli.unknownCommand': '未知命令：{command}',
  'cli.error': '错误：{error}',
  'cli.missingRequired': '缺少必填选项：--{name}',
  'cli.invalidChoice': '--{name} 的取值 "{value}" 无效，可选值：{choices}',
  // --- 全局选项 ---
  'flag.help': '显示帮助',
  'flag.version': '显示版本',
  'flag.verbose': '详细输出',
  'flag.quiet': '抑制非必要输出',
  // --- 命令描述 ---
  'cmd.init.desc': '在当前项目初始化 weave harness',
  'cmd.status.desc': '查看当前 harness 状态',
  'cmd.daemon.desc': '管理后台守护进程（start、stop、status）',
  'cmd.daemon.start.desc': '在后台启动守护进程（不开浏览器——见 `weave dashboard`）',
  'cmd.daemon.stop.desc': '停止运行中的守护进程',
  'cmd.daemon.status.desc': '查看守护进程状态',
  'cmd.dashboard.desc': '在浏览器中打开 web 控制台（必要时先启动守护进程）',
  'cmd.scan.desc': '扫描已初始化 weave 的项目并注册',
  'cmd.statusline.desc': 'statusline 工具（预览 TUI）',
  'cmd.statusline.preview.desc': 'statusline 的交互式 Ink 预览',
  // --- 命令选项描述 ---
  'flag.init.preset': '配置预设：minimal、default 或 full',
  'flag.init.force': '覆盖已存在的文件',
  'flag.init.noInteractive': '禁用交互式提示',
  'flag.dir': '目标目录（默认：当前目录）',
  'flag.scan.dir': '扫描的根目录（默认：当前目录）',
  'flag.dashboard.noOpen': '只打印 dashboard URL，不打开浏览器',
  'flag.statusline.preview.project': '目标项目路径（默认：当前目录）',
};
