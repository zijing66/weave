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
 * `progress`（0~1）与 `stageLabel` 是调用方给的确定性进度：logo 下方一条细
 * 进度条按阶段推进，阶段文案只作功能描述、不透接口细节。时序与数据解耦：
 * 自己吃掉「最短曝光」与淡出，调用方只回答 `ready` 与否——
 * 所以它可以在认证还没探测出来时就挂上，一路不断档地活到 Dashboard 首帧。
 * `reduced` 只关动画、不改变「就位后消失」的语义。
 */
export function BootSplash({ ready, progress, stageLabel }: { ready: boolean; progress: number; stageLabel: string }) {
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
      {/* 进度条总长与「logo+字标」同宽（h-10 的 logo 宽约 160px）：贴着 WeaveLogo 量出来的视觉宽度 */}
      <div className="mt-3 h-1 w-[160px] overflow-hidden rounded-full bg-white/10">
        <div
          className="boot-bar-fill h-full rounded-full transition-[width] duration-500 ease-mac"
          style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }}
        />
      </div>
      {/* key = 文案：阶段切换时重挂载，淡入动效重放一拍 */}
      <p key={stageLabel} className="boot-stage-label mt-2 text-11 text-neutral-500">{stageLabel}</p>
    </div>
  );
}
