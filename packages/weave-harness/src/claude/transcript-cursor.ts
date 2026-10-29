import { closeSync, openSync, readSync, statSync } from 'node:fs';

/**
 * 转录的两种读法（旁白 / 回退 / 命令回显共用）：
 *
 * - **按行增量**：转录只追加，故记住「已消费到哪个字节」即可，每拍只读新增部分。
 *   游标必须落在行边界上——读一块、找最后一个 `\n`、只推进到那里，尾部那条没写完
 *   的长行下一拍连同新字节一起读（不押字符串、避免多字节字符被切断的偏移漂）。
 * - **尾窗**：只关心文件末尾那点事实的（提问前说明）就别整份读进内存。
 */

/** 行级游标：已经完整消费掉的字节数（恒落在行边界）。 */
export interface LineCursor {
  offset: number;
}

/** 文件大小；读不到（已删/无权限）= null。 */
export function transcriptSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** 一行是不是完整的 JSON：转录每行一条 JSON，文件末尾没换行时用它判「写完了没」。 */
export function isCompleteJsonLine(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从游标处读到文件尾，返回其中**完整的行**；游标推进到最后一个换行之后。
 * 末尾那条没有换行的行，只有 `isComplete` 认它写完了才一并返回并推进游标
 * （写了一半的行留给下一拍，否则半行会被当成坏行永久跳过）。
 * 文件被截断/换掉（size < offset）→ 游标归零从头来。读失败返回 null（调用方
 * 按「这一刻读不到」处理，不猜）。
 */
export function readNewLines(
  path: string,
  cursor: LineCursor,
  size: number,
  isComplete: (line: string) => boolean = isCompleteJsonLine,
): string[] | null {
  if (size < cursor.offset) cursor.offset = 0;
  if (size === cursor.offset) return [];
  const start = cursor.offset;
  const buf = Buffer.alloc(size - start);
  let read: number;
  const fd = openSync(path, 'r');
  try {
    read = readSync(fd, buf, 0, buf.length, start);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  const nl = buf.lastIndexOf(0x0a, read - 1);
  if (nl < 0) {
    const only = buf.subarray(0, read).toString('utf8');
    if (!isComplete(only)) return []; // 整块都还在一条没写完的行里：下一拍再来
    cursor.offset = start + read;
    return [only];
  }
  const lines = buf.subarray(0, nl + 1).toString('utf8').split('\n').slice(0, -1);
  const rest = buf.subarray(nl + 1, read).toString('utf8');
  if (rest !== '' && isComplete(rest)) {
    lines.push(rest);
    cursor.offset = start + read;
  } else {
    cursor.offset = start + nl + 1;
  }
  return lines;
}

/** 读文件尾部 `bytes` 字节（不足则整份）。读不到 = null。 */
export function readTail(path: string, bytes: number): string | null {
  const size = transcriptSize(path);
  if (size === null) return null;
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, 'r');
  try {
    const read = readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
