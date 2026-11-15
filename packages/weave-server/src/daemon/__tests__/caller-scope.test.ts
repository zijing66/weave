import { describe, expect, it } from 'vitest';
import {
  callerScopeOf,
  projectInScope,
  runWithCallerScope,
  scopeProjectsFilter,
  scopedProjectIds,
} from '../caller-scope.js';

describe('caller-scope（联邦 caller 范围切面）', () => {
  it('无上下文 = 全量：callerScopeOf null、scopedProjectIds null、谓词恒 true、SQL 片段空', () => {
    expect(callerScopeOf()).toBeNull();
    expect(scopedProjectIds()).toBeNull();
    expect(projectInScope(1)).toBe(true);
    expect(projectInScope(null)).toBe(true);
    expect(scopeProjectsFilter('project_id')).toEqual({ sql: '', params: [] });
  });

  it('runWithCallerScope 内可读、外不可读；undefined 直接跑不进 ALS', () => {
    expect(runWithCallerScope({ scopeProjects: [1, 2] }, () => scopedProjectIds())).toEqual([1, 2]);
    expect(scopedProjectIds()).toBeNull();
    expect(runWithCallerScope(undefined, () => scopedProjectIds())).toBeNull();
  });

  it('嵌套 run：内层覆盖外层，退出还原', () => {
    expect(
      runWithCallerScope({ scopeProjects: [1] }, () =>
        runWithCallerScope({ scopeProjects: [9] }, () => scopedProjectIds()),
      ),
    ).toEqual([9]);
    expect(
      runWithCallerScope({ scopeProjects: [1] }, () => {
        const outer = scopedProjectIds();
        const inner = runWithCallerScope({ scopeProjects: [9] }, () => scopedProjectIds());
        return [outer, inner, scopedProjectIds()];
      }),
    ).toEqual([[1], [9], [1]]);
  });

  it('[] 空集 = 不共享：谓词恒 false、SQL 产 AND 0（IN () 非法）', () => {
    runWithCallerScope({ scopeProjects: [] }, () => {
      expect(projectInScope(1)).toBe(false);
      expect(scopeProjectsFilter('project_id')).toEqual({ sql: ' AND 0', params: [] });
    });
  });

  it('有 scope：谓词按集裁、SQL 产 IN 占位与参数', () => {
    runWithCallerScope({ scopeProjects: [3, 7] }, () => {
      expect(projectInScope(3)).toBe(true);
      expect(projectInScope(4)).toBe(false);
      expect(projectInScope(null)).toBe(false);
      expect(scopeProjectsFilter('s.project_id')).toEqual({
        sql: ' AND s.project_id IN (?,?)',
        params: [3, 7],
      });
    });
  });

  it('ALS 跨 await 传播（同异步链内安全）；Promise 链外（新宏任务）读不到', async () => {
    const inner = await runWithCallerScope({ scopeProjects: [5] }, async () => {
      await Promise.resolve();
      return scopedProjectIds();
    });
    expect(inner).toEqual([5]);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(scopedProjectIds()).toBeNull();
  });
});
