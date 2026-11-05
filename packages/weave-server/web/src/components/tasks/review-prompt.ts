/** 批阅动作的投递文案：固定结论 + 弹窗手里的 files 清单锚点（会话靠它认批次）+ 可选附言。 */

const REVIEW_FILES_MAX = 8;

export function reviewPrompt(
  kind: 'approve' | 'reject',
  files: readonly string[],
  note: string,
): string {
  const list = files.slice(0, REVIEW_FILES_MAX).join('、');
  const more = files.length > REVIEW_FILES_MAX ? ` 等 ${files.length} 个文件` : '';
  const anchor = `改动汇总批阅（${list}${more}）：`;
  if (kind === 'approve') {
    return `${anchor}用户已审阅并同意这些改动，请按计划继续。${note ? `\n附言：${note}` : ''}`;
  }
  return `${anchor}用户驳回了这些改动，请停下等待进一步指示。${note ? `\n附言：${note}` : ''}`;
}
