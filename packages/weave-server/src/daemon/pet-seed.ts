import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { builtinPetsRoot } from '@weavecode/templates';
import { getPetsDir } from '../db/paths.js';

/**
 * 内置默认宠播种：`@weavecode/templates` 随包发货的 `resources/pets/` 落到
 * `<data>/pets/<id>/`。**缺失才拷**（mtime+size 指纹对不上也不覆盖——用户改过
 * 的资产是数据，不是包内容）；目录已存在即视为用户领地，跳过。
 */
export async function seedBuiltinPets(): Promise<void> {
  let builtins: string[];
  try {
    builtins = await readdir(builtinPetsRoot());
  } catch {
    return; // 包内无宠物资产（异常但无害）
  }
  const root = getPetsDir();
  await mkdir(root, { recursive: true });
  for (const id of builtins) {
    const target = path.join(root, id);
    const existing = await stat(target).catch(() => null);
    if (existing?.isDirectory()) continue;
    await cp(path.join(builtinPetsRoot(), id), target, { recursive: true }).catch(() => {});
  }
}
