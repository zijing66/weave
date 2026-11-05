import { describe, it, expect } from 'vitest';
import { reviewPrompt } from '../review-prompt';

/** A1 批阅动作文案：同意/驳回都带 files 清单锚点（8 个封顶 + 「等 N 个文件」）。 */
describe('reviewPrompt', () => {
  it('同意 = 固定文案带锚点，无附言不加行', () => {
    const p = reviewPrompt('approve', ['src/a.ts', 'src/b.ts'], '');
    expect(p).toContain('改动汇总批阅（src/a.ts、src/b.ts）：');
    expect(p).toContain('同意');
    expect(p).not.toContain('附言');
  });

  it('驳回 = 固定文案带锚点，附言单独一行', () => {
    const p = reviewPrompt('reject', ['a.ts'], '这里逻辑不对，改完再来');
    expect(p).toContain('驳回了这些改动');
    expect(p.endsWith('附言：这里逻辑不对，改完再来')).toBe(true);
  });

  it('超过 8 个文件截断清单并给总数', () => {
    const files = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
    const p = reviewPrompt('approve', files, '');
    expect(p).toContain('f7.ts 等 10 个文件');
    expect(p).not.toContain('f8.ts');
  });
});
