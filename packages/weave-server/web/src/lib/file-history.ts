/**
 * 文件浏览器的「最近打开」历史：localStorage 按项目分桶，每桶 20 条。
 * 只记文件（打开到底态才算，右栏预览跟随选中不算）；同路径去重只更新时间。
 * 排序恒按最近访问倒序；失效（目录被删/改名）由面板打开时惰性校验。
 */

export interface FileHistoryEntry {
  /** 项目相对路径（正斜杠）。 */
  path: string;
  name: string;
  /** 最近打开时刻（epoch ms）。 */
  at: number;
}

const KEY = 'weave:file-browser-history';
const MAX = 20;

export function loadFileHistory(projectId: number): FileHistoryEntry[] {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    const arr = all[String(projectId)];
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (e): e is FileHistoryEntry =>
        !!e && typeof e === 'object' && typeof (e as FileHistoryEntry).path === 'string',
    );
  } catch {
    return [];
  }
}

/** 记一笔：同路径更新时间并置顶，超限淘汰最旧。返回新数组。 */
export function pushFileHistory(
  projectId: number,
  entry: { path: string; name: string },
): FileHistoryEntry[] {
  const prev = loadFileHistory(projectId).filter((e) => e.path !== entry.path);
  const next = [{ ...entry, at: Date.now() }, ...prev].slice(0, MAX);
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    all[String(projectId)] = next;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 存不进去就只活这一局（隐私模式等），不弹错
  }
  return next;
}
