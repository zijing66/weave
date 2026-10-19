import { describe, it, expect } from 'vitest';
import { CLAUDE_PLAN } from '../claude/plan.js';

/**
 * claude 计划面：ExitPlanMode 交出的计划正文在哪，随宿主版本变（老模型塞在
 * `tool_input.plan`，2.1.296 起正文只在写计划文件那次调用的 content 里）。
 */
describe('claude 计划面', () => {
  it('老模型：正文与计划文件路径都在 ExitPlanMode 的 tool_input 里', () => {
    expect(
      CLAUDE_PLAN.draftOf(
        'ExitPlanMode',
        { plan: '# 计划\n先改 A', planFilePath: '/home/u/.claude/plans/x.md' },
        null,
      ),
    ).toEqual({ text: '# 计划\n先改 A', filePath: '/home/u/.claude/plans/x.md' });
  });

  it('2.1.296：tool_input 恒空，只能从 Post 的 filePath 认出计划文件（正文没有）', () => {
    expect(
      CLAUDE_PLAN.draftOf(
        'ExitPlanMode',
        {},
        { plan: null, isAgent: false, filePath: '/home/u/.claude/plans/x.md' },
      ),
    ).toEqual({ text: null, filePath: '/home/u/.claude/plans/x.md' });
  });

  it('写计划文件那次调用：plans 目录下的 .md 才认，content 就是正文', () => {
    expect(
      CLAUDE_PLAN.draftOf(
        'Write',
        { file_path: '/home/u/.claude/plans/x.md', content: '# 计划' },
        null,
      ),
    ).toEqual({ text: '# 计划', filePath: '/home/u/.claude/plans/x.md' });
  });

  it('Edit 只有片段：认得出是计划文件，但不把片段当整份正文', () => {
    expect(
      CLAUDE_PLAN.draftOf(
        'Edit',
        { file_path: '/home/u/.claude/plans/x.md', old_string: 'A', new_string: 'B' },
        null,
      ),
    ).toEqual({ text: null, filePath: '/home/u/.claude/plans/x.md' });
  });

  it('别的 md / 不是写工具 / 没有工具名 → 不是计划', () => {
    expect(CLAUDE_PLAN.draftOf('Write', { file_path: '/repo/README.md', content: 'x' }, null)).toBeNull();
    expect(CLAUDE_PLAN.draftOf('Bash', { file_path: '/home/u/.claude/plans/x.md' }, null)).toBeNull();
    expect(CLAUDE_PLAN.draftOf(null, { plan: 'x' }, null)).toBeNull();
  });
});
