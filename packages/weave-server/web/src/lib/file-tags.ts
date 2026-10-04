/** 文件资产 chips 的单点分类：词表（BUCKET_ORDER）与 category→tags 映射。
 *  chips 暴露全部抽象大类（含 skill/mcp 的 tab 维度）；mods 文件同时挂
 *  plugin（插件本体的一份可见性），helper 折叠进 hooks、rule 折叠进 rules。 */
export const BUCKET_ORDER = [
  'skill',
  'mcp',
  'hooks',
  'workflow',
  'rules',
  'command',
  'agent',
  'output-style',
  'instructions',
  'settings',
  'plugin',
  'mods',
  'other',
] as const;

/** 原始扫描 category（+路径细判）→ chips 标签；mods 是唯一多标签。 */
export function tagsOf(category: string, relPath: string): string[] {
  switch (category) {
    case 'skill':
    case 'mcp':
    case 'workflow':
    case 'command':
    case 'agent':
    case 'output-style':
    case 'instructions':
    case 'settings':
    case 'plugin':
      return [category];
    case 'helper':
      return ['hooks']; // .claude/helpers/ = hook 处理脚本
    case 'rule':
      return ['rules'];
    case 'mods':
      return ['plugin', 'mods'];
    default:
      break;
  }
  if (category === 'other' && relPath.startsWith('.claude/hooks/')) return ['hooks'];
  return ['other'];
}
