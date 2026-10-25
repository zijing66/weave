/** 上传件域：内容寻址落盘的图片与普通文件（上传管线在 `lib/upload.ts`）。 */

import { apiFetch } from './client';

export interface UploadFile {
  id: string;
  name: string;
  mediaType: string;
  size?: number;
  /** 落盘绝对路径（daemon 下发；附件占位胶囊序列化用。旧 daemon 缺席 = 不摆占位）。 */
  path?: string;
}

/** 某会话随附的上传件清单（按会话清理的统计面）。 */
export interface SessionUploadsResult {
  uploads: Array<UploadFile & { createdAt: string }>;
  totalBytes: number;
}

/** 存储总览（设置页清理面头部；五档一次聚合）。 */
export interface UploadsOverview {
  total: { count: number; bytes: number };
  images: { count: number; bytes: number };
  files: { count: number; bytes: number };
  referenced: { count: number; bytes: number };
  unreferenced: { count: number; bytes: number };
}

export const uploadApi = {
  /** 某会话随附的上传件（设置页「对话附件存储」按会话清理的统计面）。 */
  getSessionUploads: (sessionId: string): Promise<SessionUploadsResult> =>
    apiFetch<SessionUploadsResult>(`/sessions/${encodeURIComponent(sessionId)}/uploads`),
  /** 清掉某会话的全部随附上传件（历史气泡的缩略图随之消失）。 */
  deleteSessionUploads: (sessionId: string): Promise<{ removed: number; freedBytes: number }> =>
    apiFetch<{ removed: number; freedBytes: number }>(`/sessions/${encodeURIComponent(sessionId)}/uploads`, {
      method: 'DELETE',
    }),
  /** 无引用上传件的预告数（一键清理前给用户看的「能清多少」）。 */
  getUnreferencedUploads: (): Promise<{ count: number; bytes: number }> =>
    apiFetch<{ count: number; bytes: number }>('/uploads/unreferenced'),
  /** 存储总览（总/图/文件/被引用/可安全清五档，一次聚合）。 */
  getUploadsOverview: (): Promise<UploadsOverview> =>
    apiFetch<UploadsOverview>('/uploads/overview'),
  /** 按 ids 批量删上传件（单件/分组勾选清的落点）。 */
  removeUploads: (ids: readonly string[]): Promise<{ removed: number }> =>
    apiFetch<{ removed: number }>('/uploads/remove', {
      method: 'POST',
      body: JSON.stringify({ ids: [...ids] }),
    }),
  /** 各会话随附上传件的总量（按会话清理的列表面；一次聚合）。 */
  getUploadsUsage: (): Promise<{ sessions: Array<{ sessionId: string; count: number; bytes: number }> }> =>
    apiFetch<{ sessions: Array<{ sessionId: string; count: number; bytes: number }> }>('/uploads/usage'),
  /** 一键清掉无引用上传件。 */
  cleanupUnreferencedUploads: (): Promise<{ removed: number; done: number; total: number }> =>
    apiFetch<{ removed: number; done: number; total: number }>('/uploads/unreferenced', {
      method: 'POST',
    }),
};
