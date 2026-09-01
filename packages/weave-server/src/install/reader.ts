import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { AssetNotFoundError } from './installer.js';

/**
 * Project file reader — serves text content of Claude Code assets for the
 * dashboard (e.g. a skill's `SKILL.md`). Pure read: the watch service observes
 * `.claude/` and `.mcp.json`, so edits made elsewhere still flow through SSE.
 *
 * Access is confined to the allowed roots: `.claude/` and `.codex/` (any
 * depth), the MCP config (`.mcp.json`), and the instruction files
 * (`CLAUDE.md` / `AGENTS.md`). Path traversal and absolute paths are rejected
 * before touching the filesystem.
 */

/** A project-relative path tried to escape its allowed roots. */
export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathEscapeError';
  }
}

/** A requested file exceeds the size cap. */
export class FileTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileTooLargeError';
  }
}

export interface ProjectFile {
  content: string;
  size: number;
}

/** Maximum bytes returned by the reader (keep payloads small for the browser). */
export const MAX_BYTES = 512 * 1024;

/**
 * Resolve a project-relative path and ensure it stays inside the allowed roots.
 * Rejects absolute paths and any segment equal to `..`.
 */
export function resolveProjectFile(projectPath: string, relPath: string): string {
  const posix = path.normalize(relPath).replace(/\\/g, '/');

  if (path.isAbsolute(relPath)) {
    throw new PathEscapeError(`Absolute paths are not allowed: "${relPath}"`);
  }
  if (posix.split('/').some((seg) => seg === '..')) {
    throw new PathEscapeError(`Path traversal is not allowed: "${relPath}"`);
  }

  const allowed =
    posix === '.mcp.json' ||
    posix === 'CLAUDE.md' ||
    posix === 'AGENTS.md' ||
    posix === '.claude' ||
    posix.startsWith('.claude/') ||
    posix === '.codex' ||
    posix.startsWith('.codex/');
  if (!allowed) {
    throw new PathEscapeError(`Path is outside the allowed roots: "${relPath}"`);
  }

  const abs = path.join(projectPath, posix);
  // Final containment guard (defence in depth against platform separator tricks).
  const root = projectPath.endsWith(path.sep) ? projectPath : projectPath + path.sep;
  if (abs !== projectPath && !abs.startsWith(root)) {
    throw new PathEscapeError(`Resolved path escapes the project: "${relPath}"`);
  }
  return abs;
}

/** Read a text file from the project, enforcing the allowed-root + size limits. */
export async function readProjectFile(projectPath: string, relPath: string): Promise<ProjectFile> {
  const abs = resolveProjectFile(projectPath, relPath);
  let s;
  try {
    s = await stat(abs);
  } catch {
    throw new AssetNotFoundError(`File not found: "${relPath}"`);
  }
  if (!s.isFile()) {
    throw new AssetNotFoundError(`Not a file: "${relPath}"`);
  }
  if (s.size > MAX_BYTES) {
    throw new FileTooLargeError(`File exceeds ${MAX_BYTES} bytes: "${relPath}"`);
  }
  const content = await readFile(abs, 'utf-8');
  return { content, size: s.size };
}
