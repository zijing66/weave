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

export const visualizationApi = {
  /** 按绝对路径读 fragment 文件（路径须在白名单根内，越界 403）；带 `since`
   *  时是轮询的条件形（未变只回 `{unchanged, mtimeMs}`）。 */
  visualizationFragment: (path: string, since?: number): Promise<VisualizationFragment> =>
    apiFetch<VisualizationFragment>(
      `/visualizations/fragment?path=${encodeURIComponent(path)}${since == null ? '' : `&mtime=${since}`}`,
    ),
};
