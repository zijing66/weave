import { describe, it, expect } from 'vitest';
import { previewPickOf } from '../QuestionAnswer';
import type { PendingQuestionOption } from '@/lib/api';

/**
 * 预览形态（宿主左右分栏）的作答下标：下标只说明「点了哪些行」，键序由服务端按面拼。
 * 面尾 = `Notes:` 备注行（下标 2）与 `Chat about this` 行（下标 3）——没有 Other 行。
 */
describe('previewPickOf', () => {
  const options: PendingQuestionOption[] = [
    { keys: ['2', '1'], label: 'Sidebar', commit: ['\r'], preview: '|nav| main' },
    { keys: ['1', '2'], label: 'Stacked', commit: ['\r'], preview: 'nav\nmain' },
    { keys: ['n'], label: 'Notes:', input: true, textTail: ['\r'] },
    { keys: ['2', '\x1b[B', '\r'], label: 'Chat about this', chat: true },
  ];

  it('只选选项：不带备注行（备注空 = 键序就该是纯选项）', () => {
    expect(previewPickOf(options, [0], '')).toEqual([0]);
    expect(previewPickOf(options, [1], '   ')).toEqual([1]);
  });

  it('选项 + 备注：备注行跟在选项后面（服务端把文本拼进该行的尾键前）', () => {
    expect(previewPickOf(options, [1], ' 再宽点 ')).toEqual([1, 2]);
  });

  it('只填备注：只发备注行（宿主自己答成 (notes only)）', () => {
    expect(previewPickOf(options, [], '偏窄')).toEqual([2]);
  });

  it('都没填 = 还没答（null）；没有备注行的面里备注不算作答', () => {
    expect(previewPickOf(options, [], '  ')).toBeNull();
    expect(previewPickOf(options.slice(0, 2), [], '偏窄')).toBeNull();
  });
});
