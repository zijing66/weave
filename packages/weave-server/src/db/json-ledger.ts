import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 账面文件的唯一读写口（原子写 tmp + rename；读坏/缺文件 = null，调用方落空账）。
 * 失败静默——账面都是「增强信号 / 重启恢复」，丢了退既有路径，绝不能冒泡。
 */
export function readJsonLedger<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** mode 缺省 0600（hooks 目录的账可能带会话 id）；值没变的比较由调用方做。 */
export function writeJsonLedger(file: string, value: unknown, mode: number = 0o600): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode });
    renameSync(tmp, file);
    chmodSync(file, mode);
  } catch {
    // 落盘失败绝不能冒泡
  }
}
