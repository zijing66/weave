import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeFileIfAbsent(
  filePath: string,
  content: string,
  force: boolean,
): Promise<boolean> {
  try {
    await readFile(filePath, 'utf-8');
    if (!force) return false;
  } catch {
    // file doesn't exist, proceed
  }
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, content, 'utf-8');
  return true;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
