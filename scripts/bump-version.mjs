#!/usr/bin/env node
/**
 * 全仓锁步升版工具。七个版本点一次写齐（根 package.json + 六个发布包），与
 * scripts/release.mjs 的 PACKAGES 同一份清单。
 *
 * 用法:
 *   pnpm version:bump                      # 交互向导（patch/minor/major/显式/保持）
 *   node scripts/bump-version.mjs --version 0.2.0    # 显式设版（-v 短参兼容）
 *   node scripts/bump-version.mjs --version 0.2.0 --force   # 豁免「不允许后退/原地重复」
 *   node scripts/bump-version.mjs --check   # 一致性校验（漂移 exit 1，可挂前置）
 *   node scripts/bump-version.mjs --no-commit  # 只写文件不提交
 *
 * 脚本化传参须加 --（pnpm 会拦截裸 --version）：pnpm version:bump -- --version 0.2.0。
 * 无参数 + 非终端 = 用法帮助 + 校验（CI 不挂起等输入）。
 *
 * 自动提交只提交版本文件本身（git commit -- <paths>），其他暂存内容不牵连；
 * 工作区无该七文件外的关联改动，共享工作区安全。零第三方依赖。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['weave-core', 'weave-harness', 'weave-templates', 'weave-server', 'weave-cli', 'weave'];
const TARGETS = ['package.json', ...PACKAGES.map((p) => `packages/${p}/package.json`)];

function die(message) {
  console.error(`[bump-version] 错误: ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`[bump-version] ${message}`);
}

// ── semver 小实现（含 prerelease 比较；版本串一律不带 v 前缀） ──

export function parseVersion(version) {
  const m = String(version || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || null };
}

/** @returns {number} -1/0/1；任一不可解析返回 NaN */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return NaN;
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // 无 prerelease 段 > 有（0.2.0 > 0.2.0-rc.1）
  if (!pb.pre) return -1;
  const as = pa.pre.split('.');
  const bs = pb.pre.split('.');
  for (let i = 0; i < Math.min(as.length, bs.length); i += 1) {
    if (as[i] === bs[i]) continue;
    const an = /^\d+$/.test(as[i]);
    const bn = /^\d+$/.test(bs[i]);
    if (an && bn) return Number(as[i]) < Number(bs[i]) ? -1 : 1;
    if (an) return -1;
    if (bn) return 1;
    return as[i] < bs[i] ? -1 : 1;
  }
  return as.length === bs.length ? 0 : as.length < bs.length ? -1 : 1;
}

/** 自增（major|minor|patch）；基线含 prerelease 时以其 x.y.z 段自增 */
export function bumpVersion(version, part) {
  const p = parseVersion(version);
  if (!p) return null;
  const b = { ...p, pre: null };
  if (part === 'major') return `${b.major + 1}.0.0`;
  if (part === 'minor') return `${b.major}.${b.minor + 1}.0`;
  if (part === 'patch') return `${b.major}.${b.minor}.${b.patch + 1}`;
  return null;
}

/** 守卫：合法前进返回 null，否则错误消息（semver 非法 / 后退 / 原地重复） */
export function checkForward(candidate, current) {
  const cmp = compareVersions(candidate, current);
  if (Number.isNaN(cmp)) return `版本号 ${candidate} 不符合 semver（形如 0.1.9 / 0.2.0-rc.1）`;
  if (cmp <= 0) return `版本号不允许后退/原地重复：${candidate} 不大于当前 ${current}`;
  return null;
}

// ── 菜单（渲染与解析共用同一份，编号映射不两处漂移） ──

/**
 * 构造第一问「版本号」的选项表。预发布线（x.y.z-pre）的合法前进两类先列
 * （性质已定不再问），随后 patch/minor/major 按基线自增，最后显式输入与保持。
 */
export function versionOptions(current) {
  const p = parseVersion(current);
  if (!p) return [];
  const base = `${p.major}.${p.minor}.${p.patch}`;
  const opts = [];
  if (p.pre) {
    const m = p.pre.match(/^(.*?)(?:\.(\d+))?$/);
    const nextOrd = m?.[2] ? Number(m[2]) + 1 : 1;
    opts.push({ label: `同线推进  ${current} → ${base}-${m?.[1] || p.pre}.${nextOrd}   同性质序号 +1`, kind: 'value', version: `${base}-${m?.[1] || p.pre}.${nextOrd}` });
    opts.push({ label: `转正式版  ${current} → ${base}   去掉 prerelease 段`, kind: 'value', version: base });
  }
  const bumps = [
    ['patch', '仅缺陷修复'],
    ['minor', '功能新增或变化'],
    ['major', '里程碑/不兼容变化'],
  ];
  for (const [part, why] of bumps) {
    const next = bumpVersion(current, part);
    opts.push({ label: `${part}  ${current} → ${next}   ${why}`, kind: 'value', version: next });
  }
  opts.push({ label: '显式输入 x.y.z（可带 -pre 段，如 0.2.0-rc.1）', kind: 'explicit' });
  opts.push({ label: `保持不变  ${current}   不写版本文件`, kind: 'keep' });
  return opts;
}

// ── 文件读写 ──

function readTargets() {
  return TARGETS.map((rel) => {
    const file = path.join(root, rel);
    let current;
    try {
      current = JSON.parse(readFileSync(file, 'utf8')).version;
    } catch (err) {
      die(`读取 ${rel} 失败: ${err.message}`);
    }
    if (typeof current !== 'string') die(`${rel} 解析不到 version 字段`);
    return { rel, file, current };
  });
}

/** 写齐七处，返回实际改动的文件路径（供提交） */
function applyVersion(entries, version) {
  const changed = [];
  for (const entry of entries) {
    if (entry.current === version) continue;
    const pkg = JSON.parse(readFileSync(entry.file, 'utf8'));
    pkg.version = version;
    writeFileSync(entry.file, JSON.stringify(pkg, null, 2) + '\n');
    changed.push(entry.file);
    log(`${entry.rel}: ${entry.current} → ${version}`);
  }
  if (changed.length === 0) log(`七处已同为 ${version}，无改动`);
  else log(`已写齐七处: ${version}`);
  return changed;
}

function isUnder(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 只提交版本文件（pathspec commit，其他暂存内容不牵连）；无变化跳过 */
function commitVersionFiles(version, changed) {
  if (changed.length === 0) {
    log('版本文件无变化，无需提交');
    return;
  }
  const message = `chore(release): 全仓版本升至 v${version}`;
  try {
    execFileSync('git', ['commit', '-m', message, '--', ...changed.map((p) => path.relative(root, p))], { cwd: root, stdio: 'pipe', encoding: 'utf8' });
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    log(`已提交 ${sha}（${message}）`);
  } catch (err) {
    log(`未提交 —— git 不可用或非仓库（${err.message.split('\n')[0]}）；文件已写齐`);
  }
}

function doCheck(entries) {
  for (const entry of entries) log(`${entry.rel}: ${entry.current}`);
  const unique = [...new Set(entries.map((e) => e.current))];
  if (unique.length > 1) {
    console.error('[bump-version] 错误: 版本漂移，七处不一致（见上）——先用 --version 对齐');
    process.exit(1);
  }
  log(`一致: ${unique[0]}（根 + 六包锁步）`);
}

// ── 交互（行缓冲队列：管道/EOF 不挂死；多问共用一个 readline） ──

function createAsk() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const waiting = [];
  const buffered = [];
  rl.on('line', (line) => {
    const resolve = waiting.shift();
    if (resolve) resolve(line);
    else buffered.push(line);
  });
  rl.on('close', () => {
    while (waiting.length) waiting.shift()('');
  });
  const ask = (question) => {
    process.stdout.write(question);
    if (buffered.length) return Promise.resolve(buffered.shift());
    return new Promise((resolve) => waiting.push(resolve));
  };
  ask.close = () => rl.close();
  return ask;
}

/**
 * 交互式版本选择。返回目标版本串；「保持不变」返回 { keep: true }；
 * 交互中确认过「强制设置」返回 { version, force: true }；取消返回 null。
 * 显式输入不合法或后退则循环重问；后退/原地重复就地给一次强制确认
 * （= 脚本化 --force），semver 格式非法不设此门。
 * 导出供测试喂入式 ask 验证（同 createAsk 的行缓冲设计）。
 */
export async function promptVersion(current, ask, say, options = {}) {
  const guard = (candidate, forced) => {
    const bad = checkForward(candidate, current);
    if (!bad) return null;
    if ((options.force || forced) && !Number.isNaN(compareVersions(candidate, current))) {
      say(`注意: 强制放行（${bad}）`);
      return null;
    }
    return bad;
  };
  for (;;) {
    let forced = false;
    const opts = versionOptions(current);
    say(`当前版本 ${current}（七处锁步）`);
    say('选择版本号:');
    opts.forEach((opt, i) => say(`  ${i + 1}. ${opt.label}`));
    say('  回车或其他 = 取消');
    say('规范: 上级版本号变动，下一级归零；版本号不允许后退/原地重复。');
    const choice = (await ask('> ')).trim();
    const opt = /^\d+$/.test(choice) ? opts[Number(choice) - 1] : null;
    if (!opt) return null;

    if (opt.kind === 'keep') {
      const ok = (await ask(`确认保持 ${current} 不变（不写版本文件）?（y 确认，其他重来）> `)).trim().toLowerCase();
      if (ok === 'y' || ok === 'yes') return { keep: true };
      continue;
    }
    let candidate;
    if (opt.kind === 'explicit') {
      const input = (await ask('输入目标版本（x.y.z，回车取消）: ')).trim();
      if (!input) return null;
      const bad = guard(input, forced);
      if (bad) {
        say(bad);
        if (Number.isNaN(compareVersions(input, current))) continue;
        const ok = (await ask(`是否强制设置 ${input}？（y 强制，其他重来）> `)).trim().toLowerCase();
        if (ok !== 'y' && ok !== 'yes') continue;
        forced = true;
      }
      candidate = input.replace(/^v/, '');
    } else {
      const bad = guard(opt.version);
      if (bad) {
        say(bad);
        continue;
      }
      candidate = opt.version;
    }
    const confirm = (await ask(`确认版本 ${candidate}？（y 确认，其他重来）> `)).trim().toLowerCase();
    if (confirm === 'y' || confirm === 'yes') {
      return forced ? { version: candidate, force: true } : candidate;
    }
  }
}

// ── 入口 ──

function parseArgs(argv) {
  const args = { commit: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue; // pnpm 参数分隔符，吞掉
    if (arg === '--check') args.check = true;
    else if (arg === '--no-commit') args.commit = false;
    else if (arg === '--force') args.force = true;
    else if (arg === '-v') {
      args.version = argv[i + 1];
      i += 1;
    } else if (arg === '--version') {
      args.version = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--version=')) {
      args.version = arg.slice(arg.indexOf('=') + 1);
    } else {
      die(`未知参数: ${arg}`);
    }
  }
  return args;
}

function printUsage() {
  console.log('用法: node scripts/bump-version.mjs [--version x.y.z | --check] [--no-commit] [--force]');
  console.log('      七处版本点一次写齐（根 package.json + 六个发布包）；无参数在终端下进入交互向导。');
  console.log('      pnpm: version:bump（交互）/ version:check（校验）；脚本化传参须加 --，');
  console.log('      如 pnpm version:bump -- --version 0.2.0（pnpm 会拦截裸 --version）。');
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const entries = readTargets();

  if (args.check) {
    doCheck(entries);
    return;
  }
  if (args.version) {
    const version = String(args.version).trim().replace(/^v/, '');
    if (!parseVersion(version)) die(`版本号 ${args.version} 不符合 semver（如 0.2.0 / 0.2.0-rc.1）`);
    for (const entry of entries) log(`${entry.rel}: ${entry.current}`);
    const bad = checkForward(version, entries[0].current);
    if (bad && !args.force) die(`${bad} —— 确需覆盖请加 --force`);
    if (bad) log(`注意: 强制放行（${bad}）`);
    const changed = applyVersion(entries, version);
    if (args.commit) commitVersionFiles(version, changed);
    return;
  }

  // 无参数：终端 = 交互向导；非终端（管道/CI）= 用法帮助 + 校验（不挂起等输入）
  if (!process.stdin.isTTY) {
    printUsage();
    doCheck(entries);
    return;
  }
  const base = entries[0].current;
  const unique = [...new Set(entries.map((e) => e.current))];
  if (unique.length > 1) {
    console.log(`[bump-version] 注意: 七处版本漂移，自增/对齐以 ${TARGETS[0]} 的 ${base} 为基准`);
  }
  const ask = createAsk();
  let picked;
  try {
    picked = await promptVersion(base, ask, (m) => console.log(m), { force: args.force === true });
  } finally {
    ask.close();
  }
  if (!picked) {
    log('已取消，未做任何修改');
    return;
  }
  if (typeof picked === 'object' && picked.keep) {
    log(`保持当前版本 ${base} 不变，未做任何修改`);
    return;
  }
  const version = typeof picked === 'object' ? picked.version : picked;
  const changed = applyVersion(entries, version);
  if (args.commit) commitVersionFiles(version, changed);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => die(e && e.stack ? e.stack : String(e)));
}
