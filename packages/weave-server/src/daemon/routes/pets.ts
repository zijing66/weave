import path from 'node:path';
import { createReadStream, promises as fsp } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PET_SPRITE_CONTRACT } from '@weavecode/core';
import type { WeaveServerDeps } from '../server.js';
import { sendJson } from '../http.js';
import { getPetsDir } from '../../db/paths.js';
import { isInsideDir } from '../../market/resolve.js';

/**
 * 桌面宠物只读端点：列举宠物资产、回吐 spritesheet。资产根 = `<data>/pets/`
 * （skill 生成 / 内置默认宠播种 / 用户手工导入），id 是目录名——绝不允许路径
 * 分隔符，拼进 petsDir 后再判一次 containment，防 `..` 与绝对路径穿越。
 */

interface PetManifest {
  id?: unknown;
  displayName?: unknown;
  description?: unknown;
  spriteVersionNumber?: unknown;
}

/** 读单个 pet.json；损坏/缺字段返回 null（跳过不炸列举）。 */
async function readPetManifest(dir: string): Promise<{
  id: string;
  displayName: string;
  description: string;
  spriteVersionNumber: number;
  updatedAt: number;
} | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(path.join(dir, 'pet.json'), 'utf8');
  } catch {
    return null;
  }
  let manifest: PetManifest;
  try {
    manifest = JSON.parse(raw) as PetManifest;
  } catch {
    return null;
  }
  const id = typeof manifest.id === 'string' ? manifest.id : '';
  if (!id || id !== path.basename(dir)) return null;
  const stat = await fsp.stat(path.join(dir, 'pet.json')).catch(() => null);
  return {
    id,
    displayName: typeof manifest.displayName === 'string' ? manifest.displayName : id,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    spriteVersionNumber:
      typeof manifest.spriteVersionNumber === 'number' ? manifest.spriteVersionNumber : 1,
    updatedAt: stat ? Math.floor(stat.mtimeMs) : 0,
  };
}

export async function handlePetRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  _deps: WeaveServerDeps,
  pathname: string,
  _url: URL,
): Promise<boolean> {
  if (!pathname.startsWith('/pets')) return false;

  if (pathname === '/pets' && req.method === 'GET') {
    const root = getPetsDir();
    let entries: string[];
    try {
      entries = await fsp.readdir(root);
    } catch {
      sendJson(res, 200, { pets: [], root });
      return true;
    }
    const pets = (
      await Promise.all(
        entries.map((name) => readPetManifest(path.join(root, name))),
      )
    ).filter((pet): pet is NonNullable<typeof pet> => pet !== null);
    pets.sort((a, b) => a.id.localeCompare(b.id));
    sendJson(res, 200, { pets, root });
    return true;
  }

  const sheetMatch = pathname.match(/^\/pets\/([^/]+)\/spritesheet$/);
  if (sheetMatch && req.method === 'GET') {
    const id = sheetMatch[1]!;
    // id 是目录名：路径分隔符与 `..` 一律不认（containment 双保险在 isInsideDir）
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(id)) {
      sendJson(res, 400, { error: 'Invalid pet id' });
      return true;
    }
    const root = getPetsDir();
    const dir = path.join(root, id);
    if (!isInsideDir(dir, root)) {
      sendJson(res, 403, { error: 'Pet path escapes the pets root' });
      return true;
    }
    const manifest = await readPetManifest(dir);
    if (!manifest) {
      sendJson(res, 404, { error: `Pet "${id}" not found` });
      return true;
    }
    const rel = path.join(dir, 'spritesheet.webp');
    const file = (await fsp.stat(rel).catch(() => null))?.isFile()
      ? rel
      : path.join(dir, 'spritesheet.png');
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat) {
      sendJson(res, 404, { error: `Pet "${id}" has no spritesheet` });
      return true;
    }
    if (stat.size > PET_SPRITE_CONTRACT.maxSpritesheetBytes) {
      sendJson(res, 413, { error: 'Spritesheet exceeds the size limit' });
      return true;
    }
    // 资产按 manifest 的 updatedAt 版本化（URL 带 ?v=），内容换了缓存才换——
    // 文件名恒定所以不能无条件 immutable
    res.writeHead(200, {
      'content-type': file.endsWith('.png') ? 'image/png' : 'image/webp',
      'content-length': String(stat.size),
      'cache-control': 'private, max-age=31536000, immutable',
    });
    const stream = createReadStream(file);
    stream.on('error', () => {
      if (typeof (res as { destroy?: unknown }).destroy === 'function') res.destroy();
    });
    stream.pipe(res);
    return true;
  }

  return false;
}
