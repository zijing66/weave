#!/usr/bin/env node
/**
 * Pack the all-in-one @weavecode/weave tarball with the five weave packages
 * BUNDLED INSIDE (bundleDependencies layout): `npm install <tgz>` yields a
 * working `weave` with the daemon + dashboard, no registry copies of
 * @weavecode/* needed. External deps (zod, ink, react, …) still resolve from
 * the registry at install time — only the weave monorepo is bundled.
 *
 *   node scripts/pack-weave.mjs [--skip-build]   → dist/weavecode-weave-<v>.tgz
 *
 * Stages a plain directory (real file copies, workspace:^ rewritten to real
 * versions) and runs `npm pack` on it — npm pack is the only tarball step that
 * honours bundleDependencies (node_modules/* is otherwise always excluded).
 *
 * `scripts/release.mjs` imports packWeaveTgz() and publishes the very same
 * tarball — the registry artifact and `pnpm pack:weave` output are one file.
 * Publishing still only ever goes through pnpm.
 */
import { execSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['weave-core', 'weave-harness', 'weave-templates', 'weave-server', 'weave-cli'];

const run = (cmd, cwd = root) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

/**
 * Stage the bundle and pack it. Returns the produced tarball's absolute path
 * (dist/ keeps the artifact; the staging directory is removed).
 */
export async function packWeaveTgz({ skipBuild = false } = {}) {
  if (!skipBuild) {
    run('pnpm build');
    run('pnpm build:web');
  }

  /** Lockstep is the norm, but exact versions come from each package itself. */
  const versionOf = {};
  for (const dir of PACKAGES) {
    const pkg = JSON.parse(await readFile(path.join(root, 'packages', dir, 'package.json'), 'utf8'));
    versionOf[pkg.name] = pkg.version;
  }

  const umbrella = JSON.parse(await readFile(path.join(root, 'packages', 'weave', 'package.json'), 'utf8'));
  const stage = path.join(root, 'dist', '.pack-stage', 'weavecode-weave');
  await rm(path.dirname(stage), { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  // Bundled copies: each package's publishable content + its manifest with
  // workspace:^ ranges rewritten to the real versions (they are real files now,
  // not symlinks — the ranges only matter to npm's tree builder).
  // Externals (zod/ink/…) are collected across the five: npm treats a bundle as
  // self-contained and does NOT fetch bundled packages' own deps, so the union
  // must ride on the umbrella's dependencies to be installed at top level.
  const externals = {};
  for (const dir of PACKAGES) {
    const src = path.join(root, 'packages', dir);
    const pkg = JSON.parse(await readFile(path.join(src, 'package.json'), 'utf8'));
    const dest = path.join(stage, 'node_modules', pkg.name);
    await mkdir(dest, { recursive: true });

    const manifest = {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      type: pkg.type,
      main: pkg.main,
      types: pkg.types,
      exports: pkg.exports,
      bin: pkg.bin,
      sideEffects: pkg.sideEffects,
      author: pkg.author,
      license: pkg.license,
      engines: pkg.engines,
      dependencies: Object.fromEntries(
        Object.entries(pkg.dependencies ?? {}).map(([k, v]) => [
          k,
          versionOf[k] ? `^${versionOf[k]}` : v,
        ]),
      ),
    };
    await writeFile(path.join(dest, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      if (!versionOf[name]) externals[name] = range;
    }

    for (const entry of ['dist', 'bin', 'web/dist', 'THIRD_PARTY_NOTICES.md']) {
      await cp(path.join(src, entry), path.join(dest, entry), { recursive: true, force: false })
        .catch((err) => {
          if (err.code !== 'ENOENT' && err.code !== 'ERR_FS_CP_EEXIST') throw err;
        });
    }
  }

  // Umbrella manifest: the five are BOTH dependencies (npm requirement) and
  // bundleDependencies (include them in the tarball instead of fetching).
  await cp(path.join(root, 'packages', 'weave', 'bin'), path.join(stage, 'bin'), { recursive: true });
  await cp(path.join(root, 'packages', 'weave', 'README.md'), path.join(stage, 'README.md'));
  await cp(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
  const bundled = PACKAGES.map((d) => `@weavecode/${d.replace('weave-', '')}`);
  await writeFile(
    path.join(stage, 'package.json'),
    JSON.stringify(
      {
        ...umbrella,
        description: `${umbrella.description} (self-contained bundle)`,
        dependencies: {
          ...Object.fromEntries(bundled.map((n) => [n, `^${versionOf[n]}`])),
          ...externals,
        },
        bundleDependencies: bundled,
      },
      null,
      2,
    ) + '\n',
  );

  // dist/ is built map-free (tsconfig.base: no sourceMap/declarationMap), so
  // the staged copies are clean without any pack-time filtering.

  // Windows: spawning 'npm.cmd' without a shell is refused outright
  // (CVE-2024-27980 guard), so this one call goes through a shell — as a
  // single quoted command string (arg arrays + shell are the DEP0190 no-no).
  const outDir = path.join(root, 'dist');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packCmd = `${npm} pack "${stage}" --pack-destination "${outDir}"`;
  console.log(`\n$ ${packCmd}`);
  execSync(packCmd, { stdio: 'inherit' });
  await rm(path.dirname(stage), { recursive: true, force: true });

  const tgzName = `weavecode-weave-${umbrella.version}.tgz`;
  if (!(await readdir(outDir)).includes(tgzName)) {
    throw new Error(`npm pack produced no ${tgzName} in dist/`);
  }
  return path.join(outDir, tgzName);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packWeaveTgz({ skipBuild: process.argv.includes('--skip-build') })
    .then((tgz) => console.log(`\n→ ${path.relative(root, tgz)}`))
    .catch((err) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : err);
      process.exit(1);
    });
}
