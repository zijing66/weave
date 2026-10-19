import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type StatuslineConfig } from '@/lib/api';
import { buildPreviewItems, type StatuslineTokens } from '@/lib/statusline-preview';
import { registerInvalidator } from '@/lib/sse';
import { useT } from '@/i18n/I18nProvider';
import { PowerlineRow } from '@/components/StatuslinePanel';

/** 对话页底条最多摆几行——再多就把对话挤没了。 */
const BAR_LINES = 2;

/**
 * 对话页底部的状态栏条：把项目的 statusline 配置按**当下手里的数据**渲染出来。
 * **只读**——配置的入口在个性化配置里（同一份 StatuslinePanel），对话页不再开第二处。
 *
 * 数据只有 weave 自己知道的那份（项目/会话/模型/时刻）——context/tokens/cost 这些
 * 是宿主 statusline stdin 里的字段，dashboard 这一侧没有，于是那些块整块不出现
 * （`buildPreviewItems` 只渲染给了 token 的块）。这与生成脚本「format 解析成空即
 * 丢掉」同口径：宁可少一块，也不摆一块空壳。
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
  const [config, setConfig] = useState<StatuslineConfig | null>(null);

  const load = useCallback(() => {
    api
      .getStatusline(projectId)
      .then((r) => setConfig(r.config))
      .catch(() => setConfig(null));
  }, [projectId]);

  useEffect(load, [load]);

  // 配置被写（本窗口或别的窗口改了全局模板）→ 重拉
  useEffect(() => registerInvalidator('statusline', load), [load]);

  // 项目名/路径取既有的 ['projects'] 缓存域（App 已拉过，同一 key 直接命中）
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
    staleTime: Infinity,
    retry: false,
  }).data;
  const project = projects?.find((p) => p.id === projectId);

  if (!config) return null;

  const now = new Date();
  const tokens: StatuslineTokens = { time: { time: `${pad(now.getHours())}:${pad(now.getMinutes())}` } };
  if (project?.name) tokens.project = { name: project.name, path: project.path ?? project.name };
  if (sessionName) tokens.session = { name: sessionName };
  if (model) tokens.model = { model };

  // 先丢空行再封顶：配置的行序是「model / 会话指标 / git+目录」，指标那行今天
  // 全靠宿主 stdin（weave 拿不到）——先切后滤会把第三行的 project 白白砍掉。
  const lines = config.lines
    .map((row) => buildPreviewItems(config, row, tokens))
    .filter((items) => items.length > 0)
    .slice(0, BAR_LINES);
  // 一块都渲染不出来（还没配、或配置里的块都要宿主 stdin 的字段）→ 不摆空条
  if (lines.length === 0) return null;

  return (
    // 贴边：面板本体是 p-3，这里把内边距吃回去，底条铺满一条
    <div
      title={t('statusline.barTitle')}
      className="-mx-3 -mb-3 mt-1.5 flex shrink-0 flex-col gap-0.5 overflow-hidden border-t border-edge/[0.06] bg-neutral-950/50 px-3 py-1"
    >
      {lines.map((items, i) => (
        <div key={i} className="overflow-hidden text-[10px] leading-4">
          <PowerlineRow items={items} config={config} />
        </div>
      ))}
    </div>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
