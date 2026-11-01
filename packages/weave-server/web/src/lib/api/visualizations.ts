/** 渲染块域：对话内嵌可视化的 fragment 只读回显（server 白名单根校验）。 */

import { apiFetch } from './client';

export interface VisualizationFragment {
  /** 文件没变时缺席（`unchanged` 为真）。 */
  html?: string;
  /** 热更新的条件形：与 `mtime` 相同时只回这个标记，不搬正文。 */
  unchanged?: true;
  /** 文件最后修改时刻（ms）：下一拍拿它作条件。 */
  mtimeMs: number;
}

/** 设置页存储面板：weave 自己落点的 fragment 统计。 */
export interface VisualizationStats {
  root: string;
  count: number;
  bytes: number;
  /** 可安全清理：无对话引用且过了宽限期。 */
  unreferenced: { count: number; bytes: number };
}

export const visualizationApi = {
  /** 按绝对路径读 fragment 文件（路径须在白名单根内，越界 403）；带 `since`
   *  时是轮询的条件形（未变只回 `{unchanged, mtimeMs}`）。 */
  visualizationFragment: (path: string, since?: number): Promise<VisualizationFragment> =>
    apiFetch<VisualizationFragment>(
      `/visualizations/fragment?path=${encodeURIComponent(path)}${since == null ? '' : `&mtime=${since}`}`,
    ),
  getVisualizationStats: (): Promise<VisualizationStats> =>
    apiFetch<VisualizationStats>('/visualizations/stats'),
  /** 清掉无引用且过宽限期的 fragment（有引用的保留，历史气泡不破图）。 */
  cleanupVisualizations: (): Promise<{ removed: number; freedBytes: number }> =>
    apiFetch<{ removed: number; freedBytes: number }>('/visualizations/cleanup', { method: 'POST' }),
};
