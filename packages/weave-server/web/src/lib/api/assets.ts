/** 资产域：harness 落盘文件（command/agent/workflow/rule/output-style）与其变更事件。 */

import type { Harness } from '@weavecode/core/harness';

export type AssetAgent = Harness;

export interface AssetEntry {
  absPath: string;
  relPath: string;
  category: string;
  mtimeMs: number;
  /** Which coding agent's harness surface this asset belongs to. */
  agent?: AssetAgent;
  /** True when the file itself is a symbolic link (its target is watched). */
  isSymlink?: boolean;
  /** 所属仓库 namespace（该文件是哪个仓库铺下来的）：用户自己写的文件不属于任何
   *  仓库，故缺省。服务端判定，web 只渲染。 */
  namespace?: string;
}

export interface AssetChangeEvent {
  projectPath: string;
  projectName: string;
  category: string;
  relPath: string;
  absPath: string;
  kind: 'add' | 'change' | 'unlink';
  agent?: AssetAgent;
  /** True when the file itself is a symbolic link (its target is watched). */
  isSymlink?: boolean;
}
