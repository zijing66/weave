import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 联邦 caller 级项目范围（AsyncLocalStorage 切面）。
 *
 * per-peer token 在 federation-routes 消解出 peer 行后，用 runWithCallerScope
 * 把 {scopeProjects} 挂进本次请求的异步链；之后仓储/数据层随取随裁——多项目
 * 返回面（清单/搜索，入参无 projectId）靠它裁，外层逐臂过滤覆盖不了。
 *
 * **边界裁决（唯一权威注释）**：ALS 空 = 全量，是安全默认——内部作业
 * （inbox-worker、dashboard-pusher、各类 refresher）无请求上下文，必须拿到
 * 全量；新增数据层裁剪点必须走 scopedProjectIds()/projectInScope()，不要自己
 * 猜默认值。红线：不允许在 ALS 上下文里 setTimeout 起新作业后依赖 scope
 * （ALS 不跨新定时器链传播——那正是「回到无请求上下文」的形态）。
 */

const callerScopeAls = new AsyncLocalStorage<{ scopeProjects: number[] | null }>();

export interface CallerScope {
  scopeProjects: number[] | null;
}

/** 在 scope 内跑 fn；scope 缺席（本机 caller / 内部作业）= 直接跑，不进 ALS。 */
export function runWithCallerScope<T>(scope: CallerScope | undefined, fn: () => T): T {
  if (!scope) return fn();
  return callerScopeAls.run(scope, fn);
}

/** 当前 caller 范围；null = 无上下文或全量（不裁）。 */
export function callerScopeOf(): CallerScope | null {
  return callerScopeAls.getStore() ?? null;
}

/**
 * 裁剪用的项目 id 集：null = 不裁；[] = 合法空集（该 peer 被圈成「不共享」，
 * 裁剪结果必须为空——不是「全量」）。
 */
export function scopedProjectIds(): number[] | null {
  return callerScopeAls.getStore()?.scopeProjects ?? null;
}

/** 显式 403 谓词：projectId 在 caller 范围内（无上下文恒 true）。 */
export function projectInScope(projectId: number | null | undefined): boolean {
  const scope = scopedProjectIds();
  if (scope == null) return true;
  return projectId != null && scope.includes(projectId);
}

/**
 * SQL where 片段：有 scope 产出 `AND <column> IN (?,?,...)` 与绑定参数；
 * 空数组产出 `AND 0`（IN () 非法）。无 scope 产出空片段。
 */
export function scopeProjectsFilter(
  column: string,
): { sql: string; params: number[] } {
  const scope = scopedProjectIds();
  if (scope == null) return { sql: '', params: [] };
  if (scope.length === 0) return { sql: ` AND 0`, params: [] };
  return {
    sql: ` AND ${column} IN (${scope.map(() => '?').join(',')})`,
    params: scope,
  };
}
