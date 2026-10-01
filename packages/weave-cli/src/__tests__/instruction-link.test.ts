import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readlink, lstat, mkdir, readdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureInstructionLink, type InstructionLinkOptions } from '../init/instruction-link';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'weave-link-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Options that never prompt and take the documented default. */
const opts = (over: Partial<InstructionLinkOptions> = {}): InstructionLinkOptions => ({
  force: false,
  interactive: false,
  confirm: async () => true,
  ...over,
});

describe('ensureInstructionLink', () => {
  it('links AGENTS.md -> CLAUDE.md when neither file exists', async () => {
    const result = await ensureInstructionLink(dir, opts());

    expect(result).toEqual({ action: 'created', realFile: 'CLAUDE.md' });
    expect(await readlink(path.join(dir, 'AGENTS.md'))).toBe('CLAUDE.md');
  });

  it('uses a relative target so the link survives a clone', async () => {
    await ensureInstructionLink(dir, opts());
    const target = await readlink(path.join(dir, 'AGENTS.md'));
    expect(path.isAbsolute(target)).toBe(false);
    expect(target).toBe('CLAUDE.md');
  });

  it('links to an existing CLAUDE.md without touching its content', async () => {
    await writeFile(path.join(dir, 'CLAUDE.md'), '# Project\n\nNotes.\n');

    const result = await ensureInstructionLink(dir, opts());

    expect(result.action).toBe('created');
    expect((await lstat(path.join(dir, 'AGENTS.md'))).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(dir, 'CLAUDE.md'), 'utf-8')).toBe('# Project\n\nNotes.\n');
  });

  it('adopts an existing AGENTS.md, linking CLAUDE.md back to it', async () => {
    await writeFile(path.join(dir, 'AGENTS.md'), '# Project\n\nAgent notes.\n');

    const result = await ensureInstructionLink(dir, opts());

    expect(result).toEqual({ action: 'adopted', realFile: 'AGENTS.md' });
    expect(await readlink(path.join(dir, 'CLAUDE.md'))).toBe('AGENTS.md');
    expect(await readFile(path.join(dir, 'AGENTS.md'), 'utf-8')).toContain('Agent notes.');
  });

  it('replaces a duplicate AGENTS.md, backing the old content up first', async () => {
    await writeFile(path.join(dir, 'CLAUDE.md'), 'claude body');
    await writeFile(path.join(dir, 'AGENTS.md'), 'agents body');

    const result = await ensureInstructionLink(dir, opts());

    expect(result.action).toBe('replaced');
    expect(result.backedUpTo).toBeDefined();
    expect(await readFile(result.backedUpTo!, 'utf-8')).toBe('agents body');
    expect(await readlink(path.join(dir, 'AGENTS.md'))).toBe('CLAUDE.md');
    // the backup lives under the self-ignored .weave/ dir, not the project root
    expect(result.backedUpTo!.startsWith(path.join(dir, '.weave', 'backup'))).toBe(true);
  });

  it('asks before displacing AGENTS.md, and leaves both when declined', async () => {
    await writeFile(path.join(dir, 'CLAUDE.md'), 'claude body');
    await writeFile(path.join(dir, 'AGENTS.md'), 'agents body');
    const confirm = vi.fn(async () => false);

    const result = await ensureInstructionLink(dir, opts({ interactive: true, confirm }));

    expect(confirm).toHaveBeenCalledOnce();
    expect(result.action).toBe('unchanged');
    expect((await lstat(path.join(dir, 'AGENTS.md'))).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(dir, 'AGENTS.md'), 'utf-8')).toBe('agents body');
  });

  it('--force takes the default without asking', async () => {
    await writeFile(path.join(dir, 'CLAUDE.md'), 'claude body');
    await writeFile(path.join(dir, 'AGENTS.md'), 'agents body');
    const confirm = vi.fn(async () => false);

    const result = await ensureInstructionLink(dir, opts({ force: true, confirm }));

    expect(confirm).not.toHaveBeenCalled();
    expect(result.action).toBe('replaced');
  });

  it('is idempotent once the link is correct', async () => {
    await writeFile(path.join(dir, 'CLAUDE.md'), 'body');
    await ensureInstructionLink(dir, opts());
    const confirm = vi.fn(async () => true);

    const again = await ensureInstructionLink(dir, opts({ confirm }));

    expect(again.action).toBe('unchanged');
    expect(confirm).not.toHaveBeenCalled();
    await expect(readdir(path.join(dir, '.weave', 'backup'))).rejects.toThrow();
  });

  it('recognises a link whose target the caller has not written yet', async () => {
    // the executor links first, then writes CLAUDE.md — an interrupted run
    // leaves the link dangling, which must not look like a conflict
    await ensureInstructionLink(dir, opts());
    expect((await lstat(path.join(dir, 'AGENTS.md'))).isSymbolicLink()).toBe(true);

    const confirm = vi.fn(async () => true);
    const again = await ensureInstructionLink(dir, opts({ confirm }));

    expect(again).toEqual({ action: 'unchanged', realFile: 'CLAUDE.md' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('repairs a dangling CLAUDE.md symlink left by an older layout', async () => {
    // CLAUDE.md points at an AGENTS.md that does not exist; the canonical
    // arrangement is the other way round, so the stale link is replaced
    await symlink('AGENTS.md', path.join(dir, 'CLAUDE.md'));

    const result = await ensureInstructionLink(dir, opts());

    expect(result).toEqual({ action: 'created', realFile: 'CLAUDE.md' });
    expect(await readlink(path.join(dir, 'AGENTS.md'))).toBe('CLAUDE.md');
    // the stale link is gone — the caller writes CLAUDE.md next
    await expect(lstat(path.join(dir, 'CLAUDE.md'))).rejects.toThrow();
  });

  it('leaves the conflicting files alone when the user declines', async () => {
    await mkdir(path.join(dir, '.weave'), { recursive: true });
    await writeFile(path.join(dir, 'CLAUDE.md'), 'claude body');
    await writeFile(path.join(dir, 'AGENTS.md'), 'agents body');

    await ensureInstructionLink(dir, opts({ confirm: async () => false }));

    expect(await readFile(path.join(dir, 'AGENTS.md'), 'utf-8')).toBe('agents body');
  });
});
