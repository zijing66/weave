import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ToolkitSection } from '@/components/ToolkitSection';
import { useT } from '@/i18n/I18nProvider';
import type { Mode } from '@/components/CategoryDetail';

/**
 * 资源管理页 Plugins tab：只含工具箱（内部按成分分 Claude Plugins / 工具包
 * 两组）；weave 插件区已移至 Weave 分类。key=mode——切全局/项目时重挂载，
 * 按新 scope 重新拉取（对齐 HooksPanel 的 refetch 口径）。
 */
export function PluginAssetsPanel({
  projectId,
  mode,
  runtimeTab,
}: {
  projectId: number;
  mode: Mode;
  runtimeTab: 'claude' | 'codex' | 'all';
}) {
  const t = useT();
  return (
    <div key={mode} className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <CardTitle className="text-sm">{t('toolkit.title')}</CardTitle>
          <span className="text-[11px] text-neutral-500">{t('toolkit.hint')}</span>
        </CardHeader>
        <CardContent className="space-y-1">
          <ToolkitSection projectId={projectId} runtimeTab={runtimeTab} />
        </CardContent>
      </Card>
    </div>
  );
}
