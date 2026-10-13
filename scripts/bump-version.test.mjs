// bump-version.test.mjs — 升版工具的纯函数与向导喂入验证（node --test）。
// 写盘/提交路径不改本仓：以临时目录复制脚本、伪造七处 package.json 后整链跑。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import('./bump-version.mjs');

test('compareVersions：semver 全序（含 prerelease 数值比较）', () => {
  assert.equal(mod.compareVersions('0.1.1', '0.1.0'), 1);
  assert.equal(mod.compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(mod.compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(mod.compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(mod.compareVersions('0.2.0-rc.1', '0.2.0'), -1, 'prerelease < 正式');
  assert.equal(mod.compareVersions('0.2.0-rc.10', '0.2.0-rc.9'), 1, '序号按数值不按字典序');
  assert.equal(mod.compareVersions('0.2.0-rc.1', '0.2.0-rc.1.1'), -1);
  assert.ok(Number.isNaN(mod.compareVersions('x', '0.1.0')));
});

test('bumpVersion：上级进位、下级归零；带 pre 以基线自增', () => {
  assert.equal(mod.bumpVersion('0.1.9', 'patch'), '0.1.10');
  assert.equal(mod.bumpVersion('0.1.9', 'minor'), '0.2.0');
  assert.equal(mod.bumpVersion('0.1.9', 'major'), '1.0.0');
  assert.equal(mod.bumpVersion('0.2.0-rc.1', 'patch'), '0.2.1', 'pre 基线自增');
  assert.equal(mod.bumpVersion('abc', 'patch'), null);
});

test('checkForward：后退/原地重复/非法都拦', () => {
  assert.equal(mod.checkForward('0.2.0', '0.1.0'), null);
  assert.match(mod.checkForward('0.1.0', '0.1.0'), /不允许后退\/原地重复/);
  assert.match(mod.checkForward('0.0.9', '0.1.0'), /不允许后退/);
  assert.match(mod.checkForward('v0.2', '0.1.0'), /semver/);
});

test('versionOptions：纯版本出 patch/minor/major + 显式 + 保持；pre 线多出同线推进与转正式', () => {
  const plain = mod.versionOptions('0.1.0');
  assert.deepEqual(plain.map((o) => o.kind), ['value', 'value', 'value', 'explicit', 'keep']);
  assert.equal(plain[0].version, '0.1.1');
  assert.equal(plain[1].version, '0.2.0');
  assert.equal(plain[2].version, '1.0.0');
  const pre = mod.versionOptions('0.2.0-rc.1');
  assert.equal(pre[0].version, '0.2.0-rc.2', '同线推进序号 +1');
  assert.equal(pre[1].version, '0.2.0', '转正式去 pre 段');
  assert.equal(pre[2].version, '0.2.1', '后续 patch 按基线');
});

/** 喂入式 ask：按序吐答案，同时记录提问（无答案时交空串 = 取消语义） */
function scriptedAsk(answers) {
  const asked = [];
  let i = 0;
  const ask = (q) => {
    asked.push(q);
    return Promise.resolve(i < answers.length ? answers[i++] : '');
  };
  return [ask, asked];
}

test('promptVersion：patch 确认 / 显式输入 / 后退强制 / 保持 / 取消', async () => {
  const say = () => {};
  let [ask] = scriptedAsk(['1', 'y']);
  assert.equal(await mod.promptVersion('0.1.0', ask, say), '0.1.1');
  [ask] = scriptedAsk(['4', '0.3.0', 'y']);
  assert.equal(await mod.promptVersion('0.1.0', ask, say), '0.3.0', '显式输入合法直取');
  [ask] = scriptedAsk(['4', '0.3.0-rc.2', 'y']);
  assert.equal(await mod.promptVersion('0.1.0', ask, say), '0.3.0-rc.2', '显式带 pre 段');
  // 后退 → 就地强制问；拒绝 → 回菜单重选
  [ask] = scriptedAsk(['4', '0.0.1', 'n', '1', 'y']);
  assert.equal(await mod.promptVersion('0.1.0', ask, say), '0.1.1');
  // 后退 → 强制确认 → 返回带 force 标记
  [ask] = scriptedAsk(['4', '0.0.1', 'y', 'y']);
  assert.deepEqual(await mod.promptVersion('0.1.0', ask, say), { version: '0.0.1', force: true });
  // 非法 semver → 无强制门，直接回菜单
  [ask] = scriptedAsk(['4', 'v0.2', '1', 'y']);
  assert.equal(await mod.promptVersion('0.1.0', ask, say), '0.1.1');
  [ask] = scriptedAsk(['5', 'y']);
  assert.deepEqual(await mod.promptVersion('0.1.0', ask, say), { keep: true });
  [ask] = scriptedAsk(['']);
  assert.equal(await mod.promptVersion('0.1.0', ask, say), null, '回车取消');
  [ask] = scriptedAsk(['9']);
  assert.equal(await mod.promptVersion('0.1.0', ask, say), null, '越界编号取消');
});

// ── 整链（临时目录 + 真 git）：写齐七处、守卫、提交、幂等 ──

function makeSandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'weave-bump-'));
  const packages = ['weave-core', 'weave-harness', 'weave-templates', 'weave-server', 'weave-cli', 'weave'];
  mkdirSync(path.join(dir, 'scripts'));
  cpSync(path.join(here, 'bump-version.mjs'), path.join(dir, 'scripts', 'bump-version.mjs'));
  const targets = ['package.json', ...packages.map((p) => `packages/${p}/package.json`)];
  for (const rel of targets) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), JSON.stringify({ name: path.basename(path.dirname(rel) || 'root'), version: '0.1.0' }, null, 2) + '\n');
  }
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-m', 'init');
  return { dir, targets, git, read: (rel) => JSON.parse(readFileSync(path.join(dir, rel), 'utf8')).version };
}

test('--version：写齐七处 + 自动提交；重复执行幂等不提交', () => {
  const sb = makeSandbox();
  try {
    execFileSync('node', ['scripts/bump-version.mjs', '--version', '0.2.0'], { cwd: sb.dir, encoding: 'utf8' });
    for (const rel of sb.targets) assert.equal(sb.read(rel), '0.2.0', `${rel} 写齐`);
    assert.equal(sb.git('log', '-1', '--format=%s').trim(), 'chore(release): 全仓版本升至 v0.2.0');
    assert.equal(sb.git('status', '--porcelain').trim(), '', '提交后工作区干净');
    const commitsBefore = sb.git('rev-list', '--count', 'HEAD').trim();
    let blocked = false;
    try {
      execFileSync('node', ['scripts/bump-version.mjs', '--version', '0.2.0'], { cwd: sb.dir, encoding: 'utf8' });
    } catch {
      blocked = true;
    }
    assert.ok(blocked, '同版重跑被原地重复守卫拦下');
    const forcedAgain = execFileSync('node', ['scripts/bump-version.mjs', '--version', '0.2.0', '--force'], { cwd: sb.dir, encoding: 'utf8' });
    assert.match(forcedAgain, /无改动/);
    assert.equal(sb.git('rev-list', '--count', 'HEAD').trim(), commitsBefore, '守卫拦与 force 幂等都不再多一笔提交');
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('--version 后退被拦；--force 豁免；--no-commit 只写不提交', () => {
  const sb = makeSandbox();
  try {
    let failed = false;
    try {
      execFileSync('node', ['scripts/bump-version.mjs', '--version', '0.0.9'], { cwd: sb.dir, encoding: 'utf8' });
    } catch {
      failed = true;
    }
    assert.ok(failed, '后退被守卫拦下');
    assert.equal(sb.read('package.json'), '0.1.0', '拦截路径不写文件');
    const forced = execFileSync('node', ['scripts/bump-version.mjs', '--version', '0.0.9', '--force'], { cwd: sb.dir, encoding: 'utf8' });
    assert.match(forced, /强制放行/);
    for (const rel of sb.targets) assert.equal(sb.read(rel), '0.0.9', `${rel} 强制写齐`);
    assert.match(sb.git('log', '-1', '--format=%s'), /v0\.0\.9/);
    const out = execFileSync('node', ['scripts/bump-version.mjs', '--version', '0.3.0', '--no-commit'], { cwd: sb.dir, encoding: 'utf8' });
    assert.match(out, /0\.3\.0/);
    assert.match(sb.git('status', '--porcelain'), /package\.json/, '--no-commit 留下未提交改动');
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('--check：一致通过、漂移 exit 1', () => {
  const sb = makeSandbox();
  try {
    execFileSync('node', ['scripts/bump-version.mjs', '--check'], { cwd: sb.dir, encoding: 'utf8' });
    const raw = JSON.parse(readFileSync(path.join(sb.dir, 'packages/weave-cli/package.json'), 'utf8'));
    raw.version = '9.9.9';
    writeFileSync(path.join(sb.dir, 'packages/weave-cli/package.json'), JSON.stringify(raw, null, 2) + '\n');
    let failed = false;
    try {
      execFileSync('node', ['scripts/bump-version.mjs', '--check'], { cwd: sb.dir, encoding: 'utf8' });
    } catch {
      failed = true;
    }
    assert.ok(failed, '漂移 exit 1');
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});
