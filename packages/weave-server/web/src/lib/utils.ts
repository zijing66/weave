import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/** twMerge 不认识自定义的纯数字字号刻度（text-10 等），会把它们当颜色类、
 *  与 text-{color} 互相冲突吞掉（Badge 字号失踪回落 16px 的根源）——显式
 *  登记进 font-size 组。 */
const twMergeWithScales = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['8', '9', '10', '11', '12', '13'] }],
    },
  },
});

/** Merge tailwind classes with conflict resolution. */
export function cn(...inputs: ClassValue[]): string {
  return twMergeWithScales(clsx(inputs));
}

/** absPath 的显示形：家目录内的路径显示成 `~/…`（posix 分隔），其余原样。
 *  `home` 缺失（路由未带）时退回绝对路径原样。 */
export function tildePath(absPath: string, home: string | null): string {
  if (!home) return absPath;
  const norm = absPath.replaceAll('\\', '/');
  const homeNorm = home.replaceAll('\\', '/').replace(/\/$/, '');
  if (norm === homeNorm) return '~';
  if (norm.startsWith(`${homeNorm}/`)) return `~/${norm.slice(homeNorm.length + 1)}`;
  return absPath;
}
