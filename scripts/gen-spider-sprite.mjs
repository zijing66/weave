#!/usr/bin/env node
// 程序化生成内置默认宠 weave-spider 的精灵图（codex v2 契约：8 列 × 9 行标准
// 动画、单元 192×208、整图 1536×1872）。零依赖：RGBA 直编 PNG（zlib deflate）。
// 资产入库 packages/weave-templates/src/resources/pets/weave-spider/，
// daemon 启动时缺失才播种到 <data>/pets/。改画风重跑本脚本即可。
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 网格（unit 制）与调色板
// ---------------------------------------------------------------------------

const U = 4; // 像素单元（chunky 像素风）
const CELL_W = 192;
const CELL_H = 208;
const GW = CELL_W / U; // 48
const GH = CELL_H / U; // 52
const COLS = 8;

// 帧规格来自 core PET_SPRITE_CONTRACT.animations（镜像，改那边同步这里）
const ROWS = {
  idle: { row: 0, frames: 6 },
  'running-right': { row: 1, frames: 8 },
  'running-left': { row: 2, frames: 8 },
  waving: { row: 3, frames: 4 },
  jumping: { row: 4, frames: 5 },
  failed: { row: 5, frames: 8 },
  waiting: { row: 6, frames: 6 },
  running: { row: 7, frames: 6 },
  review: { row: 8, frames: 6 },
};

// idx → [r,g,b,a]：1 描边/四肢剪影 2 身体主色 3 腹侧暗部 4 高光斑
// 5 眼白 6 瞳孔 7 蛛丝 8 腮红 9/10 地面投影（浓/淡）
const PALETTE = [
  [0, 0, 0, 0],
  [25, 19, 34, 255],
  [61, 48, 84, 255],
  [43, 33, 64, 255],
  [96, 78, 132, 255],
  [242, 236, 255, 255],
  [25, 19, 34, 255],
  [216, 205, 242, 255],
  [181, 127, 184, 255],
  [12, 9, 18, 88],
  [12, 9, 18, 46],
];
const C = {
  OUTLINE: 1, BODY: 2, SHADE: 3, HIGHLIGHT: 4, EYEWHITE: 5,
  PUPIL: 6, SILK: 7, BLUSH: 8, SHADOW: 9, SHADOW_WEAK: 10,
};

// ---------------------------------------------------------------------------
// 栅格绘图原语（unit 坐标，半开采样保持像素齐整）
// ---------------------------------------------------------------------------

function blank() {
  return new Uint8Array(GW * GH);
}

function px(g, x, y, c) {
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= GW || y >= GH) return;
  g[y * GW + x] = c;
}

function ellipse(g, cx, cy, rx, ry, c) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) px(g, x, y, c);
    }
  }
}

/** 折线圆头笔画：halfW 为半径（unit）。 */
function inkPoly(g, pts, halfW, c) {
  const r2 = halfW * halfW;
  for (let s = 0; s < pts.length - 1; s++) {
    const [x1, y1] = pts[s];
    const [x2, y2] = pts[s + 1];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.ceil(len * 2));
    for (let t = 0; t <= steps; t++) {
      const cx = x1 + ((x2 - x1) * t) / steps;
      const cy = y1 + ((y2 - y1) * t) / steps;
      for (let y = Math.floor(cy - halfW); y <= Math.ceil(cy + halfW); y++) {
        for (let x = Math.floor(cx - halfW); x <= Math.ceil(cx + halfW); x++) {
          const dx = x + 0.5 - cx;
          const dy = y + 0.5 - cy;
          if (dx * dx + dy * dy <= r2) px(g, x, y, c);
        }
      }
    }
  }
}

function disc(g, x, y, r, c) {
  ellipse(g, x, y, r, r, c);
}

// ---------------------------------------------------------------------------
// 蜘蛛解剖常量与姿态
// ---------------------------------------------------------------------------

const CX = 24; // 体轴
const GROUND = 46; // 脚底落点
const HEAD_CY = 19;
const HEAD_RX = 5;
const HEAD_RY = 4;
const AB_CY = 32;
const AB_RX = 7;
const AB_RY = 8;
const SHOULDER_X = HEAD_RX - 1;

// 每侧四条腿（前→后）：膝大幅外拱（蜘蛛标志性的 ∧ 形）、足外张落地
const LEG_SPEC = [
  { kx: 8, ky: 10, fx: 11 },
  { kx: 11, ky: 12, fx: 15 },
  { kx: 12, ky: 15, fx: 16 },
  { kx: 9, ky: 17, fx: 12 },
];
const SHOULDER_YS = [17, 18.5, 20, 20.5];

/** 一条腿三点（side=-1 左 / +1 右）：stride 前后迈、lift 抬脚、kneeDip 膝沉。 */
function legPoints(i, side, stride, lift, kneeDip) {
  const spec = LEG_SPEC[i];
  return [
    [CX + side * SHOULDER_X, SHOULDER_YS[i]],
    [CX + side * spec.kx, spec.ky + kneeDip],
    [CX + side * spec.fx - side * stride, GROUND - lift],
  ];
}

function standingLegs(opt = {}) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    for (const side of [-1, 1]) {
      out.push(legPoints(i, side, opt.stride?.[i] ?? 0, opt.lift?.[i] ?? 0, opt.kneeDip ?? 0));
    }
  }
  return out;
}

/**
 * 站姿整只：八腿（剪影色）→ 腹部 → 头胸 → 表情。dx/dy 平移、gazeX/Y 视线、
 * blink 眨眼、deadEyes X 眼。
 */
function drawSpider(g, pose) {
  const { dx = 0, dy = 0, legs, gazeX = 0, gazeY = 0, blink = false, deadEyes = false } = pose;

  if (pose.airborne) {
    ellipse(g, CX, GROUND + 2, 6, 1.2, C.SHADOW_WEAK);
  } else {
    ellipse(g, CX + dx, GROUND + 2, 8, 1.4, C.SHADOW);
  }

  for (const lp of legs) inkPoly(g, lp, 0.7, C.OUTLINE);

  ellipse(g, CX + dx, AB_CY + dy, AB_RX + 0.7, AB_RY + 0.7, C.OUTLINE);
  ellipse(g, CX + dx, AB_CY + dy, AB_RX, AB_RY, C.BODY);
  ellipse(g, CX + dx, AB_CY + dy + AB_RY * 0.45, AB_RX * 0.75, AB_RY * 0.45, C.SHADE);
  ellipse(g, CX + dx - AB_RX * 0.35, AB_CY + dy - AB_RY * 0.35, AB_RX * 0.38, AB_RY * 0.3, C.HIGHLIGHT);

  ellipse(g, CX + dx, HEAD_CY + dy, HEAD_RX + 0.7, HEAD_RY + 0.7, C.OUTLINE);
  ellipse(g, CX + dx, HEAD_CY + dy, HEAD_RX, HEAD_RY, C.BODY);
  ellipse(g, CX + dx, HEAD_CY + dy - HEAD_RY * 0.35, HEAD_RX * 0.55, HEAD_RY * 0.35, C.HIGHLIGHT);

  const eyeY = HEAD_CY + dy - 0.4;
  for (const ex of [CX - 2.2, CX + 2.2]) {
    const exx = ex + dx + gazeX * 0.9;
    if (deadEyes) {
      inkPoly(g, [[exx - 1.1, eyeY - 1.1], [exx + 1.1, eyeY + 1.1]], 0.4, C.OUTLINE);
      inkPoly(g, [[exx - 1.1, eyeY + 1.1], [exx + 1.1, eyeY - 1.1]], 0.4, C.OUTLINE);
      continue;
    }
    ellipse(g, exx, eyeY, 1.15, blink ? 0.4 : 1.15, C.EYEWHITE);
    if (!blink) disc(g, exx + gazeX * 0.5, eyeY + gazeY * 0.5 + 0.15, 0.65, C.PUPIL);
  }
}

// ---------------------------------------------------------------------------
// 各行动画（f = 帧下标）
// ---------------------------------------------------------------------------

function poseIdle(f) {
  const breathe = [0, 0.45, 0.75, 0.45, 0.15, 0.3][f] ?? 0;
  return {
    dy: breathe,
    legs: standingLegs({ kneeDip: breathe * 0.55 }),
    blink: f === 4,
  };
}

/** 侧跑（dir=-1 左 / +1 右）：两组对相腿相位交替 + 身体起伏。 */
function poseRunSide(f, dir) {
  const phi = (f / 8) * Math.PI * 2;
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  const stride = [s * 3, -s * 3, -s * 3, s * 3];
  const lift = [-Math.min(0, c) * 2, Math.min(0, c) * 2, Math.min(0, c) * 2, -Math.min(0, c) * 2];
  return {
    dx: dir * 1,
    dy: Math.abs(s) * 0.7,
    legs: standingLegs({ stride, lift }),
    gazeX: dir * 0.8,
  };
}

/** 忙碌跑（正面原地碎步）：待答/运行中之间用。 */
function poseRunning(f) {
  const phi = (f / 6) * Math.PI * 2;
  const s = Math.sin(phi);
  return {
    dy: Math.abs(s) * 0.9,
    legs: standingLegs({ stride: [s * 1.6, -s * 1.6, -s * 1.6, s * 1.6] }),
    gazeX: s * 0.4,
  };
}

function poseWaving(f) {
  const phi = (f / 4) * Math.PI * 2;
  const legs = standingLegs({});
  const wx = CX + 7 + Math.sin(phi) * 1.6;
  const wy = HEAD_CY - 7 - Math.abs(Math.cos(phi));
  legs[1] = [
    [CX + SHOULDER_X, SHOULDER_YS[0]],
    [CX + 6, HEAD_CY - 4],
    [wx, wy],
  ];
  return { dy: Math.sin(phi) * 0.25, legs };
}

const JUMP_DY = [1, -4, -9, -3, 1];
const JUMP_LIFTS = [
  [0, 0, 0, 0],
  [3, 3, 3, 3],
  [6, 7, 7, 6],
  [2, 3, 3, 2],
  [0, 0, 0, 0],
];

function poseJumping(f) {
  return {
    dy: JUMP_DY[f],
    legs: standingLegs({ lift: JUMP_LIFTS[f] }),
    airborne: f === 1 || f === 2 || f === 3,
    gazeY: f === 2 ? -0.7 : f === 3 ? 0.5 : 0,
  };
}

/** 翻肚 KO：腹朝上横躺、腿朝天抽搐渐歇、X 眼。 */
function poseFailed(f) {
  const g = blank();
  const amp = (f < 4 ? 1 : (7 - f) / 3) * 1.2;
  ellipse(g, CX, GROUND + 2, 9, 1.4, C.SHADOW);
  // 朝天乱蹬的腿（四对圆头折线，端点随 f 抖动）
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const bx = 27 + side * (5 - i * 2.2);
      const phase = Math.sin((f / 8) * Math.PI * 2 + i * 1.4) * amp;
      const tipX = bx + side * (1.5 + phase);
      const tipY = GROUND - 6 - 4 + i - Math.abs(phase);
      inkPoly(g, [[bx, GROUND - 4 + i * 0.4], [tipX, tipY]], 0.55, C.OUTLINE);
    }
  }
  // 躺平的腹部（略偏右）+ 腹纹
  ellipse(g, 27, 41, 8.7, 5.7, C.OUTLINE);
  ellipse(g, 27, 41, 8, 5, C.BODY);
  ellipse(g, 27, 43.2, 6, 2.2, C.SHADE);
  ellipse(g, 24.5, 39, 3, 1.8, C.HIGHLIGHT);
  // X 眼 + 腮红贴在横躺的「头端」
  for (const ex of [16.5, 21]) {
    inkPoly(g, [[ex - 1, 40 - 1], [ex + 1, 40 + 1]], 0.35, C.OUTLINE);
    inkPoly(g, [[ex - 1, 40 + 1], [ex + 1, 40 - 1]], 0.35, C.OUTLINE);
  }
  disc(g, 14.5, 42, 0.55, C.BLUSH);
  disc(g, 22.8, 42, 0.55, C.BLUSH);
  return g;
}

/** 前腿合十（等待你的回答）：两前腿在胸前并拢、身体微前倾。 */
function poseWaiting(f) {
  const phi = (f / 6) * Math.PI * 2;
  const legs = standingLegs({ kneeDip: 0.4 });
  const tipX = CX + Math.sin(phi) * 0.35;
  const tipY = HEAD_CY + 2.5 + Math.sin(phi) * 0.3;
  legs[0] = [[CX - SHOULDER_X, SHOULDER_YS[0]], [CX - 3.5, HEAD_CY + 1], [tipX - 0.4, tipY]];
  legs[1] = [[CX + SHOULDER_X, SHOULDER_YS[0]], [CX + 3.5, HEAD_CY + 1], [tipX + 0.4, tipY]];
  return { dy: 0.3, legs, gazeX: Math.sin(phi) * 0.3 };
}

/** 织网检视（刚完成）：吐丝 + 头顶斜上拉出一小片网。 */
function poseReview(f) {
  const g = blank();
  const s = Math.sin((f / 6) * Math.PI * 2);
  // 网骨：右上角三根辐条 + 两道弧
  const webX = 38;
  const webY = 9;
  for (const a of [0.3, 1.2, 2.1]) {
    inkPoly(g, [[webX, webY], [webX - Math.cos(a) * 8, webY + Math.sin(a) * 8]], 0.3, C.SILK);
  }
  for (const r of [3.5, 6.5]) {
    const r2 = r * r;
    for (let t = 0; t <= 14; t++) {
      const a = 0.3 + ((2.1 - 0.3) * t) / 14;
      const x = webX - Math.cos(a) * r;
      const y = webY + Math.sin(a) * r;
      px(g, x, y, C.SILK);
    }
  }
  // 吐丝线：嘴 → 网心
  inkPoly(g, [[CX + 2, HEAD_CY + 3], [webX - 5, webY + 4]], 0.28, C.SILK);
  const legs = standingLegs({
    stride: [s * 0.8, -s * 0.8, -s * 0.8, s * 0.8],
  });
  drawSpiderInto(g, { legs, dy: Math.abs(s) * 0.4, gazeX: 0.8, gazeY: -0.4 });
  return g;
}

/** 同 drawSpider 但画进指定栅格（poseReview 里先铺了网）。 */
function drawSpiderInto(g, pose) {
  const { dx = 0, dy = 0, legs, gazeX = 0, gazeY = 0, blink = false, deadEyes = false } = pose;
  ellipse(g, CX + dx, GROUND + 2, 8, 1.4, C.SHADOW);
  for (const lp of legs) inkPoly(g, lp, 0.55, C.OUTLINE);
  ellipse(g, CX + dx, AB_CY + dy, AB_RX + 0.7, AB_RY + 0.7, C.OUTLINE);
  ellipse(g, CX + dx, AB_CY + dy, AB_RX, AB_RY, C.BODY);
  ellipse(g, CX + dx, AB_CY + dy + AB_RY * 0.45, AB_RX * 0.75, AB_RY * 0.45, C.SHADE);
  ellipse(g, CX + dx - AB_RX * 0.35, AB_CY + dy - AB_RY * 0.35, AB_RX * 0.38, AB_RY * 0.3, C.HIGHLIGHT);
  ellipse(g, CX + dx, HEAD_CY + dy, HEAD_RX + 0.7, HEAD_RY + 0.7, C.OUTLINE);
  ellipse(g, CX + dx, HEAD_CY + dy, HEAD_RX, HEAD_RY, C.BODY);
  ellipse(g, CX + dx, HEAD_CY + dy - HEAD_RY * 0.35, HEAD_RX * 0.55, HEAD_RY * 0.35, C.HIGHLIGHT);
  const eyeY = HEAD_CY + dy - 0.6;
  for (const ex of [CX - 2.6, CX + 2.6]) {
    const exx = ex + dx + gazeX * 0.9;
    if (deadEyes) {
      inkPoly(g, [[exx - 1, eyeY - 1], [exx + 1, eyeY + 1]], 0.35, C.OUTLINE);
      inkPoly(g, [[exx - 1, eyeY + 1], [exx + 1, eyeY - 1]], 0.35, C.OUTLINE);
      continue;
    }
    ellipse(g, exx, eyeY, 0.95, blink ? 0.35 : 0.95, C.EYEWHITE);
    if (!blink) disc(g, exx + gazeX * 0.45, eyeY + gazeY * 0.45, 0.55, C.PUPIL);
  }
  disc(g, CX + dx - 4.4, eyeY + 1.6, 0.55, C.BLUSH);
  disc(g, CX + dx + 4.4, eyeY + 1.6, 0.55, C.BLUSH);
}

const POSE_FN = {
  idle: poseIdle,
  'running-right': (f) => poseRunSide(f, 1),
  'running-left': (f) => poseRunSide(f, -1),
  waving: poseWaving,
  jumping: poseJumping,
  failed: poseFailed,
  waiting: poseWaiting,
  running: poseRunning,
  review: poseReview,
};

// ---------------------------------------------------------------------------
// 组装精灵图
// ---------------------------------------------------------------------------

/** 全部行 × 帧 → 单个 RGBA 缓冲（1536×1872；unit 网格放大 U 倍）。 */
function buildSheet() {
  const W = COLS * CELL_W;
  const H = Object.keys(ROWS).length * CELL_H;
  const out = new Uint8Array(W * H * 4);
  for (const [name, spec] of Object.entries(ROWS)) {
    const fn = POSE_FN[name];
    for (let f = 0; f < spec.frames; f++) {
      const drawn = fn(f);
      // poseFailed/poseReview 直接返回画好的栅格；其余返回 pose 对象 → 站姿渲染
      const g = drawn instanceof Uint8Array ? drawn : (() => {
        const gg = blank();
        drawSpiderInto(gg, drawn);
        return gg;
      })();
      const ox = f * CELL_W;
      const oy = spec.row * CELL_H;
      for (let y = 0; y < GH; y++) {
        for (let x = 0; x < GW; x++) {
          const c = PALETTE[g[y * GW + x]] ?? PALETTE[0];
          for (let uy = 0; uy < U; uy++) {
            for (let ux = 0; ux < U; ux++) {
              const di = ((oy + y * U + uy) * W + ox + x * U + ux) * 4;
              out[di] = c[0];
              out[di + 1] = c[1];
              out[di + 2] = c[2];
              out[di + 3] = c[3];
            }
          }
        }
      }
    }
  }
  return { buf: out, width: W, height: H };
}

// ---------------------------------------------------------------------------
// 零依赖 PNG 编码
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes) {
  let c = -1;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 每行前缀 filter 0 的原始流
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    );
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(
  repoRoot,
  'packages',
  'weave-templates',
  'src',
  'resources',
  'pets',
  'weave-spider',
);

const { buf, width, height } = buildSheet();
const png = encodePng(buf, width, height);
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'spritesheet.png'), png);
writeFileSync(
  path.join(outDir, 'pet.json'),
  `${JSON.stringify(
    {
      id: 'weave-spider',
      displayName: 'Weave Spider',
      description: 'The default weave pet — a small spider that weaves alongside you.',
      spriteVersionNumber: 1,
      spritesheetPath: 'spritesheet.png',
    },
    null,
    2,
  )}\n`,
);
console.log(`[gen-spider-sprite] ${width}x${height} png (${(png.length / 1024).toFixed(0)} KB) -> ${path.relative(repoRoot, outDir)}`);
