import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { builtinPetsRoot } from '@weavecode/templates';
import { getPetsDir } from '../db/paths.js';

/**
 * 内置默认宠播种：`@weavecode/templates` 随包发货的 `resources/pets/` 落到
 * `<data>/pets/<id>/`。**目录缺失才拷**；目录已存在时只在「播种时记的指纹
 * 仍等于当前内容」（即用户没改过）才随包刷新——改过的资产是用户数据，不覆盖。
 */

/** 播种时写进目标目录的内容指纹；用户改过任何文件，指纹就对不上。 */
const MARKER = '.weave-builtin';

/** 目录内容指纹（跳过 marker 自身；文件名 + 内容 sha256，按名排序）。 */
async function hashDir(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    if (name === MARKER) continue;
    const full = path.join(dir, name);
    const st = await stat(full);
    if (!st.isFile()) continue;
    parts.push(`${name}:${createHash('sha256').update(await readFile(full)).digest('hex')}`);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

export async function seedBuiltinPets(
  opts: { builtinRoot?: string; dataDir?: string } = {},
): Promise<void> {
  const builtinRoot = opts.builtinRoot ?? builtinPetsRoot();
  let builtins: string[];
  try {
    builtins = await readdir(builtinRoot);
  } catch {
    return; // 包内无宠物资产（异常但无害）
  }
  const root = getPetsDir(opts.dataDir);
  await mkdir(root, { recursive: true });
  for (const id of builtins) {
    const src = path.join(builtinRoot, id);
    const target = path.join(root, id);
    const srcHash = await hashDir(src).catch(() => null);
    const existing = await stat(target).catch(() => null);

    if (!existing?.isDirectory()) {
      await cp(src, target, { recursive: true }).catch(() => {});
      if (srcHash) await writeFile(path.join(target, MARKER), srcHash).catch(() => {});
      continue;
    }

    // 已有目录：无 marker（存量用户 / 手建）一律跳过；内容被改过也跳过。
    const marker = await readFile(path.join(target, MARKER), 'utf8').catch(() => null);
    if (!marker || !srcHash) continue;
    const curHash = await hashDir(target).catch(() => null);
    if (curHash !== marker.trim() || curHash === srcHash) continue;

    await cp(src, target, { recursive: true }).catch(() => {});
    await writeFile(path.join(target, MARKER), srcHash).catch(() => {});
  }
}
