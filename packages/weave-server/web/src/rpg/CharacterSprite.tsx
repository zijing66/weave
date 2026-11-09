import { gameStatusOf, GAME_STATUS_ANIM, type GameStatus } from './status-map';
import { skinOf, PALETTE32, SKIN_STATUS_FRAMES, type ArchetypeSkin } from './skin';

/**
 * CSS 版 Q 角色形象（D1 裁定：sprite 位图资产本批不生产——色块按 32 色板拼）。
 * 呈现三件套全来自皮肤映射表（skin.ts）：部位色、状态帧表、动画名；本体只给
 * 七型名与派生状态。`image-rendering: pixelated` + steps(N) 离散帧 = 像素感。
 */

const PX = 6; // 基础像素（整倍缩放，无小数）

function cell(color: string, x: number, y: number, w = 1, h = 1): React.CSSProperties {
  return {
    position: 'absolute',
    left: x * PX,
    top: y * PX,
    width: w * PX,
    height: h * PX,
    background: color,
  };
}

export function CharacterSprite({
  archetype,
  status,
  size = 4,
}: {
  archetype: string | null | undefined;
  status: GameStatus;
  /** 整数倍缩放（默认 4 倍 = 96px 高的网格）。 */
  size?: number;
}) {
  const skin = skinOf(archetype);
  const frames = SKIN_STATUS_FRAMES[status];
  return (
    <div
      className="rpg-sprite"
      style={{ width: 16 * PX * size, height: 16 * PX * size, transform: `scale(${size})`, transformOrigin: 'top left' }}
      aria-hidden
    >
      <div style={{ width: 16 * PX, height: 16 * PX, position: 'relative', animation: `${frames.bob} ${frames.frames * frames.stepMs}ms steps(${frames.frames}) infinite` }}>
        <Body skin={skin} />
      </div>
    </div>
  );
}

/** 16×16 网格的 Q 版躯干（头 6 格 + 身 6 格 + 腿 2 格 + 持物）。 */
function Body({ skin }: { skin: ArchetypeSkin }) {
  return (
    <>
      {/* 头发 */}
      {cell(PALETTE32.ink, 4, 1, 8, 1)}
      {cell(skin.hair, 3, 2, 10, 2)}
      {/* 脸 */}
      {cell(PALETTE32.skinTone, 4, 4, 8, 3)}
      {/* 眼（两点，败退时由 CSS 类换形——这里只摆常态两点） */}
      {cell(PALETTE32.ink, 5, 5, 1, 1)}
      {cell(PALETTE32.ink, 10, 5, 1, 1)}
      {/* 腮红 */}
      {cell(PALETTE32.blush, 4, 6, 1, 1)}
      {cell(PALETTE32.blush, 11, 6, 1, 1)}
      {/* 躯干 */}
      {cell(skin.body, 4, 7, 8, 4)}
      {cell(skin.trim, 3, 8, 1, 3)}
      {cell(skin.trim, 12, 8, 1, 3)}
      {/* 腿 */}
      {cell(skin.trim, 5, 11, 2, 2)}
      {cell(skin.trim, 9, 11, 2, 2)}
      {/* 脚 */}
      {cell(PALETTE32.ink, 5, 13, 2, 1)}
      {cell(PALETTE32.ink, 9, 13, 2, 1)}
      {/* 持物（右手侧一格色块） */}
      {skin.prop && cell(skin.prop, 13, 8, 1, 2)}
    </>
  );
}

/** 会话七态 → 游戏态的便捷包装（调用方常手里是 SessionStatus）。 */
export function SessionSprite({
  archetype,
  sessionStatus,
  size,
}: {
  archetype: string | null | undefined;
  sessionStatus: Parameters<typeof gameStatusOf>[0];
  size?: number;
}) {
  const game = gameStatusOf(sessionStatus);
  return <CharacterSprite archetype={archetype} status={game} size={size} />;
}

export { GAME_STATUS_ANIM };
