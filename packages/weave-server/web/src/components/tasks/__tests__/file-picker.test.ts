import { describe, expect, it } from 'vitest';
import { rangePick, togglePick } from '../FilePicker';
import type { SessionFileEntry } from '@/lib/api';

const entry = (path: string, kind: 'file' | 'dir' = 'file'): SessionFileEntry => ({
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  kind,
  ref: kind === 'dir' ? `@${path}/` : `@${path}`,
});

const paths = (rows: readonly SessionFileEntry[]): string[] => rows.map((r) => r.path);

describe('togglePick（勾选加入 / 移出）', () => {
  it('① 按路径去重、保持加入顺序', () => {
    const a = entry('src/a.ts');
    const b = entry('src/b.ts');
    expect(paths(togglePick([], b))).toEqual(['src/b.ts']);
    expect(paths(togglePick(togglePick([], b), a))).toEqual(['src/b.ts', 'src/a.ts']);
    expect(paths(togglePick(togglePick([], a), a))).toEqual([]);
  });

  it('② 目录与文件同一套：同名路径不重复加入', () => {
    expect(paths(togglePick([entry('src', 'dir')], entry('src', 'dir')))).toEqual([]);
  });
});

describe('rangePick（Shift 连选）', () => {
  const rows = [entry('a.ts'), entry('b.ts'), entry('c.ts')];

  it('① 双向都认：从后往前拖也选中同一段', () => {
    expect(paths(rangePick([], rows, 0, 2))).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(paths(rangePick([], rows, 2, 0))).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('② 已有的保持原位，新增的按列表序追加', () => {
    const picked = [entry('c.ts')];
    expect(paths(rangePick(picked, rows, 0, 1))).toEqual(['c.ts', 'a.ts', 'b.ts']);
  });

  it('③ 越界的下标夹回列表范围', () => {
    expect(paths(rangePick([], rows, -5, 99))).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
});
