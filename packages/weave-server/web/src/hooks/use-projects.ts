import { useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ProjectRow } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { useT } from '@/i18n/I18nProvider';
import { registerInvalidator, subscribeFrame } from '@/lib/sse';

/**
 * 项目列表 + 归档面（TanStack Query 缓存域）：fetch/缓存/失效归 useQuery，
 * 重拉统一走 refreshProjects()（= invalidateQueries——SSE 帧与变更后的落定都指它）。
 * refetchOnWindowFocus 覆写全局缺省：后台 daemon 侧 reconcile 有 ≤5s 窗口，
 * 切回标签页补一枪（替掉原手挂的 visibilitychange 监听）。
 */
export function useProjects(onBootReady: () => void) {
  const t = useT();
  const { show } = useToast();
  const queryClient = useQueryClient();
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
    staleTime: Infinity,
    refetchOnWindowFocus: 'always',
    retry: false,
  });
  const archivedQuery = useQuery({
    queryKey: ['projects', 'archived'],
    queryFn: () => api.listArchivedProjects(),
    staleTime: Infinity,
    refetchOnWindowFocus: 'always',
    retry: false,
  });
  const projects = projectsQuery.data ?? [];
  const archivedProjects = archivedQuery.data ?? [];
  const refreshProjects = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  }, [queryClient]);
  // 首屏门：项目列表回来前，左侧列表与主区用骨架屏顶住——首次访问不再「先空一下再蹦」。
  // 同一个门也给启动页（App 的 BootSplash）放行；查询失败同样算就位，别把启动页焊在屏幕上。
  const shellReady = !projectsQuery.isPending;
  useEffect(() => {
    if (shellReady) onBootReady();
  }, [shellReady, onBootReady]);

  // 首拉失败（还没有任何数据可显示）toast 报因；此后刷新失败静默——与旧 fetcher
  // 的口径一致（refreshProjects 的 catch 本来就吞错）。
  useEffect(() => {
    if (projectsQuery.isError && projectsQuery.data === undefined) {
      show('error', String(projectsQuery.error));
    }
  }, [projectsQuery.isError, projectsQuery.data, projectsQuery.error, show]);

  // 项目行拖拽排序落定：乐观重排（落点即时反馈），持久化失败回滚到服务端
  // 真值并报因（失败不静默）。乐观更新直接写查询缓存（setQueryData）。
  const reorderProjects = useCallback(
    (ids: number[]) => {
      queryClient.setQueryData<ProjectRow[]>(['projects'], (prev) => {
        if (!prev) return prev;
        const byId = new Map(prev.map((p) => [p.id, p]));
        const next = ids.map((id) => byId.get(id)).filter((p): p is ProjectRow => !!p);
        for (const p of prev) if (!ids.includes(p.id)) next.push(p);
        return next;
      });
      api.reorderProjects(ids).catch((e) => {
        show('error', t('errors.projectReorderFailed', { error: String(e) }));
        refreshProjects();
      });
    },
    [queryClient, show, t, refreshProjects],
  );

  // 服务端写操作后推 invalidate('projects')（如 PUT /projects/order 排序落定），
  // 接到既有的重拉函数上——不再写「成功后手动 refresh」的胶水。
  useEffect(() => registerInvalidator('projects', refreshProjects), [refreshProjects]);

  // 项目注册表变更帧：整表重拉后 ProjectList 自然出现新项目。
  useEffect(() => subscribeFrame('project', refreshProjects), [refreshProjects]);

  return { projects, archivedProjects, refreshProjects, shellReady, reorderProjects };
}
