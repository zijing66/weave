import { gameStatusOf, GAME_STATUS_ANIM, type GameStatus } from './status-map';
import { useEffect, useState } from 'react';
import { useT } from '@/i18n/I18nProvider';
import { skinOf, PALETTE32, SKIN_STATUS_FRAMES } from './skin';

/** 16×20 像素格：发髻、脸、交领袍和两格脚，与室外 24px tile 等比。 */
const PX = 2;
const WIDTH = 16;
const HEIGHT = 20;

export type SpriteGender = 'male' | 'female';

/** 头顶常驻状态条色（参考图：绿=正常/黄=警告/红=异常）。 */
export type BarTone = 'ok' | 'warn' | 'err';
const BAR_TONES: Record<BarTone, string> = { ok: '#3fbf5f', warn: '#d9a441', err: '#c9566e' };

export function spriteAppearance(seed: number, gender: SpriteGender, archetype: string | null | undefined, god: boolean) {
  const skin = skinOf(archetype);
  const hair = [PALETTE32.ink, PALETTE32.shadow, PALETTE32.steelDeep, skin.hair][seed % 4]!;
  const complexion = [PALETTE32.skinTone, '#dca981', '#c78c66', '#efd0aa'][(seed >>> 2) % 4]!;
  return {
    hair,
    complexion,
    robe: god ? PALETTE32.paper : skin.body,
    shade: god ? PALETTE32.linen : skin.trim,
    belt: god ? PALETTE32.cyanDeep : skin.trim,
    hairStyle: (seed >>> 4) % 3,
    sleeveStyle: (seed >>> 6) % 2,
    gender,
    prop: god ? null : skin.prop,
  };
}

type Appearance = ReturnType<typeof spriteAppearance>;

/** 无库外数据源的确定性种子（peer 席位/来访 NPC/分身由 id 派生外貌——
 *  不是本机上帝的 localStorage 面，刷新即同貌，与存储状态无关）。 */
export function spriteSeedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) & 0x7fffffff;
}

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
  size = 1,
  gender = 'male',
  appearanceSeed = 0,
  god = false,
  facing = 'down',
  bar = null,
}: {
  archetype: string | null | undefined;
  status: GameStatus;
  /** 像素图等比倍率：室外 0.75（24×30px）、卡片 3（96×120px）。 */
  size?: number;
  gender?: SpriteGender | null;
  appearanceSeed?: number | null;
  god?: boolean;
  facing?: 'up' | 'down' | 'left' | 'right';
  /** 头顶常驻状态条（G2.6 规格 §4.3：绿=正常/黄=警告/红=异常，高 3px 不带数字）。
   *  null = 不摆（名册卡等非画布场景）。 */
  bar?: BarTone | null;
}) {
  const appearance = spriteAppearance(appearanceSeed ?? 0, gender ?? 'male', archetype, god);
  const frames = SKIN_STATUS_FRAMES[status];
  return (
    <div
      className="rpg-sprite"
      style={{ width: WIDTH * PX * size, height: HEIGHT * PX * size, position: 'relative', flexShrink: 0 }}
      aria-hidden
    >
      {bar != null && (
        <div
          style={{ position: 'absolute', top: -5, left: '12%', right: '12%', height: 3, background: BAR_TONES[bar], opacity: 0.92 }}
          aria-hidden
        />
      )}
      <div style={{ width: WIDTH * PX, height: HEIGHT * PX, transform: `scale(${size})`, transformOrigin: 'top left' }}>
        <div style={{ width: WIDTH * PX, height: HEIGHT * PX, position: 'relative', animation: `${frames.bob} ${frames.frames * frames.stepMs}ms steps(${frames.frames}) infinite` }}>
          <Body appearance={appearance} facing={facing} />
        </div>
      </div>
    </div>
  );
}

function Body({ appearance: a, facing }: { appearance: Appearance; facing: 'up' | 'down' | 'left' | 'right' }) {
  const side = facing === 'left' || facing === 'right';
  const back = facing === 'up';
  return (
    <>
      {/* Q 版比例（参考图：大头小身 + 两格腿）：头占上半 ~10 行，短袍只四行。
          落地影在脚底，脚跟是对齐 tile 的唯一锚点。 */}
      <div style={cell('rgba(26,23,33,0.35)', 3, 19, 10)} />
      <div className="rpg-foot rpg-foot-l" style={cell(PALETTE32.ink, 4, 17, 3, 2)} />
      <div className="rpg-foot rpg-foot-r" style={cell(PALETTE32.ink, 9, 17, 3, 2)} />
      <div style={cell(a.shade, 4, 16, 3, 1)} />
      <div style={cell(a.shade, 9, 16, 3, 1)} />
      {/* 短袍（rows 12-15）+ 腰带 + 下摆暗缘 */}
      <div style={cell(a.robe, 4, 12, 8, 4)} />
      <div style={cell(a.belt, 4, 14, 8, 1)} />
      <div style={cell(a.shade, 4, 15, 8, 1)} />
      {/* 正面交领 V 字；背面只留领后暗缝 */}
      {back ? <div style={cell(a.shade, 6, 12, 4, 1)} /> : (
        <>
          <div style={cell(a.shade, 5, 12, 2, 1)} />
          <div style={cell(a.shade, 9, 12, 2, 1)} />
        </>
      )}
      {/* 两袖（带缝色分层）与露出的手 */}
      <div style={cell(a.shade, 2, 12, 2, 3 + (a.sleeveStyle ? 1 : 0))} />
      <div style={cell(a.robe, 2, 13, 2, 2)} />
      <div style={cell(a.shade, 12, 12, 2, 3 + (a.sleeveStyle ? 1 : 0))} />
      <div style={cell(a.robe, 12, 13, 2, 2)} />
      <div style={cell(a.complexion, 2, 15, 2, 1)} />
      <div style={cell(a.complexion, 12, 15, 2, 1)} />
      {/* 脖颈 */}
      <div style={cell(a.complexion, 7, 11, 2, 1)} />
      {/* 大脑袋：深色发底块 + 性别分形（女 = 发髻 + 垂发 + 金簪；男 = 发带头带），
          发髻层次随 seed 改变；性别只控制发型，不影响身体能力。 */}
      <div style={cell(PALETTE32.ink, 4, 2, 8, 9)} />
      {a.gender === 'female' ? (
        <>
          <div style={cell(a.hair, 5, 1, 6, 2)} />
          <div style={cell(a.hair, a.hairStyle === 1 ? 5 : 7, 0, 4, 2)} />
          <div style={cell(a.hair, 3, 4, 2, a.hairStyle === 2 ? 8 : 7)} />
          <div style={cell(a.hair, 11, 4, 2, a.hairStyle === 2 ? 8 : 7)} />
          <div style={cell(PALETTE32.gold, 8, 1, 1)} />
        </>
      ) : (
        <>
          <div style={cell(a.hair, 5, 1, 6, 2)} />
          <div style={cell(a.hair, 6, 0, 4, 2)} />
          <div style={cell(a.hair, 3, 3, 2, 5)} />
          <div style={cell(a.hair, 11, 3, 2, 5)} />
          <div style={cell(a.belt, 6, 1, 4, 1)} />
        </>
      )}
      {/* 脸（比旧版大一圈：cols 5-10 × rows 4-10） */}
      <div style={cell(a.complexion, 5, 4, 6, 7)} />
      {!back && (side ? (
        <div style={cell(PALETTE32.ink, facing === 'right' ? 9 : 6, 7, 1, 1)} />
      ) : (
        <>
          <div style={cell(PALETTE32.ink, 6, 7)} />
          <div style={cell(PALETTE32.ink, 9, 7)} />
          <div style={cell(PALETTE32.blush, 5, 8)} />
          <div style={cell(PALETTE32.blush, 10, 8)} />
        </>
      ))}
      {a.prop != null && <div style={cell(a.prop, 14, 12, 1, 4)} />}
    </>
  );
}

export function SessionSprite({
  archetype,
  sessionStatus,
  size,
  gender,
  appearanceSeed,
}: {
  archetype: string | null | undefined;
  sessionStatus: Parameters<typeof gameStatusOf>[0];
  size?: number;
  gender?: SpriteGender | null;
  appearanceSeed?: number | null;
}) {
  const game = gameStatusOf(sessionStatus);
  return <CharacterSprite archetype={archetype} status={game} size={size} gender={gender} appearanceSeed={appearanceSeed} />;
}

const GOD_APPEARANCE_KEY = 'weave.rpg.god-appearance';
const GOD_APPEARANCE_EVENT = 'weave:rpg-god-appearance';
interface GodAppearance { gender: SpriteGender; appearanceSeed: number }

function randomGodAppearance(gender?: SpriteGender): GodAppearance {
  const values = crypto.getRandomValues(new Uint32Array(2));
  return { gender: gender ?? (values[0]! % 2 ? 'female' : 'male'), appearanceSeed: values[1]! & 0x7fffffff };
}

function readGodAppearance(): GodAppearance | null {
  try {
    const value = JSON.parse(localStorage.getItem(GOD_APPEARANCE_KEY) ?? 'null') as GodAppearance | null;
    return value && (value.gender === 'male' || value.gender === 'female') && Number.isInteger(value.appearanceSeed)
      && value.appearanceSeed >= 0 && value.appearanceSeed <= 0x7fffffff ? value : null;
  } catch { return null; }
}

function useGodAppearance() {
  const [appearance, setAppearance] = useState<GodAppearance>(() => readGodAppearance() ?? { gender: 'male', appearanceSeed: 0 });
  // 存储禁用时落本页内存档（外观仍稳定），编辑面明说「仅本次有效」不静默。
  const [persisted, setPersisted] = useState(true);
  useEffect(() => {
    const saved = readGodAppearance();
    if (saved) setAppearance(saved);
    else {
      const next = randomGodAppearance();
      try {
        localStorage.setItem(GOD_APPEARANCE_KEY, JSON.stringify(next));
      } catch {
        setPersisted(false);
      }
      setAppearance(next);
    }
    const sync = () => {
      const value = readGodAppearance();
      if (value) {
        setAppearance(value);
        setPersisted(true);
      }
    };
    window.addEventListener('storage', sync);
    window.addEventListener(GOD_APPEARANCE_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(GOD_APPEARANCE_EVENT, sync);
    };
  }, []);
  const save = (next: GodAppearance) => {
    try {
      localStorage.setItem(GOD_APPEARANCE_KEY, JSON.stringify(next));
      setPersisted(true);
    } catch {
      setPersisted(false);
    }
    setAppearance(next);
    window.dispatchEvent(new Event(GOD_APPEARANCE_EVENT));
  };
  return { appearance, persisted, save };
}

export function GodSprite({
  size = 0.75,
  facing = 'down',
  bar = 'ok',
}: {
  size?: number;
  facing?: 'up' | 'down' | 'left' | 'right';
  /** 常驻状态条（规格 §4.3：上帝化身头顶绿色）。 */
  bar?: BarTone | null;
}) {
  const { appearance } = useGodAppearance();
  return (
    <div className="rpg-god-mark relative">
      <CharacterSprite archetype={null} status="idle" size={size} god facing={facing} bar={bar} {...appearance} />
    </div>
  );
}

export function GodAppearanceEditor() {
  const t = useT();
  const { appearance, persisted, save } = useGodAppearance();
  const [error, setError] = useState('');
  const apply = (next: GodAppearance) => {
    try { save(next); setError(''); } catch (e) { setError(String(e)); }
  };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 border-b border-[var(--w-border)] pb-3">
      <GodSprite size={1.5} />
      <div className="flex flex-col gap-2">
        <span className="text-xs text-[var(--w-text)]">{t('rpg.godAppearance')}</span>
        <div className="flex flex-wrap gap-1">
          {(['male', 'female'] as const).map((gender) => (
            <button type="button" key={gender} aria-pressed={appearance.gender === gender}
              onClick={() => apply({ ...appearance, gender })}
              className={'rounded px-2 py-1 text-xs ' + (appearance.gender === gender ? 'bg-[var(--w-accent)] text-white' : 'bg-[var(--w-surface-2)] text-[var(--w-text-dim)]')}>
              {t(gender === 'male' ? 'rpg.genderMale' : 'rpg.genderFemale')}
            </button>
          ))}
          <button type="button" onClick={() => apply(randomGodAppearance(appearance.gender))}
            className="rounded bg-[var(--w-surface-2)] px-2 py-1 text-xs text-[var(--w-text)]">{t('rpg.appearanceRandomize')}</button>
        </div>
        {error && <span role="alert" className="text-xs text-red-400">{error}</span>}
        {!persisted && <span className="text-[11px] text-amber-500">{t('rpg.godAppearanceEphemeral')}</span>}
      </div>
    </div>
  );
}

export { GAME_STATUS_ANIM };
