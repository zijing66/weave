import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkHarness } from '../init/harness-checks';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'weave-checks-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ids = async (): Promise<string[]> => (await checkHarness(dir)).map((c) => c.id);

/** Write a settings.json whose statusLine points at `scriptPath`. */
async function writeSettings(scriptPath: string): Promise<void> {
  await mkdir(path.join(dir, '.claude'), { recursive: true });
  await writeFile(
    path.join(dir, '.claude', 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: `node "${scriptPath}"`, padding: 0 } }),
  );
}

describe('checkHarness', () => {
  it('reports nothing for a healthy layout', async () => {
    await writeFile(path.join(dir, 'CLAUDE.md'), '# Project\n');
    await symlink('CLAUDE.md', path.join(dir, 'AGENTS.md'));
    await mkdir(path.join(dir, '.claude', 'helpers'), { recursive: true });
    const script = path.join(dir, '.claude', 'helpers', 'statusline.cjs');
    await writeFile(script, '// statusline\n');
    await writeSettings(script);

    expect(await checkHarness(dir)).toEqual([]);
  });

  it('detects a symlink git checked out as a plain file', async () => {
    // exactly what `core.symlinks=false` produces: the target path as content
    await writeFile(path.join(dir, 'CLAUDE.md'), '# Project\n');
    await writeFile(path.join(dir, 'AGENTS.md'), 'CLAUDE.md\n');

    const found = await checkHarness(dir);

    expect(found.map((c) => c.id)).toContain('instruction-link-not-materialised');
    expect(found[0]!.fix).toContain('core.symlinks');
  });

  it('does not mistake prose mentioning the filename for a bad checkout', async () => {
    await writeFile(path.join(dir, 'CLAUDE.md'), '# Project\n');
    await writeFile(path.join(dir, 'AGENTS.md'), '# Project\n\nSee CLAUDE.md for details.\n');

    expect(await ids()).not.toContain('instruction-link-not-materialised');
    // but the duplication itself is still worth flagging
    expect(await ids()).toContain('instruction-files-duplicated');
  });

  it('detects two independent instruction files', async () => {
    await writeFile(path.join(dir, 'CLAUDE.md'), '# Project\n');
    await writeFile(path.join(dir, 'AGENTS.md'), '# Project\n');

    expect(await ids()).toContain('instruction-files-duplicated');
  });

  it('stays quiet when the two names are already linked', async () => {
    await writeFile(path.join(dir, 'CLAUDE.md'), '# Project\n');
    await symlink('CLAUDE.md', path.join(dir, 'AGENTS.md'));

    expect(await ids()).toEqual([]);
  });

  it('detects a dangling instruction symlink', async () => {
    await symlink('CLAUDE.md', path.join(dir, 'AGENTS.md'));

    expect(await ids()).toContain('instruction-link-dangling');
  });

  it('detects a statusLine pointing at another checkout', async () => {
    await writeSettings(path.join(os.tmpdir(), 'somewhere-else', '.claude', 'helpers', 'statusline.cjs'));

    const found = await checkHarness(dir);

    expect(found.map((c) => c.id)).toContain('statusline-path-foreign');
  });

  it('detects a statusLine whose script is missing', async () => {
    await writeSettings(path.join(dir, '.claude', 'helpers', 'statusline.cjs'));

    expect(await ids()).toContain('statusline-script-missing');
  });

  it('ignores a user-authored statusLine that is not weave’s', async () => {
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(
      path.join(dir, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'bunx -y ccstatusline@latest' } }),
    );

    expect(await ids()).toEqual([]);
  });

  it('returns nothing when there is no settings.json at all', async () => {
    expect(await checkHarness(dir)).toEqual([]);
  });
});
