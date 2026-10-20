import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/lib/use-media-query';
import { useT } from '@/i18n/I18nProvider';
import { WeaveLogo } from '@/components/WeaveLogo';

/** 至少亮满一遍四段动效（约 1.3s）——`ready` 来得比动效还快时不把动画吞掉。 */
const MIN_SHOW_MS = 1500;
/** 减少动效偏好下没有动画可看，别让人白等。 */
const MIN_SHOW_REDUCED_MS = 250;
/** 淡出时长，须与 index.css 的 `boot-fade-out` 一致。 */
const EXIT_MS = 320;

/**
 * 首屏启动页：认证探测 + 首份数据就位之前铺满整屏，只演化那个四段动效标
 * （连接 → 交织 → 形成 → 展现，字标底下的流光就是等待后端的不确定进度）。
 *
 * 时序与数据解耦：自己吃掉「最短曝光」与淡出，调用方只回答 `ready` 与否——
 * 所以它可以在认证还没探测出来时就挂上，一路不断档地活到 Dashboard 首帧。
 * `reduced` 只关动画、不改变「就位后消失」的语义。
 */
export function BootSplash({ ready }: { ready: boolean }) {
  const t = useT();
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [phase, setPhase] = useState<'show' | 'exit' | 'gone'>('show');
  const mountedAt = useRef(performance.now());

  useEffect(() => {
    if (!ready || phase !== 'show') return;
    const min = reduced ? MIN_SHOW_REDUCED_MS : MIN_SHOW_MS;
    const wait = Math.max(0, min - (performance.now() - mountedAt.current));
    const timer = setTimeout(() => setPhase('exit'), wait);
    return () => clearTimeout(timer);
  }, [ready, phase, reduced]);

  useEffect(() => {
    if (phase !== 'exit') return;
    const timer = setTimeout(() => setPhase('gone'), EXIT_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === 'gone') return null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t('app.booting')}
      className={cn(
        'boot-splash fixed inset-0 z-[80] flex flex-col items-center justify-center',
        phase === 'exit' ? 'boot-splash-exit' : 'boot-splash-enter',
      )}
    >
      <WeaveLogo animated={!reduced} className="h-10 w-auto" />
    </div>
  );
}
