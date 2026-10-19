#!/usr/bin/env node
// 提交/推送前的隐私体检（git hook 与手工都用这一个入口）。
//
// 只看**新增行**：高置信度凭据一律拦（exit 1），低置信度（邮箱 / 家目录路径 /
// 非回环 IP）只提示不拦——仓库里本来就有假邮箱、判据噪声会把人逼去 --no-verify。
// 打印恒为脱敏形状（类别 + 前后各几个字符 + 长度），**绝不回显原文**。
//
//   node scripts/privacy-scan.mjs --staged          # pre-commit
//   node scripts/privacy-scan.mjs --push            # pre-push（refs 走 stdin）
//   node scripts/privacy-scan.mjs --range a..b      # 手工：扫一段提交
import { execFileSync } from 'node:child_process';

/** 超过这个体量的 diff 直接跳过：hook 不许把提交/推送拖成几十秒。 */
const MAX_DIFF_BYTES = 20 * 1024 * 1024;

const BLOCK = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  [
    'token-prefix',
    /\b(?:ghp_[A-Za-z0-9]{30,}|gh[osu]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_-]{20,})\b/g,
  ],
  [
    'secret-assignment',
    /\b(?:api[-_]?key|secret|password|passwd|access[-_]?key|private[-_]?key|auth[-_]?token|local[-_]?token)\b\s*[:=]\s*['"`]([^'"`\n]{16,})['"`]/gi,
  ],
  ['bearer', /\bBearer\s+([A-Za-z0-9._~+/-]{24,})/g],
];

const WARN = [
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g],
  ['home-path', /(?:[A-Za-z]:\\{1,2}Users\\{1,2}|(?:\/home|\/Users)\/)[A-Za-z0-9._-]+/gi],
  ['ipv4', /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g],
];

/** 占位符不是凭据：模板串、示例值、全同字符一律放过。 */
const PLACEHOLDER = /(?:<[^>]*>|\.\.\.|\*\*\*|x{4,}|X{4,}|example|placeholder|redacted|dummy|changeme|your[-_]?|test)/i;

const mask = (s) => (s.length <= 6 ? '***' : `${s.slice(0, 3)}…${s.slice(-2)}(${s.length})`);

function git(args, input) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    input,
    maxBuffer: MAX_DIFF_BYTES * 2,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** pre-push 的 stdin：<local ref> <local sha> <remote ref> <remote sha>。 */
function pushRanges(stdin) {
  const ranges = [];
  for (const line of stdin.split('\n')) {
    const [localRef, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || /^0+$/.test(localSha)) continue; // 删分支，没东西可扫
    ranges.push(`${/^0+$/.test(remoteSha ?? '') ? EMPTY_TREE : remoteSha}..${localSha}`);
    void localRef;
  }
  return ranges;
}

function diffsFor(mode, range, pushStdin) {
  const ranges =
    mode === 'push' ? pushRanges(pushStdin) : [mode === 'staged' ? '--cached' : range];
  return ranges.map((r) => (r === '--cached' ? git(['diff', '--cached', '-U0']) : git(['diff', '-U0', r])));
}

const findings = { block: [], warn: [] };

function scan(diff) {
  let file = '?';
  let lineNo = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.slice(4).replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /\+(\d+)/.exec(line);
      lineNo = m ? Number(m[1]) : 0;
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const added = line.slice(1);
    const at = lineNo++;
    if (/privacy-scan:\s*ignore/.test(added)) continue;
    for (const [kind, rule] of BLOCK) {
      rule.lastIndex = 0;
      let m;
      while ((m = rule.exec(added))) {
        const value = m[1] ?? m[0];
        if (PLACEHOLDER.test(value)) continue;
        findings.block.push({ kind, file, at, masked: mask(value) });
      }
    }
    for (const [kind, rule] of WARN) {
      rule.lastIndex = 0;
      let m;
      while ((m = rule.exec(added))) {
        const value = m[0];
        if (kind === 'ipv4' && /^(?:127\.|0\.0\.0\.0)/.test(value)) continue;
        if (PLACEHOLDER.test(value)) continue;
        findings.warn.push({ kind, file, at, masked: mask(value) });
      }
    }
  }
}

const args = process.argv.slice(2);
const mode = args.includes('--push') ? 'push' : args.includes('--staged') ? 'staged' : 'range';
const range = args.find((a) => a.includes('..'));
if (mode === 'range' && !range) {
  console.log('用法：node scripts/privacy-scan.mjs [--staged | --push | <base>..<head>]');
  process.exit(0);
}
const pushStdin = mode === 'push' ? await new Promise((r) => {
  let buf = '';
  if (process.stdin.isTTY) return r('');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (buf += c));
  process.stdin.on('end', () => r(buf));
}) : '';

let diffs = [];
try {
  diffs = diffsFor(mode, range, pushStdin);
} catch (e) {
  console.warn(`privacy-scan: 取 diff 失败，跳过（不拦）：${e instanceof Error ? e.message : e}`);
  process.exit(0);
}
const total = diffs.reduce((n, d) => n + d.length, 0);
if (total > MAX_DIFF_BYTES) {
  console.warn(`privacy-scan: 改动 ${Math.round(total / 1024 / 1024)}MB 超过上限，跳过（不拦）`);
  process.exit(0);
}
for (const d of diffs) scan(d);

for (const group of ['warn', 'block']) {
  const label = group === 'block' ? '拦截' : '提示';
  for (const f of findings[group]) {
    console.log(`[${label}] ${f.file}:${f.at}  ${f.kind}  ${f.masked}`);
  }
}
if (findings.block.length > 0) {
  console.log(
    `\nprivacy-scan: ${findings.block.length} 处疑似凭据。确认是假值/测试夹具，就在该行加 ` +
      '`privacy-scan: ignore` 注释后重试（提示类不拦）。',
  );
  process.exit(1);
}
if (findings.warn.length > 0) {
  console.log(`\nprivacy-scan: ${findings.warn.length} 处提示类（不拦）——推之前想一下要不要去掉。`);
}
process.exit(0);
