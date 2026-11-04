#!/usr/bin/env node
/**
 * Lockstep release: bump all packages, build everything (dashboard included),
 * then publish the all-in-one @weavecode/weave AS THE BUNDLE TARBALL — the
 * exact artifact `pnpm pack:weave` produces (bundleDependencies layout,
 * registry install identical to `npm install dist/weavecode-weave-<v>.tgz`).
 *
 *   node scripts/release.mjs 0.2.0            # bump + build + publish
 *   node scripts/release.mjs 0.2.0 --dry-run  # bump + build + pack check
 *
 * The five components are `private` and ride inside that tarball — only the
 * umbrella is ever published, so a global install pulls one artifact from the
 * registry and nothing else. The tgz goes out as-is (workspace:^ rewritten by
 * pack-weave). --no-git-checks: the version bump is intentionally uncommitted
 * at publish time. Never publish with `npm publish`.
 */
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packWeaveTgz } from './pack-weave.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://registry.npmjs.org/';
const REGISTRY_HOST = 'registry.npmjs.org';
const COMPONENTS = ['weave-core', 'weave-harness', 'weave-templates', 'weave-server', 'weave-cli'];
const UMBRELLA_DIR = 'weave';
const ALL_PACKAGES = [...COMPONENTS, UMBRELLA_DIR];
// 与 scripts/bump-version.mjs 的 TARGETS 同一份清单：根也算一处，漏了它
// version:check 立刻报漂移。
const VERSION_FILES = ['package.json', ...ALL_PACKAGES.map((d) => `packages/${d}/package.json`)];

const [version, ...rest] = process.argv.slice(2);
const dryRun = rest.includes('--dry-run');
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? '')) {
  console.error('usage: node scripts/release.mjs <x.y.z> [--dry-run] [--proxy host:port]');
  process.exit(1);
}

// 发布出口代理（可选）：`--proxy host:port` 或 env HTTPS_PROXY。**只挂给
// publish/whoami 这两步**（install 走代理反而卡死——依赖走本地 mirror 快路）。
const proxyArgIdx = rest.indexOf('--proxy');
const PROXY = proxyArgIdx !== -1 ? rest[proxyArgIdx + 1] : process.env.HTTPS_PROXY || process.env.https_proxy || '';

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

/** 带/不带代理地跑：PROXY 未配置时与 run 等价（发布出口那两步用）。 */
function runWithProxy(cmd, opts = {}) {
  const env = PROXY
    ? { ...process.env, HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY, NO_PROXY: 'localhost,127.0.0.1' }
    : process.env;
  console.log(`\n$ ${cmd}${PROXY ? '  (via proxy)' : ''}`);
  execSync(cmd, { cwd: root, stdio: 'inherit', ...opts, env });
}

if (!dryRun) {
  // DNS 哨兵（2026-11-04 定案）：公司 DNS 曾把 registry 解到内网假源（10.x），
  // 伪造 401 冤枉 token 一轮。系统解析全落内网段而 8.8.8.8 解到公网 → 提示修
  // hosts（真 IP 由公共 DNS 现查现给，不写死）。只提示不拦截。
  try {
    const lookup = (server) =>
      execFileSync('nslookup', [REGISTRY_HOST, ...(server ? [server] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const ipsOf = (out) => [...out.matchAll(/((?:\d{1,3}\.){3}\d{1,3})/g)].map((m) => m[1]).filter((ip) => ip !== '8.8.8.8');
    const isPrivate = (ip) => /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip);
    const sysIps = ipsOf(lookup());
    const pubIps = ipsOf(lookup('8.8.8.8'));
    if (sysIps.length > 0 && sysIps.every(isPrivate) && pubIps.some((ip) => !isPrivate(ip))) {
      const fix = pubIps.find((ip) => !isPrivate(ip));
      console.error(`[release] DNS hijack suspected: ${REGISTRY_HOST} -> private ${sysIps.join(', ')} (public: ${pubIps.slice(0, 2).join(', ')})`);
      console.error(`[release] Fix: add "${fix} ${REGISTRY_HOST}" to your hosts file, or pass --proxy.`);
    }
  } catch {
    // 解析工具缺席/失败不挡发布
  }

  try {
    // 输出要捕获（stdio 不能 inherit），proxy env 就地注入
    const env = PROXY
      ? { ...process.env, HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY, NO_PROXY: 'localhost,127.0.0.1' }
      : process.env;
    const who = execSync(`npm whoami --registry=${REGISTRY}`, { encoding: 'utf8', env }).trim();
    console.log(`npm user: ${who}`);
  } catch {
    console.error(`No valid token for ${REGISTRY} (missing or rejected). Run: npm login --registry=${REGISTRY}`);
    console.error('Behind a proxy? Pass --proxy host:port (or set HTTPS_PROXY) and retry.');
    process.exit(1);
  }
} else {
  console.log(`dry run — registry credentials not checked`);
}

for (const rel of VERSION_FILES) {
  const file = path.join(root, rel);
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  pkg.version = version;
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`bumped ${pkg.name} -> ${version}`);
}

run('pnpm install');
run('pnpm build');
run('pnpm build:web');

const publishFlags = `--access public --registry=${REGISTRY} --no-git-checks${dryRun ? ' --dry-run' : ''}`;

// COMPONENTS is bumped above but never published on its own: it is bundled
// inside the umbrella tarball below (see pack-weave.mjs).
const tgz = await packWeaveTgz({ skipBuild: true });
runWithProxy(`pnpm publish ${path.relative(root, tgz)} ${publishFlags}`);

console.log(dryRun ? '\nDry run complete — nothing published.' : `\nPublished ${version}. Tag with: git tag v${version}`);
