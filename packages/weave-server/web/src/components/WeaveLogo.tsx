import { useId } from 'react';
import { cn } from '@/lib/utils';

/**
 * 品牌标记 = 两块交叉的圆头光带拼成的 W（渐变紫 → 蓝 → 青）。
 * 一条左→右、一条右→左：首屏「交织」那一段正是靠两个方向对扫出来的。
 * 起点都收在 24×24 的 `viewBox` 里，墨迹 x 3.8..20.2 / y 5.0..17.2。
 */
const BANDS = [
  {
    d: 'M4.97 6.19L9.47 14.72Q10.13 16.03 11.25 14.72L16.31 6.19',
    from: '#b8a0ff',
    mid: '#237dff',
    to: '#00d7ff',
  },
  {
    d: 'M19.03 6.19L14.53 14.72Q13.5 16.03 12.75 14.72L7.78 6.19',
    from: '#32e4ff',
    mid: '#176dff',
    to: '#8b5cff',
  },
];

/**
 * 小写单词 `weave` 的矢量轮廓（Audiowide，离线烘成路径，运行时不依赖字体文件）。
 * 基线 y=27.5、x 高 15.03，墨迹 x 54.7..160.3；五个字重一致的几何圆角字形，
 * 这正是品牌稿里那个银色小写字标的手感。`data-glyph` 供首屏逐字上浮。
 */
const WORD_PATHS = [
  'M79.44 12.47Q78.58 14.41 77.58 16.28Q76.57 18.15 75.48 19.81Q74.39 21.48 73.25 22.89Q72.11 24.3 70.99 25.32Q69.87 26.35 68.81 26.92Q67.75 27.5 66.8 27.5Q66.41 27.5 66.08 27.36Q65.75 27.22 65.5 26.98Q65.25 26.74 65.11 26.4Q64.97 26.07 64.97 25.68V18.94L57.8 26.96Q57.52 27.24 57.19 27.37Q56.86 27.5 56.52 27.5Q56.14 27.5 55.81 27.36Q55.49 27.22 55.24 26.98Q54.99 26.74 54.84 26.4Q54.7 26.07 54.7 25.68V12.47H58.31V21.04L65.51 12.99Q65.9 12.6 66.43 12.49Q66.97 12.39 67.48 12.61Q68 12.82 68.3 13.27Q68.6 13.73 68.6 14.27V22.86Q69.76 21.73 70.71 20.48Q71.65 19.23 72.47 17.9Q73.28 16.57 74 15.21Q74.71 13.84 75.39 12.47Z',
  'M98.6 17.45Q98.6 18.2 98.34 19.07Q98.08 19.94 97.49 20.68Q96.89 21.43 95.94 21.93Q94.99 22.43 93.63 22.43H87.11V18.99H93.63Q94.36 18.99 94.77 18.54Q95.17 18.09 95.17 17.42Q95.17 16.71 94.72 16.31Q94.27 15.91 93.63 15.91H87.11Q86.37 15.91 85.97 16.36Q85.57 16.81 85.57 17.48V22.52Q85.57 23.25 86.02 23.65Q86.47 24.05 87.14 24.05H93.63V27.5H87.11Q86.36 27.5 85.49 27.24Q84.62 26.97 83.88 26.38Q83.13 25.79 82.63 24.84Q82.13 23.89 82.13 22.52V17.45Q82.13 16.7 82.4 15.83Q82.66 14.96 83.25 14.22Q83.84 13.47 84.79 12.97Q85.75 12.47 87.11 12.47H93.63Q94.38 12.47 95.25 12.74Q96.12 13 96.86 13.59Q97.6 14.18 98.1 15.14Q98.6 16.09 98.6 17.45Z',
  'M118.3 22.52Q118.3 23.27 118.04 24.14Q117.77 25.01 117.18 25.76Q116.59 26.5 115.64 27Q114.69 27.5 113.32 27.5H106.8Q106.05 27.5 105.18 27.24Q104.32 26.97 103.57 26.38Q102.83 25.79 102.33 24.84Q101.83 23.89 101.83 22.52Q101.83 21.77 102.09 20.9Q102.36 20.02 102.95 19.28Q103.54 18.53 104.49 18.03Q105.44 17.53 106.8 17.53H113.32V20.98H106.8Q106.07 20.98 105.66 21.43Q105.26 21.88 105.26 22.55Q105.26 23.26 105.73 23.66Q106.19 24.05 106.83 24.05H113.32Q114.06 24.05 114.46 23.61Q114.87 23.16 114.87 22.5V17.45Q114.87 16.74 114.43 16.32Q113.99 15.91 113.32 15.91H105.39V12.47H113.32Q114.07 12.47 114.94 12.74Q115.81 13 116.55 13.59Q117.3 14.18 117.8 15.14Q118.3 16.09 118.3 17.45Z',
  'M141.07 12.47Q140.45 14.38 139.63 16.23Q138.81 18.08 137.75 19.75Q136.69 21.43 135.37 22.85Q134.06 24.28 132.47 25.31Q130.88 26.35 129.01 26.94Q127.14 27.53 124.96 27.53Q124.58 27.53 124.25 27.39Q123.91 27.25 123.66 27.01Q123.41 26.76 123.27 26.44Q123.14 26.11 123.14 25.73V12.47H126.75V23.77Q128.07 23.77 129.29 23.2Q130.5 22.64 131.59 21.7Q132.67 20.76 133.59 19.56Q134.52 18.37 135.24 17.11Q135.96 15.85 136.47 14.64Q136.98 13.43 137.23 12.47Z',
  'M160.27 17.45Q160.27 18.2 160.01 19.07Q159.75 19.94 159.16 20.68Q158.56 21.43 157.61 21.93Q156.66 22.43 155.3 22.43H148.78V18.99H155.3Q156.04 18.99 156.44 18.54Q156.84 18.09 156.84 17.42Q156.84 16.71 156.39 16.31Q155.94 15.91 155.3 15.91H148.78Q148.04 15.91 147.64 16.36Q147.24 16.81 147.24 17.48V22.52Q147.24 23.25 147.69 23.65Q148.14 24.05 148.81 24.05H155.3V27.5H148.78Q148.03 27.5 147.16 27.24Q146.29 26.97 145.55 26.38Q144.8 25.79 144.3 24.84Q143.8 23.89 143.8 22.52V17.45Q143.8 16.7 144.07 15.83Q144.33 14.96 144.92 14.22Q145.51 13.47 146.46 12.97Q147.42 12.47 148.78 12.47H155.3Q156.05 12.47 156.92 12.74Q157.79 13 158.53 13.59Q159.27 14.18 159.77 15.14Q160.27 16.09 160.27 17.45Z',
];

/** 四段动效的错峰（毫秒）：连接 0 / 交织 180 / 形成 700 / 展现 820。与 index.css 对齐。 */
const FLOW_DELAYS = [0, 70];
const DRAW_DELAYS = [180, 270];
const GLYPH_DELAYS = [820, 880, 940, 1000, 1060];

/** 组合标里图形与文字的相对尺度：图形墨迹放大到字高的 ~1.85 倍（品牌稿构图——
 *  W 显著高出字标、底部略沉过字底），中心对齐字身并上偏少许。 */
const MARK_TRANSFORM = 'translate(-8.36 -7.92) scale(2.28)';

function Defs({ uid }: { uid: string }) {
  return (
    <defs>
      {BANDS.map((b, i) => (
        <linearGradient
          key={b.d}
          id={`${uid}-band-${i}`}
          gradientUnits="userSpaceOnUse"
          x1="4"
          y1="5"
          x2="20"
          y2="17"
        >
          <stop offset="0" stopColor={b.from} />
          <stop offset=".48" stopColor={b.mid} />
          <stop offset="1" stopColor={b.to} />
        </linearGradient>
      ))}
      {/* 交织点的爆闪：只在「形成」一瞬出现 */}
      <radialGradient id={`${uid}-flare`}>
        <stop offset="0" stopColor="#eaf8ff" stopOpacity=".85" />
        <stop offset="1" stopColor="#3b82f6" stopOpacity="0" />
      </radialGradient>
      {/* 银色字：上亮下收敛，随 currentColor 适配双主题 */}
      <linearGradient
        id={`${uid}-word`}
        gradientUnits="userSpaceOnUse"
        x1="0"
        y1="12"
        x2="0"
        y2="28"
      >
        <stop offset="0" stopColor="currentColor" />
        <stop offset=".55" stopColor="currentColor" stopOpacity=".92" />
        <stop offset="1" stopColor="currentColor" stopOpacity=".72" />
      </linearGradient>
      {/* 字标下方那道浅光，以及停在它上面往返的流光 */}
      <linearGradient id={`${uid}-beam`} gradientUnits="userSpaceOnUse" x1="56" y1="0" x2="161" y2="0">
        <stop offset="0" stopColor="#38bdf8" stopOpacity="0" />
        <stop offset=".5" stopColor="#7dd3fc" stopOpacity=".75" />
        <stop offset="1" stopColor="#38bdf8" stopOpacity="0" />
      </linearGradient>
      <linearGradient id={`${uid}-comet`}>
        <stop offset="0" stopColor="#7dd3fc" stopOpacity="0" />
        <stop offset=".5" stopColor="#e0f2fe" stopOpacity=".95" />
        <stop offset="1" stopColor="#7dd3fc" stopOpacity="0" />
      </linearGradient>
    </defs>
  );
}

/** 光带本体；`animated` 时额外挂「连接」的入流光与「形成」的爆闪。 */
function Bands({ uid, animated }: { uid: string; animated: boolean }) {
  return (
    <g className="wv-mark">
      {BANDS.map((b, i) => (
        <path
          key={b.d}
          d={b.d}
          fill="none"
          stroke={`url(#${uid}-band-${i})`}
          strokeWidth={2.3}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
          data-draw={animated ? '' : undefined}
          style={animated ? { animationDelay: `${DRAW_DELAYS[i]}ms` } : undefined}
        />
      ))}
      {animated && (
        <>
          <path
            d="M4.6 10.6H11.4"
            className="wv-flow"
            pathLength={1}
            style={{ animationDelay: `${FLOW_DELAYS[0]}ms` }}
          />
          <path
            d="M19.4 10.6H12.6"
            className="wv-flow"
            pathLength={1}
            style={{ animationDelay: `${FLOW_DELAYS[1]}ms` }}
          />
          <ellipse className="wv-flare" cx="12" cy="11.4" rx="4.6" ry="3.6" fill={`url(#${uid}-flare)`} />
        </>
      )}
    </g>
  );
}

/** 图形本体。静态场景（会话头部、登录页）不传 `animated`。 */
export function WeaveMark({ className, animated = false }: { className?: string; animated?: boolean }) {
  const uid = useId().replace(/:/g, '');
  return (
    <svg viewBox="3.6 4.8 16.8 12.6" className={cn('shrink-0', animated && 'wv-anim', className)} aria-hidden="true">
      <Defs uid={uid} />
      <Bands uid={uid} animated={animated} />
    </svg>
  );
}

/** 图形 + 单词的组合标（顶栏、启动页）。`currentColor` 只染文字，图形保持品牌色。 */
export function WeaveLogo({ className, animated = false }: { className?: string; animated?: boolean }) {
  const uid = useId().replace(/:/g, '');
  return (
    <svg
      viewBox="0 0 164 40"
      className={cn('shrink-0', animated && 'wv-anim', className)}
      role="img"
      aria-label="weave"
    >
      <Defs uid={uid} />
      <g transform={MARK_TRANSFORM}>
        <Bands uid={uid} animated={animated} />
      </g>
      <g transform="translate(1 0)">
        {WORD_PATHS.map((d, i) => (
          <path
            key={d}
            d={d}
            fill={`url(#${uid}-word)`}
            data-glyph={animated ? '' : undefined}
            style={animated ? { animationDelay: `${GLYPH_DELAYS[i]}ms` } : undefined}
          />
        ))}
        {animated && (
          <>
            <rect className="wv-beam" x="58" y="31" width="100" height="1.2" rx=".6" fill={`url(#${uid}-beam)`} />
            <rect className="wv-beam-run" x="58" y="31" width="16" height="1.2" rx=".6" fill={`url(#${uid}-comet)`} />
          </>
        )}
      </g>
    </svg>
  );
}
