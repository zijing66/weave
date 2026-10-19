import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api, type StatuslineConfig } from '@/lib/api';
import { buildPreviewItems, type StatuslineTokens } from '@/lib/statusline-preview';
import { registerInvalidator } from '@/lib/sse';
import { useMediaQuery } from '@/lib/use-media-query';
import { useT } from '@/i18n/I18nProvider';
import { StatuslinePanel, PowerlineRow } from '@/components/StatuslinePanel';

/** 对话页底条最多摆几行——下面的行留给面板里那套完整预览。 */
const BAR_LINES = 2;

/**
 * 对话页底部的状态栏条：把项目的 statusline 配置按**当下手里的数据**渲染出来。
 *
 * 数据只有 weave 自己知道的那份（项目/会话/模型/时刻）——context/tokens/cost 这些
 * 是宿主 statusline stdin 里的字段，dashboard 这一侧没有，于是那些块整块不出现
 * （`buildPreviewItems` 只渲染给了 token 的块）。这与生成脚本「format 解析成空即
 * 丢掉」同口径：宁可少一块，也不摆一块空壳。
 *
 * 整条即入口：点开是同一个 StatuslinePanel（与资源页那处一份实现）。
 */
export function StatuslineBar({
  projectId,
  sessionName,
  model,
}: {
  projectId: number;
  /** 会话显示名（title 回退）。 */
  sessionName: string | null;
  /** 当前模型：别名优先（`/model` 收的那个），认不出就用真名。 */
  model: string | null;
}) {
  const t = useT();
  // 桌面才有这一条：窄屏的纵向空间留给对话本身
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [config, setConfig] = useState<StatuslineConfig | null>(null);
  const [open, setOpen] = useState(false);
  /** 能注入 TUI 的 harness（能力表派生；「谁支持」不按名字猜）——弹窗开了才问。 */
  const [tuiAgents, setTuiAgents] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .getStatusline(projectId)
      .then((r) => setConfig(r.config))
      .catch(() => setConfig(null));
  }, [projectId]);

  useEffect(() => {
    if (!isDesktop) return;
    load();
  }, [isDesktop, load]);

  // 配置被写（本窗口或别的窗口改了全局模板）→ 重拉
  useEffect(() => registerInvalidator('statusline', load), [load]);

  useEffect(() => {
    if (!open || tuiAgents !== null) return;
    api
      .capabilities()
      .then((c) =>
        setTuiAgents(
          c.statusline
            .filter((s) => s.tui === 'injectable')
            .map((s) => s.harness)
            .join(' / '),
        ),
      )
      .catch(() => {});
  }, [open, tuiAgents]);

  // 项目名/路径取既有的 ['projects'] 缓存域（App 已拉过，同一 key 直接命中）
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
    staleTime: Infinity,
    retry: false,
  }).data;
  const project = projects?.find((p) => p.id === projectId);

  if (!isDesktop || !config) return null;

  const now = new Date();
  const tokens: StatuslineTokens = { time: { time: `${pad(now.getHours())}:${pad(now.getMinutes())}` } };
  if (project?.name) tokens.project = { name: project.name, path: project.path ?? project.name };
  if (sessionName) tokens.session = { name: sessionName };
  if (model) tokens.model = { model };

  const lines = config.lines
    .slice(0, BAR_LINES)
    .map((row) => buildPreviewItems(config, row, tokens))
    .filter((items) => items.length > 0);
  // 一块都渲染不出来（还没配、或配置里的块都要宿主 stdin 的字段）→ 不摆空条
  if (lines.length === 0) return null;

  return (
    <>
      <button
        type="button"
        title={t('statusline.barTitle')}
        onClick={() => setOpen(true)}
        // 贴边：面板本体是 p-3，这里把内边距吃回去，底条铺满一条
        className="-mx-3 -mb-3 mt-1.5 flex shrink-0 flex-col gap-0.5 overflow-hidden border-t border-edge/[0.06] bg-neutral-950/50 px-3 py-1 text-left transition-colors hover:bg-neutral-900/70"
      >
        {lines.map((items, i) => (
          <div key={i} className="overflow-hidden text-[10px] leading-4">
            <PowerlineRow items={items} config={config} />
          </div>
        ))}
      </button>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
            onClick={() => setOpen(false)}
          >
            <div
              className="flex max-h-[90dvh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-edge/[0.1] bg-neutral-900 shadow-mac"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex shrink-0 items-center gap-2 border-b border-edge/[0.08] px-3 py-2">
                <span className="text-xs font-medium text-neutral-200">{t('statusline.barTitle')}</span>
                <span className="min-w-0 flex-1 truncate text-[10px] text-neutral-500">
                  {t('statusline.tuiHint', { agents: tuiAgents ?? '—' })}
                </span>
                <button
                  type="button"
                  title={t('common.close')}
                  aria-label={t('common.close')}
                  onClick={() => setOpen(false)}
                  className="rounded p-0.5 text-neutral-500 hover:text-neutral-200"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <StatuslinePanel projectId={projectId} />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
