import { cn } from '@/lib/utils';

/**
 * 骨架屏原语（首次访问的加载占位）：**按真实布局形状**拼块，不写文案、不引文案词典。
 *
 * 为什么不搞全局遮罩/统一转圈：骨架的价值在于形状与内容同构（列表行 / 卡片网格 /
 * 表格 / 树），全局层不知道形状；而且本仓前端有 SSE 驱动的持续后台重拉（invalidate
 * 帧一到就重拉），全局 loading 会不停闪。用这里的原语在各面板**首拉未回**时替换内容即可。
 *
 * 用法：`if (loading) return <SkeletonRows rows={6} />;`
 *
 * **只用于「块」**：列表 / 卡片网格 / 正文 / 表格这类内容区块的首拉占位。
 * **按钮与图标的加载态保持原状**——动作用 `useActionFeedback` 三态 + `FeedbackIcon`
 * （转圈 → 打勾 → 复原）、刷新用 `RefreshIconButton`，一律不要换成骨架块：
 * 骨架表达「这块内容还没到」，三态表达「这个动作正在跑」，两者语义不同。
 */

/** 基础块：一块 shimmer。宽高由调用方给（className）。 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-neutral-800/70', className)} />;
}

/** 列表骨架：每行一个「图标位 + 两段文字」的行块（项目列表 / 会话列表 / 市场源等）。 */
export function SkeletonRows({
  rows = 5,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1.5 p-2', className)} aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
          <Skeleton className="h-4 w-4 shrink-0 rounded" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className={cn('h-3', index % 3 === 0 ? 'w-2/3' : 'w-1/2')} />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 卡片网格骨架：技能/市场卡的形状（标题 + 两行说明 + 底部徽标位）。 */
export function SkeletonCards({
  count = 6,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div
      className={cn('grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3', className)}
      aria-busy="true"
    >
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className="space-y-2 rounded-xl border border-white/[0.06] bg-neutral-900/40 p-3"
        >
          <Skeleton className="h-3.5 w-1/2" />
          <Skeleton className="h-2.5 w-full" />
          <Skeleton className="h-2.5 w-4/5" />
          <div className="flex items-center gap-1.5 pt-1">
            <Skeleton className="h-4 w-12 rounded-full" />
            <Skeleton className="h-4 w-8 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 文本块骨架：文档/预览这类「一段一段文字」的形状（行宽随机收尾，像真段落）。 */
export function SkeletonLines({
  lines = 8,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn('space-y-2 p-3', className)} aria-busy="true">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={cn(
            'h-3',
            index % 4 === 3 ? 'w-1/2' : index % 5 === 0 ? 'w-3/4' : 'w-full',
          )}
        />
      ))}
    </div>
  );
}

/** 主区骨架：分类栏 + 内容区一屏（首屏门用）。 */
export function SkeletonMain() {
  return (
    <div className="flex-1 overflow-hidden p-3" aria-busy="true">
      <div className="mb-3 flex items-center gap-2">
        <Skeleton className="h-6 w-24 rounded-lg" />
        <Skeleton className="h-6 w-16 rounded-lg" />
        <Skeleton className="h-6 w-20 rounded-lg" />
      </div>
      <SkeletonCards count={6} />
    </div>
  );
}
