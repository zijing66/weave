import { describe, expect, it } from 'vitest';
import { cleanPath } from '../DirectoryPickerModal';

describe('cleanPath', () => {
  it('去掉资源管理器「复制为路径」带的引号与首尾空白', () => {
    expect(cleanPath('  "D:\\skills\\my pack"  ')).toBe('D:\\skills\\my pack');
    expect(cleanPath('"/home/me/skills"')).toBe('/home/me/skills');
  });

  it('去掉尾部分隔符，但保留盘符根', () => {
    expect(cleanPath('D:\\skills\\')).toBe('D:\\skills');
    expect(cleanPath('/home/me/skills/')).toBe('/home/me/skills');
    expect(cleanPath('D:\\')).toBe('D:\\');
  });

  it('空与纯空白归零', () => {
    expect(cleanPath('')).toBe('');
    expect(cleanPath('   ')).toBe('');
  });
});
