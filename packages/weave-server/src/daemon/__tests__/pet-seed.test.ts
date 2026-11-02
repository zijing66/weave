import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { seedBuiltinPets } from '../pet-seed.js';

let dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'weave-pet-seed-'));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

/** 造一份内置宠（版本号只用来区分内容指纹）。 */
async function makePet(root: string, id: string, version: number): Promise<void> {
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'pet.json'), JSON.stringify({ id, spriteVersionNumber: version }));
  await writeFile(path.join(dir, 'spritesheet.png'), Buffer.from([version]));
}

const seededPath = (dataDir: string, id: string) => path.join(dataDir, 'data', 'pets', id);

describe('seedBuiltinPets', () => {
  it('目录缺失才播种，并写下内容指纹', async () => {
    const builtinRoot = await tmpDir();
    const dataDir = await tmpDir();
    await makePet(builtinRoot, 'spider', 1);

    await seedBuiltinPets({ builtinRoot, dataDir });

    const seeded = seededPath(dataDir, 'spider');
    expect(JSON.parse(await readFile(path.join(seeded, 'pet.json'), 'utf8')).spriteVersionNumber).toBe(1);
    expect((await readFile(path.join(seeded, '.weave-builtin'), 'utf8')).length).toBe(64);
  });

  it('包内资产更新且用户没改过 → 随包刷新', async () => {
    const builtinRoot = await tmpDir();
    const dataDir = await tmpDir();
    await makePet(builtinRoot, 'spider', 1);
    await seedBuiltinPets({ builtinRoot, dataDir });

    await makePet(builtinRoot, 'spider', 2);
    await seedBuiltinPets({ builtinRoot, dataDir });

    const seeded = seededPath(dataDir, 'spider');
    expect(JSON.parse(await readFile(path.join(seeded, 'pet.json'), 'utf8')).spriteVersionNumber).toBe(2);
  });

  it('用户改过的资产原样保留（不改用户数据）', async () => {
    const builtinRoot = await tmpDir();
    const dataDir = await tmpDir();
    await makePet(builtinRoot, 'spider', 1);
    await seedBuiltinPets({ builtinRoot, dataDir });

    const seeded = seededPath(dataDir, 'spider');
    await writeFile(path.join(seeded, 'pet.json'), JSON.stringify({ id: 'spider', spriteVersionNumber: 99 }));

    await makePet(builtinRoot, 'spider', 2);
    await seedBuiltinPets({ builtinRoot, dataDir });

    expect(JSON.parse(await readFile(path.join(seeded, 'pet.json'), 'utf8')).spriteVersionNumber).toBe(99);
  });

  it('存量目录没有指纹标记 → 不碰', async () => {
    const builtinRoot = await tmpDir();
    const dataDir = await tmpDir();
    await makePet(builtinRoot, 'spider', 2);
    // 模拟老版本播种（无 marker）
    const legacy = seededPath(dataDir, 'spider');
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, 'pet.json'), JSON.stringify({ id: 'spider', spriteVersionNumber: 1 }));
    await writeFile(path.join(legacy, 'spritesheet.png'), Buffer.from([1]));

    await seedBuiltinPets({ builtinRoot, dataDir });

    expect(JSON.parse(await readFile(path.join(legacy, 'pet.json'), 'utf8')).spriteVersionNumber).toBe(1);
  });
});
