/** 设置域：daemon 设置（终端预设/locale/AI/导出头）、采集开关与项目同步位。 */

import { apiFetch, API_BASE } from './client';
import type { Harness } from '@weavecode/core/harness';

export interface ProjectConfig {
  lastSyncAt: string | null;
}

/** Which terminal "open in terminal" launches; presets are platform-scoped. */
export type TerminalPreset =
  | 'auto'
  | 'wt'
  | 'powershell'
  | 'cmd'
  | 'terminal'
  | 'iterm'
  | 'gnome'
  | 'konsole'
  | 'wezterm'
  | 'ghostty'
  | 'custom';

export interface TerminalSettings {
  preset: TerminalPreset;
  /** Template for `custom`; `{path}` is replaced with the quoted directory. */
  customCommand: string;
}

/** mirror of packages/weave-server/src/daemon/settings.ts — 保持同步
 * （web 不能 import 含 node:fs 的 workspace 包，服务端 mergeDefaults
 * 白名单会把非法值规范化，漂移可自愈）。 */
export type Locale = 'zh-CN' | 'en';

export interface DaemonSettings {
  terminal: TerminalSettings;
  locale: Locale;
  /** mirror of packages/weave-server/src/daemon/settings.ts — 保持同步。 */
  hooks: { enabled: boolean };
  /** 开机自启 daemon（默认关）。 */
  startup?: { launchOnLogin: boolean };
  /** 监听绑定地址（默认 0.0.0.0）+ 局域网 HTTPS 端口（0 = 关）。 */
  server?: { bindHost: string; tlsPort?: number };
  /**
   * AI 助手（OpenAI 兼容端点）。地址/模型是非密配置；`apiKey` 服务端拆存
   * `<dataDir>/ai.json`（0600），GET 回显（设置页掩码展示）、PUT 原样写回，
   * `apiKeySet` 是服务端派生布尔。
   */
  ai?: { baseUrl: string; model: string; apiKey?: string | null; apiKeySet?: boolean };
  /**
   * 决策模型（Jev 兼容 / System One 接口，编排条件边判断）。同 ai 段口径：
   * 地址/模型非密，`apiKey` 拆存 `<dataDir>/decision.json`、GET 回显，
   * `apiKeySet` 服务端派生。
   */
  decision?: { baseUrl: string; model: string; apiKey?: string | null; apiKeySet?: boolean };
  /** 对话导出 HTML 的自定义头：多份保存、一份在用（activeId 为空 = 不带自定义头）。 */
  htmlExport?: HtmlExportSettings;
}

/** 一份自定义头（原样注入导出 HTML 的 `</head>` 之前；只在导出文件里生效）。 */
export interface HtmlExportProfile {
  id: string;
  name: string;
  head: string;
}

export interface HtmlExportSettings {
  activeId: string | null;
  profiles: HtmlExportProfile[];
}

export interface TerminalPresetMeta {
  id: TerminalPreset;
  label: string;
}

/** GET /settings 附带的对外访问地址（服务端 accessUrls 派生，全部 IP × 已开协议）。 */
export interface AccessUrl {
  url: string;
  protocol: 'http' | 'https';
  /** local = 本机回环；lan = 局域网其他设备可达。 */
  scope: 'local' | 'lan';
}

export interface DaemonSettingsBundle {
  settings: DaemonSettings;
  presets: TerminalPresetMeta[];
  platform: string;
  urls?: AccessUrl[];
}

/** user 档采集状态行（GET/PUT /capture；§6-2d 安装即启用，无独立开关位）。 */
export interface CaptureRow {
  harness: Harness;
  /** user settings 采集组已写入（= 全项目事件都被采集）。 */
  installed: boolean;
  /** user 级 helper 脚本就位（installed 而脚本缺 = 半安装，重开开关即修复）。 */
  helperPresent: boolean;
}

export const settingsApi = {
  /** Daemon-level settings (terminal preset) plus this platform's options. */
  getDaemonSettings: (): Promise<DaemonSettingsBundle> =>
    apiFetch<DaemonSettingsBundle>('/settings'),
  putDaemonSettings: (settings: DaemonSettings): Promise<DaemonSettings> =>
    apiFetch<DaemonSettings>('/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  /** user 档采集状态行（§6-2d：跨项目事件采集的地基）。 */
  getCapture: (): Promise<CaptureRow[]> =>
    apiFetch<{ rows: CaptureRow[] }>('/capture').then((r) => r.rows),
  putCapture: (harness: Harness, enabled: boolean): Promise<CaptureRow> =>
    apiFetch<CaptureRow>('/capture', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ harness, enabled }),
    }),
  getProjectConfig: (projectId: number): Promise<ProjectConfig> =>
    apiFetch<ProjectConfig>(`/projects/${projectId}/config`),
  putProjectConfig: (projectId: number, config: ProjectConfig): Promise<Response> =>
    fetch(`${API_BASE}/projects/${projectId}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    }),
};
