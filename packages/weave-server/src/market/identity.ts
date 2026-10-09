import path from 'node:path';
import { marketDir } from './manifest.js';

/**
 * 包所属的市场身份——**判据的唯一实现**（安装分流与 UI 展示同源）。
 *
 * 判据：包目录落在 `<dataDir>/market/<id>/…` 里 = 外部市场导入的包 → 返回该市场
 * id（CC 键 `name@<id>`，文件留在数据目录、可整体迁移）；否则 undefined = weave
 * 自己的包（内置根 `presets/harness-tools`、SPI 插件、手加目录）→ 走 weave 自建
 * 市场 `name@weave`。
 */
export function marketIdOf(packDir: string, marketRoot: string = marketDir()): string | undefined {
  const rel = path.relative(path.resolve(marketRoot), path.resolve(packDir));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  const id = rel.split(path.sep)[0];
  return id ? id : undefined;
}
