#!/usr/bin/env node
/**
 * Pack the all-in-one @weavecode/weave tarball with the five weave packages
 * BUNDLED INSIDE (bundleDependencies layout): `npm install <tgz>` yields a
 * working `weave` with the daemon + dashboard, no registry copies of
 * @weavecode/* needed.
 *
 * The five packages' external deps (zod, chokidar, ink, react, smol-toml + their
 * transitive closure) are bundled too — NOT fetched from the registry at install
 * time. Reason: npm's GLOBAL install trusts a tarball's node_modules as the
 * package's complete tree and never resolves its `dependencies`, so a bundle
 * holding only @weavecode/* lands with empty zod/ink/… directories and the CLI
 * dies on startup (`ERR_MODULE_NOT_FOUND … zod/index.js`). Project-style installs
 * happened to resolve them, global ones never did.
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


/** 打包裁剪：非最终产物不进 tgz（sourcemap / 示例 / 测试 / 仓库元数据）。
 *  运行依赖一个不删——伞包必须自包含（npm -g 不解析 tarball 的 dependencies）。 */
const PRUNE_DIRS = new Set([
  'demo',
  'demos',
  'example',
  'examples',
  'test',
  'tests',
  '__tests__',
  'benchmark',
  'benchmarks',
  '.github',
]);

async function pruneStaged(dir) {
  let removed = 0;
  const walk = async (d) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (PRUNE_DIRS.has(entry.name)) {
          await rm(abs, { recursive: true, force: true });
          removed++;
          continue;
        }
        await walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.map')) {
        await rm(abs, { force: true });
        removed++;
      }
    }
  };
  await walk(dir);
  return removed;
}

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
  // must ride on the umbrella's dependencies (and be bundled with it).
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

  // Externals ride in the tarball as well (see the header): a nested closure so
  // each one carries its own transitive deps — bundleDependencies then pulls the
  // whole subtree in with each top-level name.
  const extNames = Object.keys(externals);
  if (extNames.length > 0) {
    const extStage = path.join(root, 'dist', '.pack-stage', 'ext');
    await mkdir(extStage, { recursive: true });
    await writeFile(
      path.join(extStage, 'package.json'),
      JSON.stringify(
        { name: 'weave-externals-stage', private: true, dependencies: externals },
        null,
        2,
      ) + '\n',
    );
    run('npm install --omit=dev --install-strategy=nested --ignore-scripts --no-audit --no-fund', extStage);
    for (const name of extNames) {
      await cp(path.join(extStage, 'node_modules', name), path.join(stage, 'node_modules', name), {
        recursive: true,
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
        bundleDependencies: [...bundled, ...extNames],
      },
      null,
      2,
    ) + '\n',
  );

  // dist/ 自身 map-free；第三方依赖里仍有大量 .map / demo / test，统一在暂存区裁掉
  // （只删非最终产物，运行文件与许可证一个不动）。
  const pruned = await pruneStaged(path.join(stage, 'node_modules'));
  console.log(`
pruned ${pruned} non-runtime entries (.map / demo / test)`);

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
