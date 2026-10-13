#!/usr/bin/env node
/**
 * Lockstep release: bump all packages, build everything (dashboard included),
 * publish the five components to registry.npmjs.org, then publish the
 * all-in-one @weavecode/weave AS THE BUNDLE TARBALL — the exact artifact
 * `pnpm pack:weave` produces (bundleDependencies layout, registry install
 * identical to `npm install dist/weavecode-weave-<v>.tgz`).
 *
 *   node scripts/release.mjs 0.2.0            # bump + build + publish
 *   node scripts/release.mjs 0.2.0 --dry-run  # bump + build + pack check
 *
 * Components publish with `pnpm -C` (workspace:^ rewrites); the umbrella
 * publishes the tgz as-is. --no-git-checks: the version bump is intentionally
 * uncommitted at publish time. Never publish with `npm publish`.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packWeaveTgz } from './pack-weave.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://registry.npmjs.org/';
const COMPONENTS = ['weave-core', 'weave-harness', 'weave-templates', 'weave-server', 'weave-cli'];
const UMBRELLA_DIR = 'weave';
const ALL_PACKAGES = [...COMPONENTS, UMBRELLA_DIR];

const [version, ...rest] = process.argv.slice(2);
const dryRun = rest.includes('--dry-run');
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? '')) {
  console.error('usage: node scripts/release.mjs <x.y.z> [--dry-run]');
  process.exit(1);
}

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

if (!dryRun) {
  try {
    console.log(`npm user: ${execSync(`npm whoami --registry=${REGISTRY}`, { encoding: 'utf8' }).trim()}`);
  } catch {
    console.error(`No valid token for ${REGISTRY} (missing or rejected). Run: npm login --registry=${REGISTRY}`);
    process.exit(1);
  }
} else {
  console.log(`dry run — registry credentials not checked`);
}

for (const dir of ALL_PACKAGES) {
  const file = path.join(root, 'packages', dir, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  pkg.version = version;
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`bumped ${pkg.name} -> ${version}`);
}

run('pnpm install');
run('pnpm build');
run('pnpm build:web');

const publishFlags = `--access public --registry=${REGISTRY} --no-git-checks${dryRun ? ' --dry-run' : ''}`;
for (const dir of COMPONENTS) {
  run(`pnpm -C packages/${dir} publish ${publishFlags}`);
}

const tgz = await packWeaveTgz({ skipBuild: true });
run(`pnpm publish ${path.relative(root, tgz)} ${publishFlags}`);

console.log(dryRun ? '\nDry run complete — nothing published.' : `\nPublished ${version}. Tag with: git tag v${version}`);
