/**
 * 精灵动画引擎（pet 页）：PET_SPRITE_CONTRACT 镜像驱动（web 运行时不能 import
 * core 值——import type 纪律，先例 tasks/lifecycle.ts）。
 *
 * 播放模式与 codex 同法：主循环整段播 N 遍后回落 idle 段循环；idle 自身是
 * 主循环（durationsMs 逐帧给时长，其余行统一 frameMs、末帧 finalMs 停留）。
 */

/** mirror of `PET_SPRITE_CONTRACT.animations` in weave-core/src/harness.ts — 保持同步。 */
export const PET_ANIMATIONS = {
  idle: { row: 0, frames: 6, durationsMs: [1680, 660, 660, 840, 840, 1920] },
  'running-right': { row: 1, frames: 8, frameMs: 120, finalMs: 220 },
  'running-left': { row: 2, frames: 8, frameMs: 120, finalMs: 220 },
  waving: { row: 3, frames: 4, frameMs: 140, finalMs: 280 },
  jumping: { row: 4, frames: 5, frameMs: 140, finalMs: 280 },
  failed: { row: 5, frames: 8, frameMs: 140, finalMs: 240 },
  waiting: { row: 6, frames: 6, frameMs: 150, finalMs: 260 },
  running: { row: 7, frames: 6, frameMs: 120, finalMs: 220 },
  review: { row: 8, frames: 6, frameMs: 150, finalMs: 280 },
} as const;

export type PetAnimation = keyof typeof PET_ANIMATIONS;

/** mirror of `PET_SPRITE_CONTRACT` 网格常量 — 保持同步。 */
export const SPRITE_GRID = {
  cellWidth: 192,
  cellHeight: 208,
  columns: 8,
};

/** 主循环整段播放遍数（codex 同款：×3 后接 idle 帧回落）。 */
const MAIN_LOOPS = 3;

interface Playhead {
  anim: PetAnimation;
  /** 当前段内第几遍主循环（idle 恒 0）。 */
  loop: number;
  frame: number;
  /** 本帧起始时刻（performance.now()）。 */
  frameStartedAt: number;
}

/** 某 anim 某帧的停留时长（ms）。 */
function frameDuration(anim: PetAnimation, frame: number): number {
  const spec = PET_ANIMATIONS[anim] as {
    frames: number;
    durationsMs?: readonly number[];
    frameMs?: number;
    finalMs?: number;
  };
  if (spec.durationsMs) return spec.durationsMs[frame] ?? spec.finalMs ?? 600;
  return frame === spec.frames - 1 ? (spec.finalMs ?? 600) : (spec.frameMs ?? 150);
}

/** 推进 playhead 一帧：主循环 ×MAIN_LOOPS 后回落 idle。 */
function advance(head: Playhead): void {
  const spec = PET_ANIMATIONS[head.anim];
  head.frame += 1;
  if (head.frame < spec.frames) return;
  head.frame = 0;
  if (head.anim === 'idle') return; // idle 自循环
  head.loop += 1;
  if (head.loop >= MAIN_LOOPS) {
    head.anim = 'idle';
    head.loop = 0;
  }
}

export interface SpritePlayer {
  /** 切动画（同名不重置——running 中重复 setRunning 不打断步伐）。 */
  play(anim: PetAnimation): void;
  /** 当前动画名。 */
  current(): PetAnimation;
  /** 按契约时长表自走的帧游标；rAF 循环里每拍调，返回当前帧下标。 */
  tick(now: number): number;
}

export function createSpritePlayer(initial: PetAnimation = 'idle'): SpritePlayer {
  let head: Playhead = { anim: initial, loop: 0, frame: 0, frameStartedAt: performance.now() };
  return {
    play(anim) {
      if (head.anim === anim) return;
      head = { anim, loop: 0, frame: 0, frameStartedAt: performance.now() };
    },
    current() {
      return head.anim;
    },
    tick(now) {
      let guard = 0;
      while (now - head.frameStartedAt >= frameDuration(head.anim, head.frame) && guard < 64) {
        advance(head);
        head.frameStartedAt += frameDuration(head.anim, head.frame);
        // 追帧兜底：落后太多（后台节流回来）直接对齐当下，不连环快放
        if (now - head.frameStartedAt > 5_000) head.frameStartedAt = now;
        guard += 1;
      }
      return head.frame;
    },
  };
}

/**
 * 把 spritesheet 的某帧画上 canvas（整图缩放到画布、按网格取单元）。
 * prefers-reduced-motion 由调用方决定：静止时只画第 0 帧、不启 rAF。
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  sheet: HTMLImageElement,
  anim: PetAnimation,
  frame: number,
): void {
  const spec = PET_ANIMATIONS[anim];
  const col = Math.min(frame, SPRITE_GRID.columns - 1);
  const sx = col * SPRITE_GRID.cellWidth;
  const sy = spec.row * SPRITE_GRID.cellHeight;
  const canvas = ctx.canvas;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(sheet, sx, sy, SPRITE_GRID.cellWidth, SPRITE_GRID.cellHeight, 0, 0, canvas.width, canvas.height);
}
