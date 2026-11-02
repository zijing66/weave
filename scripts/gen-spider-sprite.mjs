#!/usr/bin/env node
// 程序化生成内置默认宠 weave-spider 的精灵图（codex v2 契约：8 列 × 11 行
// 动画、单元 192×208、整图 1536×2288）。零依赖：RGBA 直编 PNG（zlib deflate）。
//
// 视角 = 第三人称 RPG 顶视（3/4 俯角）：腹在后（画面上方）、头胸在前（下方），
// 八腿向四周铺开、脚下有落地投影——不是正视图。结网行（review）= 一张静态网，
// 缩小的小蜘蛛在网上面爬。
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
  enter: { row: 9, frames: 8 },
  sleep: { row: 10, frames: 6 },
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
// 蜘蛛解剖常量与姿态（3/4 顶视：腹在后上、头胸在前下）
// ---------------------------------------------------------------------------

const CX = 24; // 体轴
const GROUND = 47; // 近端脚底落点（远端脚在更高处，透视使然）
const AB_CY = 29; // 腹（后）
const AB_RX = 9;
const AB_RY = 8;
const HEAD_CY = 38.5; // 头胸（前，离镜头更近）
const HEAD_RX = 6.4;
const HEAD_RY = 5.4;

// 每侧四条腿（前→后）：肩在头胸两侧，膝外拱，足落在「地面投影」的远→近一线上。
// fy 越大 = 越靠近镜头（画面越下）。
const LEG_SPEC = [
  { sx: 3.6, sy: 40.2, kx: 9.5, ky: 38.5, fx: 8.5, fy: 46.5 }, // 前（朝镜头）
  { sx: 4.4, sy: 39.2, kx: 14.5, ky: 35.0, fx: 16.5, fy: 46.0 }, // 前侧
  { sx: 4.4, sy: 37.6, kx: 16.5, ky: 29.0, fx: 20.0, fy: 41.0 }, // 后侧
  { sx: 3.6, sy: 36.4, kx: 13.5, ky: 24.0, fx: 15.5, fy: 34.0 }, // 后（远离镜头）
];

/** 腿画两遍：深色外轮廓 + 体色芯——纯深色腿在深色桌面上会消失。 */
function drawLegs(g, legs) {
  for (const lp of legs) inkPoly(g, lp, 0.95, C.OUTLINE);
  for (const lp of legs) inkPoly(g, lp, 0.5, C.BODY);
}

/** 一条腿三点（side=-1 左 / +1 右）：stride 前后迈、lift 抬脚、kneeDip 膝沉。 */
function legPoints(i, side, stride, lift, kneeDip) {
  const spec = LEG_SPEC[i];
  return [
    [CX + side * spec.sx, spec.sy],
    [CX + side * spec.kx, spec.ky + kneeDip],
    [CX + side * spec.fx - side * stride, spec.fy - lift],
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
 * 站姿整只（3/4 顶视）：落地投影 → 八腿 → 腹（后）→ 头胸（前）→ 表情。
 * dx/dy 平移、gazeX/Y 视线、blink 眨眼、deadEyes X 眼。
 */
function drawSpiderInto(g, pose) {
  const { dx = 0, dy = 0, legs, gazeX = 0, gazeY = 0, blink = false, deadEyes = false } = pose;

  if (!pose.noShadow) {
    if (pose.airborne) {
      ellipse(g, CX, GROUND - 1, 7, 1.1, C.SHADOW_WEAK);
    } else {
      ellipse(g, CX + dx, GROUND - 1, 11, 1.9, C.SHADOW);
    }
  }

  drawLegs(g, legs);

  // 腹（后）：大、圆，顶部高光、底部暗部
  ellipse(g, CX + dx, AB_CY + dy, AB_RX + 0.7, AB_RY + 0.7, C.OUTLINE);
  ellipse(g, CX + dx, AB_CY + dy, AB_RX, AB_RY, C.BODY);
  ellipse(g, CX + dx, AB_CY + dy + AB_RY * 0.5, AB_RX * 0.72, AB_RY * 0.42, C.SHADE);
  ellipse(g, CX + dx - AB_RX * 0.3, AB_CY + dy - AB_RY * 0.42, AB_RX * 0.5, AB_RY * 0.3, C.HIGHLIGHT);
  // 背面斑纹：三点（顶视才看得到的腹部花纹）
  disc(g, CX + dx - 2.6, AB_CY + dy - 2.2, 0.55, C.HIGHLIGHT);
  disc(g, CX + dx, AB_CY + dy - 3.1, 0.55, C.HIGHLIGHT);
  disc(g, CX + dx + 2.6, AB_CY + dy - 2.2, 0.55, C.HIGHLIGHT);

  // 头胸（前，压在腹上）
  ellipse(g, CX + dx, HEAD_CY + dy, HEAD_RX + 0.7, HEAD_RY + 0.7, C.OUTLINE);
  ellipse(g, CX + dx, HEAD_CY + dy, HEAD_RX, HEAD_RY, C.BODY);
  ellipse(g, CX + dx, HEAD_CY + dy - HEAD_RY * 0.42, HEAD_RX * 0.62, HEAD_RY * 0.32, C.HIGHLIGHT);

  // 眼：两只主眼朝前（画面下方），两枚小眼在上方——俯角下眼睛落在头胸前缘
  const eyeY = HEAD_CY + dy + 1.0;
  for (const ex of [CX - 2.7, CX + 2.7]) {
    const exx = ex + dx + gazeX * 1.0;
    if (deadEyes) {
      inkPoly(g, [[exx - 1.4, eyeY - 1.4], [exx + 1.4, eyeY + 1.4]], 0.45, C.OUTLINE);
      inkPoly(g, [[exx - 1.4, eyeY + 1.4], [exx + 1.4, eyeY - 1.4]], 0.45, C.OUTLINE);
      continue;
    }
    ellipse(g, exx, eyeY, 2.0, blink ? 0.45 : 2.15, C.EYEWHITE);
    if (!blink) {
      disc(g, exx + gazeX * 0.8, eyeY + gazeY * 0.8 + 0.25, 1.1, C.PUPIL);
      disc(g, exx + gazeX * 0.8 - 0.4, eyeY + gazeY * 0.8 - 0.3, 0.36, C.EYEWHITE);
    }
  }
  for (const ex of [CX - 4.7, CX + 4.7]) {
    disc(g, ex + dx, HEAD_CY + dy - 3.0, 0.7, deadEyes ? C.OUTLINE : C.EYEWHITE);
    if (!deadEyes) disc(g, ex + dx + gazeX * 0.4, HEAD_CY + dy - 3.0 + gazeY * 0.4, 0.34, C.PUPIL);
  }
}

// ---------------------------------------------------------------------------
// 各行动画（f = 帧下标）
// ---------------------------------------------------------------------------

function poseIdle(f) {
  const breathe = [0, 0.4, 0.7, 0.4, 0.12, 0.28][f] ?? 0;
  return {
    dy: breathe,
    legs: standingLegs({ kneeDip: breathe * 0.5 }),
    blink: f === 4,
  };
}

/** 侧跑（dir=-1 左 / +1 右）：对相腿交替 + 身体沿视线方向轻移。 */
function poseRunSide(f, dir) {
  const phi = (f / 8) * Math.PI * 2;
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  const stride = [s * 2.6, -s * 2.6, -s * 2.6, s * 2.6];
  const lift = [-Math.min(0, c) * 1.8, Math.min(0, c) * 1.8, Math.min(0, c) * 1.8, -Math.min(0, c) * 1.8];
  return {
    dx: dir * 1,
    dy: Math.abs(s) * 0.6,
    legs: standingLegs({ stride, lift }),
    gazeX: dir * 0.9,
  };
}

/** 忙碌跑（原地碎步）：待答/运行中之间用。 */
function poseRunning(f) {
  const phi = (f / 6) * Math.PI * 2;
  const s = Math.sin(phi);
  return {
    dy: Math.abs(s) * 0.8,
    legs: standingLegs({ stride: [s * 1.4, -s * 1.4, -s * 1.4, s * 1.4] }),
    gazeX: s * 0.4,
  };
}

function poseWaving(f) {
  const phi = (f / 4) * Math.PI * 2;
  const legs = standingLegs({});
  const wave = Math.sin(phi);
  // 前右腿抬起、朝画面上方挥（顶视里「举手」= 朝远离镜头方向伸）
  legs[1] = [
    [CX + LEG_SPEC[0].sx, LEG_SPEC[0].sy],
    [CX + 8.5, 34.5],
    [CX + 11 + wave * 1.6, 29.5 - Math.abs(wave) * 1.6],
  ];
  return { dy: Math.sin(phi) * 0.2, legs };
}

const JUMP_DY = [1, -3.5, -8, -2.5, 1];
const JUMP_LIFTS = [
  [0, 0, 0, 0],
  [2.5, 2.5, 2.5, 2.5],
  [5.5, 6.5, 6.5, 5.5],
  [2, 2.5, 2.5, 2],
  [0, 0, 0, 0],
];

function poseJumping(f) {
  return {
    dy: JUMP_DY[f],
    legs: standingLegs({ lift: JUMP_LIFTS[f] }),
    airborne: f === 1 || f === 2 || f === 3,
    gazeY: f === 2 ? -0.6 : f === 3 ? 0.4 : 0,
  };
}

/** 翻肚 KO：仰面朝天、八腿蜷曲抽动、X 眼（顶视里 = 身子压扁、腿朝上戳）。 */
function poseFailed(f) {
  const g = blank();
  const amp = (f < 4 ? 1 : (7 - f) / 3) * 1.2;
  ellipse(g, CX, GROUND - 1, 10, 1.8, C.SHADOW);
  // 压扁的腹（仰面时腹在上方摊开）+ 头胸
  ellipse(g, CX, 30, 9.6, 6.4, C.OUTLINE);
  ellipse(g, CX, 30, 8.9, 5.7, C.BODY);
  ellipse(g, CX, 31.6, 6.6, 2.6, C.SHADE);
  ellipse(g, CX - 2.6, 27.6, 3.4, 1.8, C.HIGHLIGHT);
  ellipse(g, CX, 39.5, 6.6, 4.6, C.OUTLINE);
  ellipse(g, CX, 39.5, 5.9, 3.9, C.BODY);
  // 朝天蹬的腿画在身体之后：从体侧伸出、明显高过躯干轮廓（端点随 f 抖）
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const bx = CX + side * (6.4 - i * 0.5);
      const by = 31 + i * 1.1;
      const phase = Math.sin((f / 8) * Math.PI * 2 + i * 1.4) * amp;
      drawLegs(g, [[
        [bx, by],
        [CX + side * (8.6 - i * 1.1), by - 5.4],
        [CX + side * (5.6 - i * 1.6 + phase), by - 9.2 - Math.abs(phase)],
      ]]);
    }
  }
  // X 眼
  for (const ex of [CX - 2.7, CX + 2.7]) {
    inkPoly(g, [[ex - 1, 39 - 1], [ex + 1, 39 + 1]], 0.35, C.OUTLINE);
    inkPoly(g, [[ex - 1, 39 + 1], [ex + 1, 39 - 1]], 0.35, C.OUTLINE);
  }
  disc(g, CX - 4.4, 40.5, 0.5, C.BLUSH);
  disc(g, CX + 4.4, 40.5, 0.5, C.BLUSH);
  return g;
}

/** 前腿合十（等待你的回答）：两条前腿在身前并拢、身体微前倾。 */
function poseWaiting(f) {
  const phi = (f / 6) * Math.PI * 2;
  const legs = standingLegs({ kneeDip: 0.35 });
  const tipX = CX + Math.sin(phi) * 0.3;
  const tipY = HEAD_CY + 5.2 + Math.sin(phi) * 0.25;
  legs[0] = [[CX - LEG_SPEC[0].sx, LEG_SPEC[0].sy], [CX - 5.2, HEAD_CY + 3], [tipX - 0.5, tipY]];
  legs[1] = [[CX + LEG_SPEC[0].sx, LEG_SPEC[0].sy], [CX + 5.2, HEAD_CY + 3], [tipX + 0.5, tipY]];
  return { dy: 0.25, legs, gazeX: Math.sin(phi) * 0.3 };
}

/** 缩小整只：把整格按 scale 最近邻缩到 (toX,toY) 锚点（锚点 = 体轴/腹部中心）。 */
function blitScaled(g, src, scale, toX, toY) {
  const minTx = Math.floor(toX - CX * scale);
  const maxTx = Math.ceil(toX + (GW - CX) * scale);
  const minTy = Math.floor(toY - AB_CY * scale);
  const maxTy = Math.ceil(toY + (GH - AB_CY) * scale);
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      const sx = Math.floor(CX + (tx - toX) / scale);
      const sy = Math.floor(AB_CY + (ty - toY) / scale);
      if (sx < 0 || sy < 0 || sx >= GW || sy >= GH) continue;
      const c = src[sy * GW + sx];
      if (c) px(g, tx, ty, c);
    }
  }
}

// 网：六根辐条的圆网（少量线，静态），居中、尽量铺满单元格
const WEB_HUB = [24, 26];
const WEB_RAYS = [
  [42, 26],
  [33, 39],
  [15, 39],
  [6, 26],
  [15, 13],
  [33, 13],
];
const WEB_RINGS = [0.4, 0.65, 0.88];

/** 画整张网（辐条 + 环，环首尾相连）。 */
function drawWeb(g) {
  disc(g, WEB_HUB[0], WEB_HUB[1], 0.8, C.SILK);
  for (const [ex, ey] of WEB_RAYS) {
    inkPoly(g, [[WEB_HUB[0], WEB_HUB[1]], [ex, ey]], 0.62, C.SILK);
  }
  for (const k of WEB_RINGS) {
    for (let i = 0; i < WEB_RAYS.length; i++) {
      const a = WEB_RAYS[i];
      const b = WEB_RAYS[(i + 1) % WEB_RAYS.length];
      const p1 = [WEB_HUB[0] + (a[0] - WEB_HUB[0]) * k, WEB_HUB[1] + (a[1] - WEB_HUB[1]) * k];
      const p2 = [WEB_HUB[0] + (b[0] - WEB_HUB[0]) * k, WEB_HUB[1] + (b[1] - WEB_HUB[1]) * k];
      inkPoly(g, [p1, p2], 0.52, C.SILK);
    }
  }
}

/** 小蜘蛛的爬行路线（6 帧）：踩 0.45 环各线段中点，顺时针绕网一整圈。 */
const WEB_PATH = [
  [30.1, 29.4], [24, 32.8], [17.9, 29.4], [17.9, 22.6], [24, 19.3], [30.1, 22.6],
];
/** 每帧朝向 = 指向下一站的方位（跟着路线转，不是一味看右）。 */
const WEB_GAZE = [
  [-0.8, 0.45], [-0.8, -0.45], [0, -0.9], [0.8, -0.45], [0.8, 0.45], [0, 0.9],
];
/** 缩小后整只的视觉中心（相对腹部锚点的偏移，unit）——落点按它对齐环线。 */
const VIS_CY = (AB_CY + HEAD_CY) / 2;

/**
 * 结网（运行中循环值守）：网是**静态**一整张；只有**缩小的小蜘蛛在网上面爬**
 * （主循环播完从头再爬，player 对该行 loopForever）。
 */
function poseReview(f) {
  const g = blank();
  drawWeb(g);
  // 缩小的小蜘蛛踩着网线顺时针爬（没有地面投影——它不在「地上」）
  const [ax, ay] = WEB_PATH[f];
  const [gx, gy] = WEB_GAZE[f];
  const step = Math.sin((f / 6) * Math.PI * 2);
  const small = blank();
  drawSpiderInto(small, {
    legs: standingLegs({ stride: [step * 1.2, -step * 1.2, -step * 1.2, step * 1.2] }),
    gazeX: gx,
    gazeY: gy,
    noShadow: true,
  });
  const scale = 0.4;
  blitScaled(g, small, scale, ax, ay - (VIS_CY - AB_CY) * scale);
  return g;
}

/** 折线整体平移（poseEnter 腿随身体下移用）。 */
function offsetPts(pts, ox, oy) {
  return pts.map(([x, y]) => [x + ox, y + oy]);
}

/** 入场（顺播）= 垂丝悬降（离场 = 同行倒放 = 升丝离开）：dy 大→小、腿微垂。
 * 画进自己的栅格（要额外画一根从画布顶拉下来的蛛丝）。 */
function poseEnter(f) {
  const g = blank();
  const DY = [14, 10, 6.5, 3.5, 1.5, 0.4, 0, 0];
  const dy = DY[f];
  inkPoly(g, [[CX, 0], [CX, HEAD_CY + dy - HEAD_RY - 2]], 0.3, C.SILK);
  ellipse(g, CX, GROUND - 1, dy < 2 ? 11 : 8, dy < 2 ? 1.9 : 1.4, dy < 2 ? C.SHADOW : C.SHADOW_WEAK);
  const legs = standingLegs({ lift: [1.5, 1, 0.5, 0], kneeDip: f >= 6 ? 0.7 : 0 });
  drawLegs(g, legs.map((lp) => offsetPts(lp, 0, dy)));
  // 腹
  ellipse(g, CX, AB_CY + dy, AB_RX + 0.7, AB_RY + 0.7, C.OUTLINE);
  ellipse(g, CX, AB_CY + dy, AB_RX, AB_RY, C.BODY);
  ellipse(g, CX - AB_RX * 0.3, AB_CY + dy - AB_RY * 0.42, AB_RX * 0.5, AB_RY * 0.3, C.HIGHLIGHT);
  // 头胸
  ellipse(g, CX, HEAD_CY + dy, HEAD_RX + 0.7, HEAD_RY + 0.7, C.OUTLINE);
  ellipse(g, CX, HEAD_CY + dy, HEAD_RX, HEAD_RY, C.BODY);
  const eyeY = HEAD_CY + dy + 1.0;
  for (const ex of [CX - 2.7, CX + 2.7]) {
    ellipse(g, ex, eyeY, 2.0, 2.15, C.EYEWHITE);
    disc(g, ex, eyeY + 0.25, 1.1, C.PUPIL);
    disc(g, ex - 0.4, eyeY - 0.3, 0.36, C.EYEWHITE);
  }
  for (const ex of [CX - 4.7, CX + 4.7]) disc(g, ex, HEAD_CY + dy - 3.0, 0.7, C.EYEWHITE);
  return g;
}

/** 睡觉：蜷低、闭眼（眯缝）、慢呼吸——循环值守行，播完自身循环由玩家驱动。 */
function poseSleep(f) {
  const g = blank();
  const breathe = [0, 0.5, 0.9, 0.9, 0.5, 0][f];
  ellipse(g, CX, GROUND - 1, 10, 1.7, C.SHADOW);
  ellipse(g, CX, AB_CY + 3 - breathe * 0.5, AB_RX + 0.8, (AB_RY + 0.8) * (1 + breathe * 0.05), C.OUTLINE);
  ellipse(g, CX, AB_CY + 3 - breathe * 0.5, AB_RX + 0.1, (AB_RY + 0.1) * (1 + breathe * 0.05), C.BODY);
  ellipse(g, CX, AB_CY + 3 - breathe * 0.5 - AB_RY * 0.4, AB_RX * 0.5, AB_RY * 0.3, C.HIGHLIGHT);
  // 头胸缩在腹前，眼睛闭成两道弧
  ellipse(g, CX, HEAD_CY - 1 - breathe * 0.4, HEAD_RX + 0.6, HEAD_RY * 0.85, C.OUTLINE);
  ellipse(g, CX, HEAD_CY - 1 - breathe * 0.4, HEAD_RX - 0.1, HEAD_RY * 0.8, C.BODY);
  for (const ex of [CX - 2.7, CX + 2.7]) {
    inkPoly(g, [[ex - 1.8, HEAD_CY + 0.6], [ex + 1.8, HEAD_CY + 0.6]], 0.4, C.HIGHLIGHT);
  }
  // 收在体侧的腿：贴轮廓画在身体之后，才看得出是只蜷起来的蜘蛛
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const bx = CX + side * (AB_RX - 1.4 + (i % 2) * 1.0);
      const by = AB_CY + 2 + i * 1.7;
      drawLegs(g, [[[bx, by], [bx + side * 3.0, by + 0.8]]]);
    }
  }
  // 呼吸泡：f=2/3 大泡漂在头前方，f=4/5 更小的泡飘更高
  if (f === 2 || f === 3) {
    ellipse(g, CX + HEAD_RX + 2.2, HEAD_CY + 1, f === 2 ? 1.1 : 1.5, f === 2 ? 0.9 : 1.25, C.SILK);
    ellipse(g, CX + HEAD_RX + (f === 2 ? 4.6 : 6), HEAD_CY - 2, f === 2 ? 0.65 : 1.0, C.SILK);
  } else if (f === 4) {
    ellipse(g, CX + HEAD_RX + 5, HEAD_CY - 5, 0.85, 0.75, C.SILK);
  }
  return g;
}

const POSE_FN = {
  enter: poseEnter,
  sleep: poseSleep,
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

/** 全部行 × 帧 → 单个 RGBA 缓冲（1536×2288；unit 网格放大 U 倍）。 */
function buildSheet() {
  const W = COLS * CELL_W;
  const H = Object.keys(ROWS).length * CELL_H;
  const out = new Uint8Array(W * H * 4);
  for (const [name, spec] of Object.entries(ROWS)) {
    const fn = POSE_FN[name];
    for (let f = 0; f < spec.frames; f++) {
      const drawn = fn(f);
      // poseFailed/poseReview/poseEnter/poseSleep 直接返回画好的栅格；其余返回 pose 对象 → 站姿渲染
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
      spriteVersionNumber: 2,
      spritesheetPath: 'spritesheet.png',
    },
    null,
    2,
  )}\n`,
);
console.log(`[gen-spider-sprite] ${width}x${height} png (${(png.length / 1024).toFixed(0)} KB) -> ${path.relative(repoRoot, outDir)}`);
