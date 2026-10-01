/**
 * 终端 preset 展示名（服务端 PRESET_LABELS 的本地化覆盖）。
 * 终端程序名本身是专有名词，中英两侧一致，只有描述性文案翻译。
 */
export const presetsZh = {
  'preset.auto': '自动（探测可用终端）',
  'preset.wt': 'Windows Terminal',
  'preset.powershell': 'PowerShell',
  'preset.cmd': '命令提示符 (cmd)',
  'preset.terminal': 'Terminal.app',
  'preset.iterm': 'iTerm2',
  'preset.gnome': 'gnome-terminal',
  'preset.konsole': 'Konsole',
  'preset.wezterm': 'WezTerm',
  'preset.ghostty': 'Ghostty',
  'preset.custom': '自定义命令',
};

export const presetsEn: Record<keyof typeof presetsZh, string> = {
  'preset.auto': 'Auto (detect available terminal)',
  'preset.wt': 'Windows Terminal',
  'preset.powershell': 'PowerShell',
  'preset.cmd': 'Command Prompt (cmd)',
  'preset.terminal': 'Terminal.app',
  'preset.iterm': 'iTerm2',
  'preset.gnome': 'gnome-terminal',
  'preset.konsole': 'Konsole',
  'preset.wezterm': 'WezTerm',
  'preset.ghostty': 'Ghostty',
  'preset.custom': 'Custom command',
};
