#!/usr/bin/env node
/**
 * Lockstep release for the five publishable packages: bump, build everything
 * (dashboard included), then pnpm-publish to registry.npmjs.org.
 *
 *   node scripts/release.mjs 0.2.0            # bump + build + publish
 *   node scripts/release.mjs 0.2.0 --dry-run  # bump + build + pack check
 *
 * `pnpm publish` rewrites workspace: deps — never publish with `npm publish`.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://registry.npmjs.org/';
const PACKAGES = ['weave-core', 'weave-harness', 'weave-templates', 'weave-server', 'weave-cli'];

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

try {
  console.log(`npm user: ${execSync(`npm whoami --registry=${REGISTRY}`, { encoding: 'utf8' }).trim()}`);
} catch {
  console.error(`Not logged in. Run: npm login --registry=${REGISTRY}`);
  process.exit(1);
}

for (const dir of PACKAGES) {
  const file = path.join(root, 'packages', dir, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  pkg.version = version;
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`bumped ${pkg.name} -> ${version}`);
}

run('pnpm install');
run('pnpm build');
run('pnpm build:web');
run(`pnpm -r publish --access public --registry=${REGISTRY}${dryRun ? ' --dry-run' : ''}`);

console.log(dryRun ? '\nDry run complete — nothing published.' : `\nPublished ${version}. Tag with: git tag v${version}`);
