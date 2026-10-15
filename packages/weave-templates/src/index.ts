import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TemplateEntry {
  name: string;
  category: 'skill' | 'command' | 'agent';
  /** Path relative to this package root */
  sourcePath: string;
  description: string;
}

/**
 * Map of category → entries. Adding a template = adding one line here + the .md file
 * in the built-in repo's `init/` (commands carry no frontmatter; agents must carry
 * `name` + `description` frontmatter or the host won't register them — keep it in
 * sync with the description here).
 */
const MANIFEST: TemplateEntry[] = [
  // Skills（仓内不自带可直拷的 skill——skills 由仓内插件包提供）
  // Commands
  { name: 'review', category: 'command', sourcePath: 'resources/weave-market/init/commands/review.md', description: 'Review branch changes' },
  { name: 'scaffold', category: 'command', sourcePath: 'resources/weave-market/init/commands/scaffold.md', description: 'Generate component scaffold' },
  { name: 'explain', category: 'command', sourcePath: 'resources/weave-market/init/commands/explain.md', description: 'Explain selected code' },
  { name: 'test', category: 'command', sourcePath: 'resources/weave-market/init/commands/test.md', description: 'Write or update tests' },
  // Agents
  { name: 'writer', category: 'agent', sourcePath: 'resources/weave-market/init/agents/writer.md', description: 'Focused drafting agent' },
  { name: 'reviewer', category: 'agent', sourcePath: 'resources/weave-market/init/agents/reviewer.md', description: 'Critical review specialist' },
  { name: 'researcher', category: 'agent', sourcePath: 'resources/weave-market/init/agents/researcher.md', description: 'Exploration and analysis agent' },
  { name: 'planner', category: 'agent', sourcePath: 'resources/weave-market/init/agents/planner.md', description: 'Planning and design agent' },
];

export class TemplateRegistry {
  private entries: TemplateEntry[];
  /** 插件注册的条目（sourcePath 为插件目录内的绝对路径）。 */
  private pluginEntries: TemplateEntry[] = [];

  constructor() {
    this.entries = [...MANIFEST];
  }

  /**
   * 注册插件模板（扩展点③）：name 冲突时拒绝（内置优先），返回是否注册成功。
   * sourcePath 允许绝对路径（插件目录内），resolvePath 对绝对路径原样返回。
   */
  register(entry: TemplateEntry): boolean {
    if (this.getByName(entry.name)) return false;
    this.pluginEntries.push(entry);
    return true;
  }

  /** 某插件注册的全部条目（name 形如 `<pluginId>:<模板名>` 由调用方保证唯一）。 */
  getPluginEntries(pluginId: string): TemplateEntry[] {
    return this.pluginEntries.filter((e) => e.name.startsWith(`${pluginId}:`));
  }

  getByCategory(category: TemplateEntry['category']): TemplateEntry[] {
    return [...this.entries, ...this.pluginEntries].filter(e => e.category === category);
  }

  getByName(name: string): TemplateEntry | undefined {
    return [...this.entries, ...this.pluginEntries].find(e => e.name === name);
  }

  /** Resolve to absolute filesystem path（插件条目的 sourcePath 已是绝对路径）。 */
  resolvePath(entry: TemplateEntry): string {
    return path.isAbsolute(entry.sourcePath) ? entry.sourcePath : path.join(__dirname, entry.sourcePath);
  }

  /** Get absolute source directory for skill templates (used by init executor) */
  getSkillsSourceDir(): string {
    // 仓内不自带可直拷的 skill 目录：技能一律以包形态供货（plugins/*/skills/），
    // 经工具箱按项目启停，故此处保持「无此目录」= 该步 no-op。
    return path.join(builtinMarketRoot(), 'skills');
  }

  /** Get absolute source directory for command templates */
  getCommandsSourceDir(): string {
    return path.join(builtinMarketRoot(), 'init', 'commands');
  }

  /** Get absolute source directory for agent templates */
  getAgentsSourceDir(): string {
    return path.join(builtinMarketRoot(), 'init', 'agents');
  }

  getAll(): TemplateEntry[] {
    return [...this.entries, ...this.pluginEntries];
  }
}

export const templateRegistry = new TemplateRegistry();

/**
 * 内置仓根（市场形态，随本包发布）：`<pkg>/resources/weave-market/`。
 * 开发态 `__dirname` 落在 `src/`、发布态落在 `dist/`，两侧都拷到同级同名目录，
 * 故同一表达式两态皆准。
 *
 * 布局（层级是硬约束，见 docs/plan/builtin-market-repo.md D1）：
 * - `plugins/` —— toolkit 扫描根，**其直接子目录必须是 scope**（core-skills 等）；
 * - `rules/`   —— SPI 平铺装载根（weave 规则包，不走 toolkit 列表）；
 * - `init/`    —— init 的 commands/agents 供源（非包、无开关）。
 */
export function builtinMarketRoot(): string {
  return path.join(__dirname, 'resources', 'weave-market');
}

/** 内置工具包扫描根（toolkit 的 `discoverToolkitPacks` 入口）。 */
export function builtinPacksRoot(): string {
  return path.join(builtinMarketRoot(), 'plugins');
}

/** 内置 SPI 规则包的平铺装载根。 */
export function builtinRulesRoot(): string {
  return path.join(builtinMarketRoot(), 'rules');
}
