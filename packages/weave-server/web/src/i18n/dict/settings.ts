/** 设置弹窗词条。 */
export const settingsZh = {
  'settings.title': '设置',
  'settings.language': '语言',
  'settings.languageHint': 'dashboard 与 weave CLI 共用的界面语言。',
  'settings.defaultTerminal': '默认终端',
  'settings.defaultTerminalHint': '「在终端中打开」使用的终端程序；自动模式会探测当前系统可用的终端。',
  'settings.customCommand': '自定义命令',
  'settings.pathHint': '会被替换为带引号的项目路径，例如：',
  'settings.hooks': 'Weave 总开关',
  'settings.hooksHint': 'Weave daemon 总开关（规则级开关另控）；关闭后规则命中直接短路。',
  'settings.launchOnLogin': '开机自启 daemon',
  'settings.launchOnLoginHint':
    '登录系统时自动拉起 weave 后台服务（Windows 注册表 Run 项 / macOS LaunchAgent / Linux XDG 自启动），默认关闭。',
  'settings.retentionDays': '事件日志保留天数',
  'settings.retentionDaysHint':
    'hook 事件日志的被动清理阈值：超过该天数的日志在下一次跨天写入时删除（无定时任务）；保存后下一条事件即按新值清理。',
  'settings.daysUnit': '天',
  'settings.accessUrls': '访问地址',
  'settings.accessUrlsHint':
    '本机与局域网设备访问 dashboard 的完整地址；https 端口用于手机浏览器通知（自签证书，首次访问需在浏览器接受）。',
  'settings.urlLan': '局域网',
  'settings.urlLocal': '本机',
};

export const settingsEn: Record<keyof typeof settingsZh, string> = {
  'settings.title': 'Settings',
  'settings.language': 'Language',
  'settings.languageHint': 'UI language shared by the dashboard and the weave CLI.',
  'settings.defaultTerminal': 'Default terminal',
  'settings.defaultTerminalHint':
    'Terminal used by "Open in terminal"; auto mode probes the terminals available on this system.',
  'settings.customCommand': 'Custom command',
  'settings.pathHint': 'is replaced with the quoted project path, e.g.:',
  'settings.hooks': 'Weave master switch',
  'settings.hooksHint':
    'Weave daemon master switch (rule-level switches stay independent); when off, rule matching short-circuits.',
  'settings.launchOnLogin': 'Launch daemon on login',
  'settings.launchOnLoginHint':
    'Start the weave daemon automatically at login (Windows Run key / macOS LaunchAgent / Linux XDG autostart). Off by default.',
  'settings.retentionDays': 'Event log retention (days)',
  'settings.retentionDaysHint':
    'Passive cleanup threshold for hook event logs: older logs are deleted on the first write after the next day boundary (no scheduled job); saving takes effect on the next event.',
  'settings.daysUnit': 'days',
  'settings.accessUrls': 'Access URLs',
  'settings.accessUrlsHint':
    'Full URLs for this dashboard on loopback and LAN devices; the https port is what phone browsers need for notifications (self-signed — accept it on first visit).',
  'settings.urlLan': 'LAN',
  'settings.urlLocal': 'Local',
};
