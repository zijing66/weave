/** 设置弹窗词条。 */
export const settingsZh = {
  'settings.title': '设置',
  'settings.language': '语言',
  'settings.languageHint': 'dashboard 与 weave CLI 共用的界面语言。',
  'settings.defaultTerminal': '默认终端',
  'settings.defaultTerminalHint': '「在终端中打开」使用的终端程序；自动模式会探测当前系统可用的终端。',
  'settings.customCommand': '自定义命令',
  'settings.pathHint': '会被替换为带引号的项目路径，例如：',
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
};
