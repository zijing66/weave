import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';

/** 最短转圈时长：本地 daemon 几十毫秒落定，裸闪一下看不见——撑住体感才有「转了」。 */
const MIN_SPIN_MS = 300;

/**
 * 面板头刷新按钮（全局唯一形态）：图标即按钮，点击后图标转圈到重拉落定再复原。
 * 与 FeedbackIcon 的写动作三态不同——刷新是幂等重拉，成功就是数据本身，没有
 * 「打勾」可报，只要「转圈 → 停」；结果文案（toast）归调用方。
 * 自持 loading：调用方传回 Promise 即可，不必各写一套状态机。
 */
export function RefreshIconButton({
  onClick,
  title,
  className,
}: {
  /** 重拉函数；返回 Promise 时图标至少转满 MIN_SPIN_MS（成功失败都停）。 */
  onClick: () => void | Promise<unknown>;
  title: string;
  className?: string;
}) {
  const [spinning, setSpinning] = useState(false);
  return (
    // ml-auto 这类 flex 子项布局类必须落在 Tooltip 的包裹 span 上（它才是
    // 父级 flex 的子项）；落在内部 button 上被 span 隔着不生效。
    <Tooltip label={title} className={className}>
      <button
        type="button"
        aria-label={title}
        disabled={spinning}
        onClick={() => {
          const result = onClick();
          if (!(result instanceof Promise)) return;
          setSpinning(true);
          void Promise.all([
            result.then(
              () => undefined,
              () => undefined,
            ),
            new Promise((resolve) => setTimeout(resolve, MIN_SPIN_MS)),
          ]).then(() => setSpinning(false));
        }}
        className="pointer-events-auto inline-flex items-center text-neutral-500 transition-colors hover:text-neutral-200 disabled:pointer-events-none [&_svg]:pointer-events-none"
      >
        <RefreshCw className={cn('h-3.5 w-3.5', spinning && 'animate-spin')} />
      </button>
    </Tooltip>
  );
}
