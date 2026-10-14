import { describe, it, expect } from 'vitest';
import { formatStars } from '../github';

describe('formatStars', () => {
  it('千以下原样；千以上压缩为 k，一位小数且不留 .0', () => {
    expect(formatStars(0)).toBe('0');
    expect(formatStars(999)).toBe('999');
    expect(formatStars(1000)).toBe('1k');
    expect(formatStars(1234)).toBe('1.2k');
    expect(formatStars(9999)).toBe('10k'); // ≥10k 取整
    expect(formatStars(12400)).toBe('12k');
  });
});
