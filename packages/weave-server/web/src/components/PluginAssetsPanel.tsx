import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { HooksPluginsSection } from '@/components/HooksPluginsSection';
import { ToolkitSection } from '@/components/ToolkitSection';
import { useT } from '@/i18n/I18nProvider';
import type { Mode } from '@/components/CategoryDetail';

/**
 * 文件资产页 Plugins tab：HooksPluginsSection + ToolkitSection 各包一层带
 * 标题的分区 Card（与 Weave 页同词条，两组件零内部改动）。key=mode——切全局/
 * 项目时重挂载，两个区段按新 scope 重新拉取（对齐 HooksPanel 的 refetch 口径）。
 */
export function PluginAssetsPanel({
  projectId,
  mode,
}: {
  projectId: number;
  mode: Mode;
}) {
  const t = useT();
  return (
    <div key={mode} className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <CardTitle className="text-sm">{t('hooks.plugins.title')}</CardTitle>
          <span className="text-[11px] text-neutral-500">{t('hooks.plugins.hint')}</span>
        </CardHeader>
        <CardContent className="space-y-1">
          <HooksPluginsSection />
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <CardTitle className="text-sm">{t('toolkit.title')}</CardTitle>
          <span className="text-[11px] text-neutral-500">{t('toolkit.hint')}</span>
        </CardHeader>
        <CardContent className="space-y-1">
          <ToolkitSection projectId={projectId} />
        </CardContent>
      </Card>
    </div>
  );
}
