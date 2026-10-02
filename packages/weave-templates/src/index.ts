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

/** Map of category → entries. Adding a template = adding one line here + the .md file. */
const MANIFEST: TemplateEntry[] = [
  // Skills
  { name: 'code-review', category: 'skill', sourcePath: 'templates/skills/code-review', description: 'Code review best practices' },
  { name: 'project-navigation', category: 'skill', sourcePath: 'templates/skills/project-navigation', description: 'Project navigation and code location' },
  { name: 'testing', category: 'skill', sourcePath: 'templates/skills/testing', description: 'Testing guidelines and strategies' },
  { name: 'refactoring', category: 'skill', sourcePath: 'templates/skills/refactoring', description: 'Safe refactoring methodology' },
  // Commands
  { name: 'review', category: 'command', sourcePath: 'templates/commands/review.md', description: 'Review branch changes' },
  { name: 'scaffold', category: 'command', sourcePath: 'templates/commands/scaffold.md', description: 'Generate component scaffold' },
  { name: 'explain', category: 'command', sourcePath: 'templates/commands/explain.md', description: 'Explain selected code' },
  { name: 'test', category: 'command', sourcePath: 'templates/commands/test.md', description: 'Write or update tests' },
  // Agents
  { name: 'coder', category: 'agent', sourcePath: 'templates/agents/coder.md', description: 'Focused implementation agent' },
  { name: 'reviewer', category: 'agent', sourcePath: 'templates/agents/reviewer.md', description: 'Code review specialist' },
  { name: 'researcher', category: 'agent', sourcePath: 'templates/agents/researcher.md', description: 'Exploration and analysis agent' },
  { name: 'planner', category: 'agent', sourcePath: 'templates/agents/planner.md', description: 'Architecture and planning agent' },
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
    return path.join(__dirname, 'templates', 'skills');
  }

  /** Get absolute source directory for command templates */
  getCommandsSourceDir(): string {
    return path.join(__dirname, 'templates', 'commands');
  }

  /** Get absolute source directory for agent templates */
  getAgentsSourceDir(): string {
    return path.join(__dirname, 'templates', 'agents');
  }

  getAll(): TemplateEntry[] {
    return [...this.entries, ...this.pluginEntries];
  }
}

export const templateRegistry = new TemplateRegistry();
