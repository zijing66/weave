import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CLAUDE_MEMORY } from '../../claude/memory.js';
import { CODEX_MEMORY } from '../../codex/memory.js';

/**
 * 项目记忆文件认领区块（claude = CLAUDE.local.md / codex = AGENTS.md 同一机械）：
 * 新建带区块、用户文件 append-only 追加、续写进区块、滑动窗口裁旧、多行正文
 * 折叠单行、写盘失败如实报错。
 */

const project = async (): Promise<string> => mkdtemp(path.join(tmpdir(), 'memsink-'));

describe('记忆文件认领区块', () => {
  it('文件不存在 → 连认领区块一起新建；文件身份随行返回', async () => {
    const dir = await project();
    const result = await CLAUDE_MEMORY.appendVerdict({ projectPath: dir, text: '首条判决' });
    expect(result).toMatchObject({ ok: true, file: path.join(dir, 'CLAUDE.local.md') });
    const text = await readFile(path.join(dir, 'CLAUDE.local.md'), 'utf-8');
    expect(text).toContain('<!-- weave:verdicts:start -->');
    expect(text).toContain('<!-- weave:verdicts:end -->');
    expect(text).toContain('首条判决');
    expect(text).toMatch(/- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] 首条判决/);
  });

  it('用户文件（无区块）→ append-only 追加：用户内容字节不动', async () => {
    const dir = await project();
    const file = path.join(dir, 'AGENTS.md');
    const mine = '# 项目说明\n\n用户手写的内容。\n';
    await writeFile(file, mine, 'utf-8');
    const result = await CODEX_MEMORY.appendVerdict({ projectPath: dir, text: '第二条' });
    expect(result.ok).toBe(true);
    const text = await readFile(file, 'utf-8');
    expect(text.startsWith(mine.replace(/\n$/, '\n'))).toBe(true);
    expect(text).toContain('用户手写的内容。');
    expect(text).toContain('第二条');
    // 用户内容在前、区块在后
    expect(text.indexOf('用户手写的内容。')).toBeLessThan(text.indexOf('weave:verdicts:start'));
  });

  it('已有区块 → 区块内追加；滑动窗口裁旧（窗口 20）', async () => {
    const dir = await project();
    for (let i = 1; i <= 25; i++) {
      const r = await CLAUDE_MEMORY.appendVerdict({ projectPath: dir, text: `判决 ${i} 号` });
      expect(r.ok).toBe(true);
    }
    const text = await readFile(path.join(dir, 'CLAUDE.local.md'), 'utf-8');
    const entries = text.match(/^- \[[^\]]+\] 判决 \d+ 号$/gm) ?? [];
    expect(entries).toHaveLength(20);
    expect(entries[0]).toContain('判决 6 号'); // 留最近 20 条：6..25
    expect(entries.at(-1)).toContain('判决 25 号');
  });

  it('区块外用户内容在续写后字节不动（只动区块内）', async () => {
    const dir = await project();
    const file = path.join(dir, 'CLAUDE.local.md');
    await CLAUDE_MEMORY.appendVerdict({ projectPath: dir, text: '第一条' });
    let before = await readFile(file, 'utf-8');
    // 模拟用户在区块外追加一段
    before = `# 本机约定\n\n${before}`;
    await writeFile(file, before, 'utf-8');
    await CLAUDE_MEMORY.appendVerdict({ projectPath: dir, text: '第二条' });
    const after = await readFile(file, 'utf-8');
    expect(after.startsWith('# 本机约定')).toBe(true);
    expect(after).toContain('第一条');
    expect(after).toContain('第二条');
  });

  it('多行正文折叠单行（区块条目一行一条，窗口按条数裁）', async () => {
    const dir = await project();
    await CLAUDE_MEMORY.appendVerdict({ projectPath: dir, text: '第一行\n第二行\n\n第三行' });
    const text = await readFile(path.join(dir, 'CLAUDE.local.md'), 'utf-8');
    expect(text.match(/^- \[.+\] 第一行 第二行 第三行$/m)).toBeTruthy();
  });

  it('空正文 → 如实报错不写', async () => {
    const dir = await project();
    const result = await CLAUDE_MEMORY.appendVerdict({ projectPath: dir, text: '   ' });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain('empty');
  });
});
