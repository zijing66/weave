import yaml from 'js-yaml';

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown> | null;
  body: string;
}

/**
 * Split a markdown document into YAML frontmatter and body. The frontmatter is
 * a leading `---\n...\n---` block (Obsidian-style); when absent or invalid the
 * whole input is returned as the body.
 */
export function splitFrontmatter(raw: string): ParsedMarkdown {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: null, body: raw };
  const body = raw.slice(match[0].length);
  try {
    const parsed = yaml.load(match[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { frontmatter: parsed as Record<string, unknown>, body };
    }
  } catch {
    // invalid YAML — fall through, keep the raw block in the body
  }
  return { frontmatter: null, body: raw };
}
