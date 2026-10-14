import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSystemPrompt, collectSkillFiles, findDocsDir } from '../ai-context.js';

/** AI 助手系统上下文装配：三源 / 降级 / 预算截断。 */

const tempDirs: string[] = [];
function temp(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `weave-ai-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(dataDir: string, name: string, body: string): void {
  const dir = path.join(dataDir, 'market', 'weave', 'plugins', 'core-skills', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ai-context', () => {
  it('三源装配：docs（架构+特性）与内置技能都注入', () => {
    const root = temp('full');
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'FEATURES.md'), '# 功能\n- 能力槽装配', 'utf8');
    writeFileSync(path.join(root, 'docs', 'ARCHITECTURE.md'), '# 架构\n- 运行时拓扑四图', 'utf8');
    const dataDir = path.join(root, 'data');
    writeSkill(dataDir, 'testing', '---\nname: testing\n---\n# 测试技能正文');

    const ctx = buildSystemPrompt({ dataDir, cwd: root });

    expect(ctx.docsFound).toBe(true);
    expect(ctx.labels).toContain('docs/FEATURES.md');
    expect(ctx.labels).toContain('docs/ARCHITECTURE.md');
    expect(ctx.labels.some((label) => label.endsWith('SKILL.md'))).toBe(true);
    expect(ctx.prompt).toContain('能力槽装配');
    expect(ctx.prompt).toContain('运行时拓扑四图');
    expect(ctx.prompt).toContain('测试技能正文');
    // 回复范围限制（越界礼貌拒答）是固定前言的一部分
    expect(ctx.prompt).toContain('只负责 weave 本身');
    expect(ctx.prompt).toContain('越界');
  });

  it('docs 缺失（安装态 cwd 不落仓库）→ 降级只注入技能，不报错', () => {
    const root = temp('nodocs');
    const dataDir = path.join(root, 'data');
    writeSkill(dataDir, 'code-review', '# 代码评审技能');

    const ctx = buildSystemPrompt({ dataDir, cwd: root });

    expect(ctx.docsFound).toBe(false);
    expect(ctx.prompt).toContain('代码评审技能');
    expect(ctx.labels.some((label) => label.startsWith('docs/'))).toBe(false);
  });

  it('预算截断：超限文本按预算裁剪并标注', () => {
    const root = temp('budget');
    const dataDir = path.join(root, 'data');
    writeSkill(dataDir, 'huge', 'x'.repeat(70_000));

    const ctx = buildSystemPrompt({ dataDir, cwd: root });

    expect(ctx.prompt.length).toBeLessThanOrEqual(60_200);
    expect(ctx.labels.some((label) => label.includes('(截断)'))).toBe(true);
  });

  it('findDocsDir 向上查找仓库根；无 docs 返回 null', () => {
    const root = temp('find');
    const nested = path.join(root, 'packages', 'x', 'y');
    mkdirSync(nested, { recursive: true });
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'FEATURES.md'), '# f', 'utf8');

    expect(findDocsDir(nested)).toBe(path.join(root, 'docs'));
    expect(findDocsDir(temp('empty'))).toBeNull();
  });

  it('collectSkillFiles：递归收集且排序稳定', () => {
    const dataDir = temp('skills');
    writeSkill(dataDir, 'b', '# b');
    writeSkill(dataDir, 'a', '# a');
    const files = collectSkillFiles(path.join(dataDir, 'market', 'weave'));
    expect(files).toHaveLength(2);
    expect(files).toEqual([...files].sort());
  });
});
