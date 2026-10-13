import type { InitPipeline } from '@weavecode/harness';

/**
 * init 表面步骤（InitPipeline final 骨架的 1–7）的结果累加器：`InitResult` 中
 * 由表面几步贡献的部分；executor 的中立步（⑧⑨⑩）在 `runSurface` 后合并同一组数组。
 *
 * harness 无关契约：各 harness 的 init 模板与 executor 都实现/消费本类型
 * （原挂在 claude 专属模块，结构兼容但「家」错位）。
 */
export interface SurfaceRecords {
  created: { directories: string[]; files: string[] };
  skipped: string[];
  merged: string[];
  updated: string[];
  removed: string[];
}

/** executor 视角的表面管线：`runSurface` 后读取结果累加器。 */
export type SurfacePipeline = InitPipeline & { readonly records: SurfaceRecords };
