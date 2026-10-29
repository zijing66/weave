/** 渲染块域：对话内嵌可视化的 fragment 只读回显（server 白名单根校验）。 */

import { apiFetch } from './client';

export interface VisualizationFragment {
  html: string;
}

export const visualizationApi = {
  /** 按绝对路径读 fragment 文件（路径须在白名单根内，越界 403）。 */
  visualizationFragment: (path: string): Promise<VisualizationFragment> =>
    apiFetch<VisualizationFragment>(
      `/visualizations/fragment?path=${encodeURIComponent(path)}`,
    ),
};
