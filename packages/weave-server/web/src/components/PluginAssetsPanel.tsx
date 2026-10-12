import { Card, CardContent } from '@/components/ui/card';
import { ToolkitSection } from '@/components/ToolkitSection';
import type { Mode } from '@/components/CategoryDetail';

/**
 * 资源管理页 Plugins tab：只含插件工具包区（内部按仓库 namespace 分一级折叠块）；
 * weave 插件区已移至 Weave 分类。key=mode——切全局/项目时重挂载，
 * 按新 scope 重新拉取（对齐 HooksPanel 的 refetch 口径）。
 * 批 6 去掉「工具箱」标题：一级就是仓库名，再套一个总标题只是噪音。
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
  return (
    <div key={mode} className="space-y-4">
      <Card>
        <CardContent className="space-y-1 pt-4">
          <ToolkitSection projectId={projectId} runtimeTab={runtimeTab} />
        </CardContent>
      </Card>
    </div>
  );
}
