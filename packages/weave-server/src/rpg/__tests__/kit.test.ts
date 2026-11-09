import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cleanupKit,
  excludeBlockEntries,
  installKit,
  kitExcludeMarker,
  kitSkillName,
  kitSkillsRoot,
  readKitRegistry,
} from '../kit.js';

/**
 * 出征 kit（G2 段2）验收③：安装对用户既有 `.claude/skills/` 与 tracked 文件
 * 零污染——exclude marker 块状增删 + 引用计数；tracked 冲突硬前置拒绝。
 */
describe('kit 安装 / exclude / 引用计数', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'weave-kit-'));
    const git = (args: string[]): void => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'weave-test']);
    writeFileSync(path.join(root, 'a.txt'), 'base\n');
    mkdirSync(path.join(root, '.claude', 'skills', 'user-own'), { recursive: true });
    writeFileSync(path.join(root, '.claude', 'skills', 'user-own', 'SKILL.md'), 'user skill\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'init']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const skillSource = (name: string, body: string): string => {
    const dir = path.join(root, 'kit-src', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), body);
    return dir;
  };

  it('① 安装：skill 落 `.claude/skills/<role>-<skill>/`，exclude 带 marker 块', async () => {
    const src = skillSource('sword', '---\nname: sword\n---\n# 剑法\n');
    const res = await installKit({ worktreePath: root, role: 'frontend-dev', instanceId: 'exp-1', skills: { sword: src } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const target = path.join(kitSkillsRoot(root), kitSkillName('frontend-dev', 'sword'));
    expect(existsSync(target)).toBe(true);
    const marker = kitExcludeMarker('frontend-dev', 'frontend-dev');
    expect(excludeBlockEntries(root, marker)).toEqual(['.claude/skills/frontend-dev-sword']);
    // 用户的既有 skill 不被碰
    expect(existsSync(path.join(root, '.claude', 'skills', 'user-own', 'SKILL.md'))).toBe(true);
    // git 认为新 kit 目录是 untracked 且被 exclude 静默（status 干净）
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    expect(status).not.toContain('frontend-dev-sword');
  });

  it('② 幂等：同 (marker, skill) 二次安装不重复复制、引用只 +1', async () => {
    const src = skillSource('sword', 'x');
    await installKit({ worktreePath: root, role: 'r', instanceId: 'e1', skills: { sword: src } });
    const before = readFileSync(path.join(kitSkillsRoot(root), 'r-sword', 'SKILL.md'), 'utf8');
    await installKit({ worktreePath: root, role: 'r', instanceId: 'e1', skills: { sword: src } });
    expect(readKitRegistry(root)[kitExcludeMarker('r', 'r')]!.refs).toEqual(['e1']);
    expect(readFileSync(path.join(kitSkillsRoot(root), 'r-sword', 'SKILL.md'), 'utf8')).toBe(before);
  });

  it('③ 引用计数：双实例并行出征，归零才摘块删目录', async () => {
    const src = skillSource('sword', 'x');
    await installKit({ worktreePath: root, role: 'r', instanceId: 'e1', skills: { sword: src } });
    await installKit({ worktreePath: root, role: 'r', instanceId: 'e2', skills: { sword: src } });
    const first = cleanupKit(root, 'r', 'e1');
    expect(first.removed).toBe(false);
    expect(first.refsLeft).toBe(1);
    expect(excludeBlockEntries(root, kitExcludeMarker('r', 'r'))).toContain('.claude/skills/r-sword');
    expect(existsSync(path.join(kitSkillsRoot(root), 'r-sword'))).toBe(true);
    const second = cleanupKit(root, 'r', 'e2');
    expect(second.removed).toBe(true);
    expect(existsSync(path.join(kitSkillsRoot(root), 'r-sword'))).toBe(false);
    expect(excludeBlockEntries(root, kitExcludeMarker('r', 'r'))).toEqual([]);
  });

  it('④ tracked 查重：kit 目标路径已被 tracked 时安装拒绝（零污染硬前置）', async () => {
    // 把同名路径先 tracked 进仓库
    const tracked = path.join(root, '.claude', 'skills', 'r-sword');
    mkdirSync(tracked, { recursive: true });
    writeFileSync(path.join(tracked, 'SKILL.md'), 'tracked\n');
    execFileSync('git', ['add', '.claude'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-qm', 'track skills'], { cwd: root });
    const res = await installKit({
      worktreePath: root,
      role: 'r',
      instanceId: 'e1',
      skills: { sword: skillSource('sword', 'x') },
      trackedCheck: (_wt, relPaths) => relPaths,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.conflicts).toContain('.claude/skills/r-sword');
    // 拒绝后 tracked 文件原样
    expect(readFileSync(path.join(tracked, 'SKILL.md'), 'utf8')).toBe('tracked\n');
  });

  it('⑤ 清场幂等：marker 不在登记 = no-op', () => {
    expect(cleanupKit(root, 'ghost', 'e9')).toEqual({ removed: false, refsLeft: 0 });
  });
});
