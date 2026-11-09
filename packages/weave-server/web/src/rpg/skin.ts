/**
 * 皮肤机制（D1）：皮肤 = 资产包 + 声明式呈现映射表，零数据零逻辑——本体
 * （角色/状态机/会话事实）不因换肤变一行。本批不生产 sprite 位图资产（裁定），
 * 默认主题用 CSS 形状/色块按 weaveRPG.md 32 色板画 Q 版形象：色值全在
 * PALETTE32 内、`image-rendering: pixelated` 整数倍缩放、动画 = steps(N) 离散帧。
 * 换真 sprite 包 = 新映射表 + <img>/background-position（机制已留：每型一段
 * sprite 元数据 + 每态一组帧位），web 渲染层零改动。
 *
 * 七型气质（weaveRPG.md）：能量=焰橙重甲 / 思考=玄青长袍 / 创造=藤紫短打 /
 * 连接=柳绿轻装 / 审核=黛蓝官服 / 执行=铁灰劲装 / 适配=麻布素衣。
 */

/** 32 色板（weaveRPG.md 像素基线，v1 全 16 进制）。 */
export const PALETTE32 = {
  ink: '#1a1721',
  paper: '#f2ede4',
  shadow: '#4a4458',
  mist: '#8b8598',
  flameBright: '#e8622c',
  flameDeep: '#a83a1c',
  gold: '#d9a441',
  sand: '#c9b78c',
  jade: '#3f9e6e',
  jadeDeep: '#2a6b4a',
  moss: '#7ba84d',
  bamboo: '#4f7a3a',
  cyan: '#3d8ea8',
  cyanDeep: '#265c72',
  indigo: '#4a5a9e',
  indigoDeep: '#2e3a6b',
  plum: '#8a5a9e',
  plumDeep: '#5c3a6b',
  rose: '#c9566e',
  roseDeep: '#8a3548',
  steel: '#6e7686',
  steelDeep: '#454b58',
  linen: '#d8cfc0',
  hemp: '#a89a84',
  skinTone: '#e8b892',
  blush: '#d98a6e',
  night: '#241f2e',
  slate: '#3a3444',
  spark: '#f2c14e',
  ember: '#b8542e',
  lake: '#5a9ea0',
  lakeDeep: '#38686a',
} as const;

export type PaletteColor = keyof typeof PALETTE32;

/** 七型 → Q 版形象的声明式映射（CSS 色块组装的部位色；值为 32 色板内的 16 进制）。 */
export interface ArchetypeSkin {
  /** 发色（顶部块）。 */
  hair: string;
  /** 衣服主色（躯干块）。 */
  body: string;
  /** 衣服暗色（描边/腿）。 */
  trim: string;
  /** 手持物色（能量=焰/思考=书/审核=尺…；null = 无持物）。 */
  prop: string | null;
}

export const ARCHETYPE_SKINS: Record<string, ArchetypeSkin> = {
  能量: { hair: '#a83a1c', body: '#e8622c', trim: '#8a2c14', prop: '#f2c14e' },
  思考: { hair: '#3a3444', body: '#3d8ea8', trim: '#265c72', prop: '#f2ede4' },
  创造: { hair: '#5c3a6b', body: '#8a5a9e', trim: '#5c3a6b', prop: '#c9566e' },
  连接: { hair: '#2a6b4a', body: '#7ba84d', trim: '#4f7a3a', prop: '#d9a441' },
  审核: { hair: '#1a1721', body: '#4a5a9e', trim: '#2e3a6b', prop: '#d8cfc0' },
  执行: { hair: '#454b58', body: '#6e7686', trim: '#454b58', prop: '#e8622c' },
  适配: { hair: '#4a4458', body: '#a89a84', trim: '#8a7c68', prop: null },
};

/** 未知型（自定义）走素衣。 */
export const FALLBACK_SKIN: ArchetypeSkin = ARCHETYPE_SKINS['适配']!;

export function skinOf(archetype: string | null | undefined): ArchetypeSkin {
  return (archetype != null ? ARCHETYPE_SKINS[archetype] : undefined) ?? FALLBACK_SKIN;
}

/**
 * 状态帧表（weaveRPG.md）：工作中 4 帧 120ms / 待机 2 帧 500ms / 受伤 3 帧
 * 180ms / 离场 4 帧 180ms。CSS steps(N) + keyframes 名由渲染层按 skin+状态拼。
 */
export const SKIN_STATUS_FRAMES = {
  battle: { frames: 4, stepMs: 120, bob: 'rpg-bob-battle' },
  idle: { frames: 2, stepMs: 500, bob: 'rpg-bob-idle' },
  defeated: { frames: 3, stepMs: 180, bob: 'rpg-bob-defeated' },
  gone: { frames: 4, stepMs: 180, bob: 'rpg-bob-gone' },
} as const;
