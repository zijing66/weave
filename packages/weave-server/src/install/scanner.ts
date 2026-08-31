import { readdir, readFile } from 'node:fs/promises';
import { join, basename, relative, dirname } from 'node:path';

export interface SkillAsset {
  /** Skill name — the containing directory's basename. */
  name: string;
  /** Absolute path to the skill directory (copy this whole tree). */
  dirPath: string;
  /** Path relative to the library root (for display). */
  relPath: string;
  /**
   * The skill's parent directory (typically a `skills/` folder) relative to the
   * library root. Skills sharing a parent group together in the panel; an empty
   * string means the skill sits directly under the library root.
   */
  group: string;
}

/** Minimal MCP server template (matches Claude Code `.mcp.json` entry shape). */
export interface McpTemplate {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Absolute path to the JSON file this template was loaded from. */
  sourcePath: string;
  /** Path relative to the library root (for display). */
  relPath: string;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
]);

/**
 * Recursively scan a library directory for skills. A skill is any directory
 * that directly contains a `SKILL.md` file. Once a skill directory is found we
 * do NOT descend into it (its `assets/`, `scripts/`, `references/` subtrees are
 * part of the skill, not separate skills).
 *
 * Handles both library layouts: weave-templates (`templates/skills/<name>/SKILL.md`)
 * and personal libraries like zj-skills (`<name>/SKILL.md` at the top level).
 */
export async function scanLibrarySkills(libPath: string): Promise<SkillAsset[]> {
  const results: SkillAsset[] = [];
  await walk(libPath, libPath, results);
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

async function walk(root: string, dir: string, out: SkillAsset[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable / missing — skip
  }

  if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
    out.push({
      name: basename(dir),
      dirPath: dir,
      relPath: relative(root, dir).replace(/\\/g, '/'),
      group: relative(root, dirname(dir)).replace(/\\/g, '/'),
    });
    return; // do not descend into a skill's own subtree
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    await walk(root, join(dir, entry.name), out);
  }
}

/**
 * Scan a library for MCP server templates. A template is a JSON file that
 * either (a) IS a single server config `{ command, args?, env? }` named after
 * its file stem, or (b) wraps multiple servers under `mcpServers`. Two file
 * layouts are recognised: `<lib>/mcp/<name>.json` and `<lib>/<name>.mcp.json`.
 * Files that fail to parse are skipped (never throw).
 */
export async function scanLibraryMcp(libPath: string): Promise<McpTemplate[]> {
  const files: { abs: string; rel: string }[] = [];
  await collectMcpFiles(libPath, libPath, files);
  const out: McpTemplate[] = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(await readFile(f.abs, 'utf-8')) as unknown;
      pushTemplates(parsed, f, out);
    } catch {
      // malformed JSON — skip
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function collectMcpFiles(root: string, dir: string, out: { abs: string; rel: string }[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      await collectMcpFiles(root, join(dir, e.name), out);
    } else if (e.isFile()) {
      const stem = e.name.replace(/\.mcp\.json$/i, '').replace(/\.json$/i, '');
      // accept *.mcp.json anywhere, or *.json directly under a `mcp/` dir
      const isMcpJson = /\.mcp\.json$/i.test(e.name);
      const inMcpDir = basename(dir) === 'mcp' && /\.json$/i.test(e.name);
      if ((isMcpJson || inMcpDir) && stem) {
        out.push({ abs: join(dir, e.name), rel: relative(root, join(dir, e.name)).replace(/\\/g, '/') });
      }
    }
  }
}

function pushTemplates(
  parsed: unknown,
  file: { abs: string; rel: string },
  out: McpTemplate[],
): void {
  const stem = file.rel.replace(/\.mcp\.json$/i, '').replace(/\.json$/i, '').replace(/^.*\//, '');
  // Shape (b): { mcpServers: { <name>: { command, ... } } }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const servers = obj.mcpServers;
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
        const t = asTemplate(name, cfg);
        if (t) out.push({ ...t, sourcePath: file.abs, relPath: file.rel });
      }
      return;
    }
    // Shape (a): single server config, named after the file stem
    const t = asTemplate(stem, obj);
    if (t) out.push({ ...t, sourcePath: file.abs, relPath: file.rel });
  }
}

function asTemplate(name: string, cfg: unknown): { name: string; command: string; args?: string[]; env?: Record<string, string> } | null {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  const c = cfg as Record<string, unknown>;
  if (typeof c.command !== 'string' || !c.command) return null;
  const t: { name: string; command: string; args?: string[]; env?: Record<string, string> } = {
    name,
    command: c.command,
  };
  if (Array.isArray(c.args)) t.args = c.args.filter((a) => typeof a === 'string');
  if (c.env && typeof c.env === 'object' && !Array.isArray(c.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.env as Record<string, unknown>)) {
      if (typeof v === 'string') env[k] = v;
    }
    if (Object.keys(env).length) t.env = env;
  }
  return t;
}
