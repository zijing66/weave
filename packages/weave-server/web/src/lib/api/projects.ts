/** 项目域：项目行、harness 接入面、健康检查、终端目标与 pane。 */

import type { Harness } from '@weavecode/core/harness';
import { apiFetch } from './client';
import type { AssetEntry } from './assets';

/**
 * 项目已接入的一个 harness（服务端由 init 选择结果派生）——项目卡标签与新建会话
 * 的 harness 选项同源。
 */
export interface ProjectHarness {
  id: Harness;
  /** true = 能新建会话（有 resume 槽裸 bin、且宿主版本过闸）；false 的行仍列出但置灰。 */
  canStartSession: boolean;
  /** 探到的宿主版本（只有设了版本闸的 harness 才带；探不到 = null）。 */
  version?: string | null;
  /** resume 槽的版本下限（置灰行据此说明原因）。 */
  minVersion?: string;
}

export interface ProjectRow {
  id: number;
  path: string;
  name: string;
  token: string;
  source: string;
  registeredAt: string;
  lastSeenAt: string | null;
  meta: string | null;
  /** 归档时间（null/undefined = 活跃项目）。 */
  archivedAt?: string | null;
  /** 已接入的 harness（init 选择结果）；缺省 = 服务端未带（旧响应）。 */
  harnesses?: ProjectHarness[];
}

/** 会话终端可附加目标（一个窗口内的一个 tab，按最近活跃排序；id 格式归各终端）。 */
export interface TerminalTarget {
  /** 不透明 id（回传给 openSessionTerminal）。 */
  id: string;
  windowId: number;
  tabId: number;
  /** 聚焦 pane 的标题；null → 前端回落窗口/Tab 号文案。 */
  title: string | null;
  /** cwd 命中该项目的 pane 数 / 该 tab 总 pane 数。 */
  matchCount: number;
  paneCount: number;
  active: boolean;
  /** 这个可见屏幕已长满（pane 数到服务端上限）：不可选，只能新开终端。 */
  full: boolean;
  /** 这张卡片上属于本项目的 pane（可关）；缺省 = 该后端关不了远程 pane。 */
  paneIds?: string[];
}

/** 项目名下可关的一个终端 pane（关终端多选弹窗的一张卡）；id 不透明，回传给
 *  `closeProjectTerminal`。 */
export interface TerminalPane {
  id: string;
  /** pane 标题（claude 的 OSC 标题 ≈ 会话名）；null → 前端回落「未命名 pane」。 */
  title: string | null;
  /** pane 工作目录；null = 取不到（理论上不该进列表——命中判据就是 cwd）。 */
  cwd: string | null;
}

/** 会话所在的**可见屏幕**（终端里的一块屏 = wezterm 一个 tab）：会话列表按它分块。
 *  id 不透明（只作分组键），窗口/Tab 号供块头文案。mirror of server 的 SessionTerminal。 */
export interface SessionTerminal {
  id: string;
  windowId: number;
  tabId: number;
  /** 所在窗口的 tab 数（>1 时块头才标 Tab 号）。 */
  tabsInWindow: number;
}

/** Structured result of one harness health check (core 返回，文案由 web 词典渲染). */
export interface HarnessCheck {
  id: string;
  params: Record<string, string | boolean>;
  ok: boolean;
}

/** 项目存储配置（对话附件的图片/文件落盘目录；null/缺省 = 全局默认）。 */
export interface ProjectStorage {
  images: string | null;
  files: string | null;
}

export interface ProjectStorageResult {
  storage: ProjectStorage;
  /** 生效目录（自定义 ?? 全局默认）——展示用，配置为空时就是它。 */
  effective: { images: string; files: string };
}

export const projectApi = {
  listProjects: (): Promise<ProjectRow[]> =>
    apiFetch<{ projects: ProjectRow[] }>('/projects').then((r) => r.projects),
  /** 归档项目面（仅基础信息；历史会话已在归档时清空）。 */
  listArchivedProjects: (): Promise<ProjectRow[]> =>
    apiFetch<{ projects: ProjectRow[] }>('/projects/archived').then((r) => r.projects),
  /** 归档：清空历史会话 + 管道文件，server 各消费面即刻跳过；项目行只留基础信息。 */
  archiveProject: (
    id: number,
  ): Promise<{
    project: ProjectRow;
    purged: { events: number; dispatches: number; sessions: number };
  }> => apiFetch(`/projects/${id}/archive`, { method: 'POST' }),
  /** 恢复：翻转归档位回活跃（会话历史不回来——归档是删除不是暂停）。 */
  restoreProject: (id: number): Promise<{ project: ProjectRow }> =>
    apiFetch<{ project: ProjectRow }>(`/projects/${id}/restore`, { method: 'POST' }),
  /** 项目列表拖动排序持久化：payload = 完整目标顺序（id 全量列表），幂等。 */
  reorderProjects: (ids: number[]): Promise<ProjectRow[]> =>
    apiFetch<{ projects: ProjectRow[] }>('/projects/order', {
      method: 'PUT',
      body: JSON.stringify({ ids }),
    }).then((r) => r.projects),
  /** Structured harness health checks (read-only; 批 8). */
  getHarnessChecks: (projectId: number): Promise<{ checks: HarnessCheck[] }> =>
    apiFetch<{ checks: HarnessCheck[] }>(`/projects/${projectId}/harness-checks`),
  /** Open a project directory in the OS file manager or a terminal. */
  openProject: (
    projectId: number,
    target: 'explorer' | 'terminal',
  ): Promise<{ ok: boolean; target: string; path: string }> =>
    apiFetch<{ ok: boolean; target: string; path: string }>(
      `/projects/${projectId}/open`,
      {
        method: 'POST',
        body: JSON.stringify({ target }),
      },
    ),
  /** 关掉该项目的已开终端（cwd 恰为项目目录的 pane 逐个关，窗口里别的 pane 不动）。
   *  只关 `paneIds` 清单里的（关终端多选弹窗的勾选结果）——不提供一口气全关。 */
  closeProjectTerminal: (
    projectId: number,
    paneIds: readonly string[],
  ): Promise<{ ok: boolean; closed: number }> =>
    apiFetch<{ ok: boolean; closed: number }>(`/projects/${projectId}/close-terminal`, {
      method: 'POST',
      body: JSON.stringify({ paneIds }),
    }),
  /** 本项目名下可关的 pane（关终端多选弹窗的数据面）：cwd 恰为项目目录的那些。
   *  终端预设关不了远程 pane（wt 只数不关）→ 409 中文修法，不给空表装作没终端。 */
  listProjectPanes: (projectId: number): Promise<TerminalPane[]> =>
    apiFetch<{ panes: TerminalPane[] }>(`/projects/${projectId}/panes`).then((r) => r.panes),
  /** 在项目**已打开的终端**里起一个新会话（服务端复用该项目目录的既有 pane；
   *  没有已开终端时 409——前置条件由服务端把关，前端置灰只是同一事实的镜像）。
   *  `harness` = 起哪个（须为该项目的已接入 harness）；缺省取已接入里第一个能起的。 */
  startProjectSession: (
    projectId: number,
    harness?: Harness,
  ): Promise<{ ok: boolean; command: string }> =>
    apiFetch<{ ok: boolean; command: string }>(`/projects/${projectId}/new-session`, {
      method: 'POST',
      body: JSON.stringify(harness ? { harness } : {}),
    }),
  /** 会话终端的可附加目标（按最近活跃排序）：只 1 个时不弹窗、直接开。 */
  listProjectTerminals: (projectId: number): Promise<TerminalTarget[]> =>
    apiFetch<{ terminals: TerminalTarget[] }>(`/projects/${projectId}/terminals`).then(
      (r) => r.terminals,
    ),
  /** 唤醒（切到前台）该项目的某个已开终端——targetId 取自 listProjectTerminals。 */
  focusProjectTerminal: (projectId: number, targetId: string): Promise<{ ok: boolean }> =>
    apiFetch<{ ok: boolean }>(`/projects/${projectId}/focus-terminal`, {
      method: 'POST',
      body: JSON.stringify({ targetId }),
    }),
  /** 项目存储路径（对话附件落盘目录）：GET 回配置 + 生效目录。 */
  getProjectStorage: (projectId: number): Promise<ProjectStorageResult> =>
    apiFetch<ProjectStorageResult>(`/projects/${projectId}/storage`),
  /** 保存项目存储路径：空串/null = 清回全局默认；服务端校验绝对路径与可写。 */
  putProjectStorage: (
    projectId: number,
    storage: { images?: string | null; files?: string | null },
  ): Promise<ProjectStorageResult> =>
    apiFetch<ProjectStorageResult>(`/projects/${projectId}/storage`, {
      method: 'PUT',
      body: JSON.stringify(storage),
    }),
  listAssets: (projectPath: string): Promise<AssetEntry[]> =>
    apiFetch<{ projectPath: string; assets: AssetEntry[] }>(
      `/assets?path=${encodeURIComponent(projectPath)}`,
    ).then((r) => r.assets),
  /** Machine-level harness files (~/.claude, ~/.codex) for the global tree. */
  listGlobalFileAssets: (): Promise<AssetEntry[]> =>
    apiFetch<{ assets: AssetEntry[] }>('/global-file-assets').then((r) => r.assets),
};
