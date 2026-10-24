/** statusline 面的方法（读写项目/全局配置与出厂默认）。 */

import { apiFetch, API_BASE } from './client';
import type { StatuslineConfig } from './statusline';

export const statuslineApi = {
  getStatusline: (
    projectId: number,
  ): Promise<{
    config: StatuslineConfig;
    script: string;
    globalConfig: StatuslineConfig;
    /** 宿主渲染脚本已算好的块事实（今天 = git 三块），没有缓存即 null。 */
    facts: Record<string, Record<string, string>> | null;
  }> =>
    apiFetch<{
      config: StatuslineConfig;
      script: string;
      globalConfig: StatuslineConfig;
      facts: Record<string, Record<string, string>> | null;
    }>(`/projects/${projectId}/statusline`),
  putStatusline: (projectId: number, config: StatuslineConfig): Promise<Response> =>
    fetch(`${API_BASE}/projects/${projectId}/statusline`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    }),
  /** Shipped factory defaults for the statusline panel's 恢复出厂. */
  getFactoryStatusline: (): Promise<StatuslineConfig> =>
    apiFetch<{ config: StatuslineConfig }>('/statusline/default').then((r) => r.config),
  putGlobalStatusline: (config: StatuslineConfig): Promise<Response> =>
    fetch(`${API_BASE}/statusline/global`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    }),
};
