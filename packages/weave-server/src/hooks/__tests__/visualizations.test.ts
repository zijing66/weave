import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { activeVisualRefOf, lastStopTextOf, visualizeRefsIn } from '../visualizations.js';

const CANONICAL = (p: string): string => `\u{e200}visualize\u{e202}${JSON.stringify({ path: p })}\u{e201}`;

describe('visualizeRefsIn', () => {
  it('canonical 形 / LANGUAGE TAG 别名 / 裸 visualize 三种都认，返回原文行与绝对路径', () => {
    const target = path.resolve('/tmp/panel.html');
    const lines = [
      `  ${CANONICAL('/tmp/panel.html')}  `,
      `\u{e0000}visualize\u{e0001}${JSON.stringify({ path: '/tmp/panel.html' })}\u{e0002}`,
      `visualize${JSON.stringify({ path: '/tmp/panel.html' })}`,
    ];
    const refs = visualizeRefsIn(lines.join('\n'));
    expect(refs).toHaveLength(3);
    expect(refs.map((r) => r.path)).toEqual([target, target, target]);
    expect(refs[0]!.line).toBe(lines[0]!.trim());
    expect(refs[2]!.line).toBe(lines[2]!.trim());
  });

  it('坏 JSON / 缺 path / 正文里的普通提及都不命中', () => {
    const text = [
      '\u{e200}visualize\u{e202}{bad json}\u{e201}',
      `\u{e200}visualize\u{e202}${JSON.stringify({ noPath: 1 })}\u{e201}`,
      'use visualize to show a chart',
      '`visualize{"path":"/tmp/x.html"}` wrapped',
    ].join('\n');
    expect(visualizeRefsIn(text)).toEqual([]);
  });
});

describe('activeVisualRefOf', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('fragment 还在 → 取最后一条引用行（前一条历史引用不参与）', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'weave-viz-'));
    const fragment = path.join(dir, 'panel.html');
    writeFileSync(fragment, '<html>ok</html>');
    const text = `${CANONICAL('/tmp/nope.html')}\n${CANONICAL(fragment)}`;
    const ref = activeVisualRefOf(text, '2026-11-05T00:00:00.000Z');
    expect(ref).toEqual({ line: CANONICAL(fragment), path: fragment, at: '2026-11-05T00:00:00.000Z' });
  });

  it('fragment 已被删 → null（不再续投）', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'weave-viz-'));
    expect(activeVisualRefOf(CANONICAL(path.join(dir, 'gone.html')))).toBeNull();
  });

  it('没有引用行 → null', () => {
    expect(activeVisualRefOf('普通回复')).toBeNull();
  });
});

describe('lastStopTextOf', () => {
  const stopRow = (id: number, text: string) => ({
    id,
    payload: JSON.stringify({ raw: { last_assistant_message: text } }),
  });
  const repoOf = (rows: ReturnType<typeof stopRow>[]) => ({
    listBySession: (_sid: string, limit = 300, beforeId?: number) =>
      rows.filter((r) => beforeId == null || r.id < beforeId).slice(-limit),
  });

  it('取最近一条带引用行的最终回复；最近一轮没写引用行时往前翻（粘性）', () => {
    const line = CANONICAL('/tmp/panel.html');
    expect(lastStopTextOf(repoOf([stopRow(1, `甲\n${line}`)]), 's1')).toBe(`甲\n${line}`);
    // 后一轮只说别的：粘性要求仍然认出上一轮那个块
    expect(lastStopTextOf(repoOf([stopRow(1, `甲\n${line}`), stopRow(2, '乙')]), 's1')).toBe(`甲\n${line}`);
  });

  it('从没展示过 / 正文空 / payload 坏 → null，坏行跳过不影响更早的命中', () => {
    expect(lastStopTextOf(repoOf([]), 's1')).toBeNull();
    expect(lastStopTextOf(repoOf([stopRow(1, '普通回复')]), 's1')).toBeNull();
    expect(lastStopTextOf(repoOf([stopRow(1, '  ')]), 's1')).toBeNull();
    expect(
      lastStopTextOf(
        repoOf([stopRow(1, CANONICAL('/tmp/p.html')), { id: 2, payload: '{bad' }]),
        's1',
      ),
    ).toBe(CANONICAL('/tmp/p.html'));
  });

  it('一页装不下时按 beforeId 往前翻（游标不能停在第 1 页）', () => {
    const line = CANONICAL('/tmp/old.html');
    const rows = [stopRow(1, `老\n${line}`), ...Array.from({ length: 6 }, (_, i) => stopRow(i + 2, 'x'))];
    expect(lastStopTextOf(repoOf(rows), 's1', 3)).toBe(`老\n${line}`);
  });
});
