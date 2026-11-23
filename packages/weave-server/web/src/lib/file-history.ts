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
  /** 跨项目合并视图（全项目文件浏览器首屏）用：条目所属项目；单项目桶里不填。 */
  projectId?: number;
  /** 合并视图里给行尾标项目名用。 */
  projectName?: string;
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

/**
 * 跨项目合并视图（全项目文件浏览器的首屏用）：各项目桶摊平、按最近倒序，
 * 每条带 projectId。首屏还没有「当前项目」，只按某个项目的桶显示会让内容
 * 取决于鼠标恰好停在哪个项目行——合并才是那个界面上该看到的东西。
 */
export function loadMergedFileHistory(max = 40): FileHistoryEntry[] {
  let all: Record<string, unknown>;
  try {
    all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: FileHistoryEntry[] = [];
  for (const [k, arr] of Object.entries(all ?? {})) {
    const pid = Number(k);
    if (!Number.isFinite(pid) || !Array.isArray(arr)) continue;
    for (const e of arr) {
      if (!e || typeof e !== 'object' || typeof (e as FileHistoryEntry).path !== 'string') continue;
      out.push({ ...(e as FileHistoryEntry), projectId: pid });
    }
  }
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, max);
}

/** 目录选择器的「最近选择」：绝对路径不分项目一桶，与文件历史同形同限。 */
const DIR_KEY = 'weave:dir-picker-history';

export function loadDirHistory(): FileHistoryEntry[] {
  try {
    const arr = JSON.parse(localStorage.getItem(DIR_KEY) ?? '[]') as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (e): e is FileHistoryEntry =>
        !!e && typeof e === 'object' && typeof (e as FileHistoryEntry).path === 'string',
    );
  } catch {
    return [];
  }
}

export function pushDirHistory(entry: { path: string; name: string }): FileHistoryEntry[] {
  const prev = loadDirHistory().filter((e) => e.path !== entry.path);
  const next = [{ ...entry, at: Date.now() }, ...prev].slice(0, MAX);
  try {
    localStorage.setItem(DIR_KEY, JSON.stringify(next));
  } catch {
    // 存不进去就只活这一局
  }
  return next;
}
