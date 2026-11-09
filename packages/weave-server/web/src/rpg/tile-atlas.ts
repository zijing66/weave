import { useEffect, useState } from 'react';
import { ATLAS_TILE_PX, ATLAS_COLS, ATLAS_ROWS, atlasTileOrigin } from './tileset-map';
import tilemapUrl from '@/assets/kenney-tiny-farm/tilemap.png';

/**
 * 图集切片（G2.6 第三轮资产化的运行时配套）：CSS background 的 repeat 单元
 * 是整张背景图——把 192×176 图集直接铺在合并 run 上会串块（run 会吞进同行
 * 邻列 tile）。解法 = 启动时把图集按 16px 格切成单 tile 的 data URL
 * （repeat 周期 = 24px 单格，run 合并才成立）。解码/编码全纯 JS（图集是
 * 8-bit 调色 PNG，5.7KB），不用 canvas；任何一步失败回 null，渲染层退
 * worldmap.tileColor 色块。
 */

/* ---- PNG 编码（RGBA8、filter 0、zlib stored 块——零压缩但代码最短） ---- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const x of bytes) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32be(v: number): Uint8Array {
  return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const head = u32be(data.length);
  const body = new Uint8Array(type.length + data.length);
  for (let i = 0; i < type.length; i++) body[i] = type.charCodeAt(i);
  body.set(data, type.length);
  const crc = u32be(crc32(body));
  const out = new Uint8Array(head.length + body.length + 4);
  out.set(head);
  out.set(body, 4);
  out.set(crc, 4 + body.length);
  return out;
}

/** 单 tile RGBA → PNG data URL（filter 0 行 + stored deflate 块）。 */
export function encodeTilePng(size: number, rgba: Uint8Array): string {
  const stride = 1 + size * 4;
  const raw = new Uint8Array(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * stride + 1);
  }
  // zlib: 0x78 0x01 头 + 一个 stored final 块 + adler
  const stored = new Uint8Array(5 + raw.length + 4);
  stored[0] = 1;
  stored[1] = raw.length & 0xff;
  stored[2] = (raw.length >> 8) & 0xff;
  stored[3] = ~stored[1]! & 0xff;
  stored[4] = ~stored[2]! & 0xff;
  stored.set(raw, 5);
  const ad = u32be(adler32(raw));
  stored.set(ad, 5 + raw.length);
  const zlib = new Uint8Array(2 + stored.length);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  zlib.set(stored, 2);

  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(size), 0);
  ihdr.set(u32be(size), 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = new Uint8Array(8 + 12 + 13 + 12 + zlib.length + 12 + 0);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let off = 8;
  for (const part of [chunk('IHDR', ihdr), chunk('IDAT', zlib), chunk('IEND', new Uint8Array(0))]) {
    png.set(part, off);
    off += part.length;
  }
  let bin = '';
  for (const b of png.subarray(0, off)) bin += String.fromCharCode(b);
  return `data:image/png;base64,${btoa(bin)}`;
}

/* ---- PNG 解码（IHDR/PLTE/tRNS/IDAT；支持 8-bit 调色与 RGBA） ---- */

function concat(bytes: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
  let off = 0;
  for (const b of bytes) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

const PAETH = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** 图集解码为按 tile 取的 RGBA 面片（仅支持本资产用到的 8-bit 形）。 */
export async function decodeAtlasTiles(
  bytes: Uint8Array,
): Promise<Map<number, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let ct = 0;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = view.getUint32(off + 8);
      h = view.getUint32(off + 12);
      depth = data[8]!;
      ct = data[9]!;
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (depth !== 8 || (ct !== 3 && ct !== 6)) throw new Error(`unsupported png depth=${depth} ct=${ct}`);
  const raw = await inflate(concat(idat));
  const bpp = ct === 3 ? 1 : 4;
  const stride = w * bpp;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    const cur = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp]! : 0;
      const b = y > 0 ? rows[y - 1]![i]! : 0;
      const c = i >= bpp && y > 0 ? rows[y - 1]![i - bpp]! : 0;
      const v = cur[i]!;
      cur[i] =
        f === 0 ? v : f === 1 ? (v + a) & 0xff : f === 2 ? (v + b) & 0xff : f === 3 ? (v + ((a + b) >> 1)) & 0xff : (v + PAETH(a, b, c)) & 0xff;
    }
    rows.push(cur);
  }
  const tiles = new Map<number, Uint8Array>();
  for (let n = 1; n < ATLAS_COLS * ATLAS_ROWS; n++) {
    const o = atlasTileOrigin(n);
    if (!o) continue;
    const rgba = new Uint8Array(ATLAS_TILE_PX * ATLAS_TILE_PX * 4);
    for (let y = 0; y < ATLAS_TILE_PX; y++) {
      for (let x = 0; x < ATLAS_TILE_PX; x++) {
        const src = rows[o.y + y]!;
        const dst = (y * ATLAS_TILE_PX + x) * 4;
        if (ct === 3) {
          const idx = src[o.x + x]!;
          rgba[dst] = plte![idx * 3]!;
          rgba[dst + 1] = plte![idx * 3 + 1]!;
          rgba[dst + 2] = plte![idx * 3 + 2]!;
          rgba[dst + 3] = trns && idx < trns.length ? trns[idx]! : 255;
        } else {
          const s = (o.x + x) * 4;
          rgba[dst] = src[s]!;
          rgba[dst + 1] = src[s + 1]!;
          rgba[dst + 2] = src[s + 2]!;
          rgba[dst + 3] = src[s + 3]!;
        }
      }
    }
    tiles.set(n, rgba);
  }
  return tiles;
}

/* ---- 加载与缓存（全站一次） ---- */

export type TileSprites = ReadonlyMap<number, string>;

let cache: Promise<TileSprites | null> | null = null;

async function loadAll(): Promise<TileSprites | null> {
  try {
    const res = await fetch(tilemapUrl);
    if (!res.ok) throw new Error(`atlas ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const tiles = await decodeAtlasTiles(bytes);
    const out = new Map<number, string>();
    for (const [n, rgba] of tiles) out.set(n, encodeTilePng(ATLAS_TILE_PX, rgba));
    return out;
  } catch {
    return null;
  }
}

/** 全量 tile data URL（null = 图集不可用，渲染层退色块）。模块级缓存一次。 */
export function loadTileSprites(): Promise<TileSprites | null> {
  cache ??= loadAll();
  return cache;
}

/** React 侧：挂载后异步取切片；加载完成一拍后组件重渲。 */
export function useTileSprites(): TileSprites | null {
  const [sprites, setSprites] = useState<TileSprites | null>(null);
  useEffect(() => {
    let alive = true;
    void loadTileSprites().then((s) => {
      if (alive && s) setSprites(s);
    });
    return () => {
      alive = false;
    };
  }, []);
  return sprites;
}
