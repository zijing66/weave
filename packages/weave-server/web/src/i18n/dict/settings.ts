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
  'settings.retentionDays': '事件日志保留天数',
  'settings.retentionDaysHint':
    'hook 事件日志的被动清理阈值：超过该天数的日志在下一次跨天写入时删除（无定时任务）；保存后下一条事件即按新值清理。',
  'settings.daysUnit': '天',
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
  'settings.retentionDays': 'Event log retention (days)',
  'settings.retentionDaysHint':
    'Passive cleanup threshold for hook event logs: older logs are deleted on the first write after the next day boundary (no scheduled job); saving takes effect on the next event.',
  'settings.daysUnit': 'days',
};
