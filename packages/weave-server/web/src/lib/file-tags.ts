/** 资源管理 chips 的单点分类：词表（BUCKET_ORDER）与 category→tags 映射。
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
      return ['hooks']; // helper = hook 处理脚本
    case 'rule':
      return ['rules'];
    case 'mods':
      return ['plugin', 'mods'];
    default:
      break;
  }
  // hook 脚本（未归入 helper 类别）住在任意 harness 的 hooks/ 目录下——按目录段
  // 判定，不写死具体 harness 根。
  if (category === 'other' && /(^|\/)hooks\//.test(relPath)) return ['hooks'];
  return ['other'];
}

/* One colour family per tag, expressed in TEXT COLOUR ONLY: both the
 * filter chips and the row tags keep the same grey background, so the hue is
 * what distinguishes buckets. Selected chips additionally get a highlight ring.
 * (Tailwind needs literal class strings, hence no template.) */
export const KIND_COLORS: Record<string, { on: string; off: string }> = {
  instructions: {
    on: 'text-teal-200',
    off: 'text-teal-300/50 hover:text-teal-200',
  },
  command: { on: 'text-purple-200', off: 'text-purple-300/50 hover:text-purple-200' },
  agent: { on: 'text-emerald-200', off: 'text-emerald-300/50 hover:text-emerald-200' },
  hooks: { on: 'text-amber-200', off: 'text-amber-300/50 hover:text-amber-200' },
  rules: { on: 'text-rose-200', off: 'text-rose-300/50 hover:text-rose-200' },
  'output-style': {
    on: 'text-fuchsia-200',
    off: 'text-fuchsia-300/50 hover:text-fuchsia-200',
  },
  workflow: { on: 'text-orange-200', off: 'text-orange-300/50 hover:text-orange-200' },
  settings: { on: 'text-cyan-200', off: 'text-cyan-300/50 hover:text-cyan-200' },
  plugin: { on: 'text-indigo-200', off: 'text-indigo-300/50 hover:text-indigo-200' },
  mods: { on: 'text-violet-200', off: 'text-violet-300/50 hover:text-violet-200' },
  other: { on: 'text-neutral-200', off: 'text-neutral-400/70 hover:text-neutral-200' },
  // tab 专属类别同样进 chips 与行 tag
  skill: { on: 'text-lime-200', off: 'text-lime-300/50 hover:text-lime-200' },
  mcp: { on: 'text-sky-200', off: 'text-sky-300/50 hover:text-sky-200' },
};

/** Palette for a kind — unknown future kinds fall back to neutral. */
export const kindColor = (kind: string) => KIND_COLORS[kind] ?? KIND_COLORS.other;

/** Shared grey tag shell for rows — same background as the filter chips. */
export const ROW_TAG_BASE =
  'shrink-0 rounded-full border border-transparent bg-neutral-800/60 px-1.5 py-0 text-[10px] font-medium font-sans';

/* 仓库 namespace 标记（行内，排在类别 tag 之后）。namespace 是**数据**（仓库名），
 * 不是 BUCKET_ORDER 那套固定类别词表的一员，所以它既不进 chips 计数，也不吃
 * KIND_COLORS；与类别 tag 同壳但换成描边——一列彩字说「这是什么」，一个描边说
 * 「谁铺的」，不靠猜。 */
export const NAMESPACE_TAG = 'border-neutral-700 bg-transparent text-neutral-400';
