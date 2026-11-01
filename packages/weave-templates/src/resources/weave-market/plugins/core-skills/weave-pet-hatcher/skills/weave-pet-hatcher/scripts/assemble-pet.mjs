#!/usr/bin/env node
// weave-pet-hatcher 拼装校验脚本：行条带 → 切格校验 → 整图 + pet.json + contact sheet。
// 纯 node 零依赖（PNG 解码/编码手写，zlib 走内置）。只认 8-bit PNG
// （RGBA / RGB / 调色色）；其他格式让用户先转 PNG。
// 用法见 SKILL.md §3。
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CELL_W = 192;
const CELL_H = 208;
const COLS = 8;
const ROW_FRAMES = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8];
const ROW_NAMES = [
  'idle', 'running-right', 'running-left', 'waving', 'jumping',
  'failed', 'waiting', 'running', 'review', 'look-a', 'look-b',
];

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!key || argv[i + 1] === undefined) usage(`missing value for --${key ?? '?'}`);
    out[key] = argv[i + 1];
  }
  return out;
}

function usage(msg) {
  console.error(`assemble-pet: ${msg}
usage: node assemble-pet.mjs --rows-dir <dir> --out-dir <dir> --pet-id <id> \\
  --display-name "<Name>" --description "<text>" [--version 1|2]`);
  process.exit(2);
}

const args = parseArgs(process.argv);
const rowsDir = args['rows-dir'];
const outDir = args['out-dir'];
const petId = args['pet-id'];
const displayName = args['display-name'] ?? petId;
const description = args['description'] ?? '';
const version = Number(args['version'] ?? 2);
if (!rowsDir || !outDir || !petId) usage('rows-dir / out-dir / pet-id are required');
if (![1, 2].includes(version)) usage('--version must be 1 or 2');
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(petId)) {
  usage('pet-id must match [a-z0-9][a-z0-9-]{0,63}');
}
const rowCount = version === 2 ? 11 : 9;

// ---------------------------------------------------------------------------
// PNG decode（8-bit，color type 2/3/6，filter 0-4）
// ---------------------------------------------------------------------------

function decodePng(bytes) {
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG file');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  let palette = null;
  let trns = null;
  while (pos < bytes.length) {
    const len = bytes.readUInt32BE(pos);
    const type = bytes.toString('ascii', pos + 4, pos + 8);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth} (need 8)`);
      if (![2, 3, 6].includes(colorType)) {
        throw new Error(`unsupported color type ${colorType} (need 2/3/6)`);
      }
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const off = y * (stride + 1);
    const filter = raw[off];
    raw.copy(line, 0, off + 1, off + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = v & 0xff;
    }
    prev.set(line);
    for (let x = 0; x < width; x++) {
      const di = (y * width + x) * 4;
      if (colorType === 6) {
        out[di] = line[x * 4];
        out[di + 1] = line[x * 4 + 1];
        out[di + 2] = line[x * 4 + 2];
        out[di + 3] = line[x * 4 + 3];
      } else if (colorType === 2) {
        out[di] = line[x * 3];
        out[di + 1] = line[x * 3 + 1];
        out[di + 2] = line[x * 3 + 2];
        out[di + 3] = 255;
      } else {
        const idx = line[x];
        out[di] = palette[idx * 3];
        out[di + 1] = palette[idx * 3 + 1];
        out[di + 2] = palette[idx * 3 + 2];
        out[di + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
  }
  return { width, height, rgba: out };
}

// ---------------------------------------------------------------------------
// PNG encode（RGBA8，filter 全 0）
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
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 抠像底 → alpha：四角取底色，与底色距离 < HARD 的像素按距离转透明
// （四角颜色不一致 >40 视为无抠像底，原样保留）
// ---------------------------------------------------------------------------

function chromaToAlpha(rgba, width, height) {
  const cornerIdx = [0, (width - 1) * 4, (height - 1) * width * 4, ((height - 1) * width + width - 1) * 4];
  const key = cornerIdx.map((i) => [rgba[i], rgba[i + 1], rgba[i + 2]]);
  for (const c of key.slice(1)) {
    if (Math.hypot(c[0] - key[0][0], c[1] - key[0][1], c[2] - key[0][2]) > 40) return false;
  }
  const HARD = 90;
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    const d = Math.hypot(rgba[i] - key[0][0], rgba[i + 1] - key[0][1], rgba[i + 2] - key[0][2]);
    if (d < HARD) rgba[i + 3] = Math.min(rgba[i + 3], Math.round((d / HARD) * rgba[i + 3]));
    if (rgba[i + 3] === 0) {
      rgba[i] = key[0][0];
      rgba[i + 1] = key[0][1];
      rgba[i + 2] = key[0][2];
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// main：逐行校验 → 拼整图 → pet.json → contact sheet（一格宽缩略竖排）
// ---------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
const sheetW = COLS * CELL_W;
const sheetH = rowCount * CELL_H;
const sheet = Buffer.alloc(sheetW * sheetH * 4);

for (let rowIdx = 0; rowIdx < rowCount; rowIdx++) {
	const framesExpected = ROW_FRAMES[rowIdx];
	const file = path.join(rowsDir, `row-${rowIdx}.png`);
	let img;
	try {
		img = decodePng(readFileSync(file));
	} catch (e) {
		console.error(`row-${rowIdx}: cannot read ${file} — ${e.message}`);
		process.exit(1);
	}
	if (img.height !== CELL_H) {
		console.error(`row-${rowIdx}: strip height ${img.height} != ${CELL_H} — regenerate this row`);
		process.exit(1);
	}
	if (img.width !== framesExpected * CELL_W) {
		console.error(
			`row-${rowIdx}: strip width ${img.width} != ${framesExpected} cells x ${CELL_W} — regenerate this row`,
		);
		process.exit(1);
	}
	const despilled = chromaToAlpha(img.rgba, img.width, img.height);
	for (let y = 0; y < CELL_H; y++) {
		for (let x = 0; x < img.width; x++) {
			const si = (y * img.width + x) * 4;
			const di = ((rowIdx * CELL_H + y) * sheetW + x) * 4;
			sheet[di] = img.rgba[si];
			sheet[di + 1] = img.rgba[si + 1];
			sheet[di + 2] = img.rgba[si + 2];
			sheet[di + 3] = img.rgba[si + 3];
		}
	}
	console.log(`row-${rowIdx} (${ROW_NAMES[rowIdx]}): ok (${framesExpected} frames${despilled ? ', chroma keyed' : ''})`);
}

writeFileSync(path.join(outDir, 'spritesheet.png'), encodePng(sheet, sheetW, sheetH));
writeFileSync(
	path.join(outDir, 'pet.json'),
	`${JSON.stringify(
		{
			id: petId,
			displayName,
			description,
			spriteVersionNumber: version,
			spritesheetPath: 'spritesheet.png',
		},
		null,
		2,
	)}\n`,
);

// contact sheet：每行缩略（一格宽）竖排，行号标注在左侧留白
const csCell = Math.round(CELL_W / 2); // 缩略格宽 96
const csCellH = Math.round((CELL_H / CELL_W) * csCell);
const csPad = 28;
const csW = csPad + COLS * csCell + 8;
const csH = rowCount * (csCellH + 6) + 8;
const cs = Buffer.alloc(csW * csH * 4);
// 白底
for (let p = 0; p < csW * csH; p++) {
  cs[p * 4] = 250;
  cs[p * 4 + 1] = 250;
  cs[p * 4 + 2] = 250;
  cs[p * 4 + 3] = 255;
}
for (let rowIdx = 0; rowIdx < rowCount; rowIdx++) {
  const oy = rowIdx * (csCellH + 6) + 4;
  for (let cy = 0; cy < csCellH; cy++) {
    for (let cx = 0; cx < COLS * csCell; cx++) {
      // 最近邻取样回整图
      const sx = Math.floor((cx / csCell)) * CELL_W + Math.floor(((cx % csCell) / csCell) * CELL_W);
      const sy = Math.floor((cy / csCellH) * CELL_H);
      const si = ((rowIdx * CELL_H + sy) * sheetW + sx) * 4;
      const di = ((oy + cy) * csW + csPad + cx) * 4;
      const a = sheet[si + 3] / 255;
      if (a === 0) continue;
      cs[di] = Math.round(sheet[si] * a + cs[di] * (1 - a));
      cs[di + 1] = Math.round(sheet[si + 1] * a + cs[di + 1] * (1 - a));
      cs[di + 2] = Math.round(sheet[si + 2] * a + cs[di + 2] * (1 - a));
    }
  }
}
writeFileSync(path.join(outDir, 'contact-sheet.png'), encodePng(cs, csW, csH));

console.log(`\nassembled: ${path.join(outDir, 'spritesheet.png')} (${sheetW}x${sheetH})`);
console.log(`manifest: ${path.join(outDir, 'pet.json')} (v${version})`);
console.log(`contact sheet: ${path.join(outDir, 'contact-sheet.png')} — inspect it row by row`);
console.log('next: copy pet.json + spritesheet.png into <pets-root>/<pet-id>/');
