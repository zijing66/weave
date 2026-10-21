import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HookEventRow } from '../../repositories/hook-events.js';
import {
  importPromptImages,
  importPromptImagesOnce,
  needsImageImport,
  type PromptImageDeps,
} from '../prompt-images.js';

/**
 * 入站图补采：转录里的图 → 落 uploads → 挂到带 `[Image #N]` 占位、还没挂图的
 * 开轮事件上。这里用假 deps 记账，面走真 claude（真转录格式）。
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-prompt-images-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ups = (id: number, prompt: string, at: string): HookEventRow => ({
  id,
  projectId: 1,
  source: 'claude',
  eventType: 'UserPromptSubmit',
  sessionId: 'sess',
  payload: JSON.stringify({ raw: { prompt } }),
  createdAt: at,
});

const userEntry = (text: string, b64: string, at?: string) => ({
  type: 'user',
  ...(at ? { timestamp: at } : {}),
  message: {
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
    ],
  },
});

const transcript = (lines: unknown[]): string => {
  const path = join(dir, 'sess.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
  return path;
};

const b64 = (s: string): string => Buffer.from(s).toString('base64');

interface Recorder {
  deps: PromptImageDeps;
  saved: Array<{ name: string; bytes: string }>;
  links: Array<{ eventId: number; ids: string[] }>;
  scans: () => number;
}

const recorder = (
  rows: HookEventRow[],
  linked: Array<[number, unknown[]]>,
  transcriptPath: string | null,
): Recorder => {
  const saved: Recorder['saved'] = [];
  const links: Recorder['links'] = [];
  let scans = 0;
  let n = 0;
  return {
    saved,
    links,
    scans: () => scans,
    deps: {
      hookEvents: {
        listBySession(_sessionId, _limit, _beforeId, types) {
          scans += 1;
          return types ? rows.filter((r) => types.includes(r.eventType)) : rows;
        },
      },
      uploads: {
        save(input) {
          saved.push({ name: input.name, bytes: input.bytes.toString() });
          n += 1;
          return { id: `up-${n}` };
        },
        linkToEvent(eventId, ids) {
          links.push({ eventId, ids: [...ids] });
        },
        imagesBySession: () => new Map(linked),
      },
      sessionProbe: { transcriptPathOf: () => transcriptPath },
    },
  };
};

describe('importPromptImages', () => {
  it('只给「缺图」那条挂链，已挂图的事件不再动', async () => {
    const rows = [ups(1, '看看这个 [Image #1]', '2026-10-21T01:00:00.000Z')];
    const path = transcript([
      userEntry('看看这个 [Image #1]', b64('one'), '2026-10-21T01:00:00.000Z'),
      userEntry('另一张 [Image #2]', b64('two'), '2026-10-21T02:00:00.000Z'),
    ]);
    // 第 2 条事件已经挂了图（本轮不该再搬第二张）
    const rec = recorder(
      [...rows, ups(2, '另一张 [Image #2]', '2026-10-21T02:00:00.000Z')],
      [[2, [{ id: 'old' }]]],
      path,
    );
    expect(await importPromptImages(rec.deps, 'sess', 'claude')).toBe(1);
    expect(rec.saved.map((s) => s.bytes)).toEqual(['one']);
    expect(rec.links).toEqual([{ eventId: 1, ids: ['up-1'] }]);
    expect(rec.saved[0]!.name).toMatch(/^pasted-\d+\.png$/);
  });

  it('正文对不上就不硬挂（近时刻也不算）', async () => {
    const rows = [ups(1, '完全不同的正文 [Image #1]', '2026-10-21T01:00:00.000Z')];
    const path = transcript([userEntry('转录里那句 [Image #1]', b64('one'), '2026-10-21T01:00:00.000Z')]);
    const rec = recorder(rows, [], path);
    expect(await importPromptImages(rec.deps, 'sess', 'claude')).toBe(0);
    expect(rec.saved).toHaveLength(0);
    expect(rec.links).toHaveLength(0);
  });

  it('纯图消息（两侧正文都空）按时间兜底：窗口内认、超窗不认', async () => {
    const near = transcript([userEntry('', b64('near'), '2026-10-21T01:00:30.000Z')]);
    const rec1 = recorder([ups(1, '[Image #1]', '2026-10-21T01:00:00.000Z')], [], near);
    expect(await importPromptImages(rec1.deps, 'sess', 'claude')).toBe(1);
    expect(rec1.links).toEqual([{ eventId: 1, ids: ['up-1'] }]);

    rmSync(near);
    const far = transcript([userEntry('', b64('far'), '2026-10-21T03:00:00.000Z')]);
    const rec2 = recorder([ups(1, '[Image #1]', '2026-10-21T01:00:00.000Z')], [], far);
    expect(await importPromptImages(rec2.deps, 'sess', 'claude')).toBe(0);
    expect(rec2.links).toHaveLength(0);
  });

  it('转录读不到 / 没面 → 0，不抛', async () => {
    const rec = recorder([ups(1, '[Image #1]', '2026-10-21T01:00:00.000Z')], [], null);
    expect(await importPromptImages(rec.deps, 'sess', 'claude')).toBe(0);
    const noSurface = recorder([ups(1, '[Image #1]', '2026-10-21T01:00:00.000Z')], [], null);
    expect(await importPromptImages(noSurface.deps, 'sess', 'codex')).toBe(0);
  });
});

describe('needsImageImport', () => {
  it('只认「开轮事件 + 带占位 + 没挂图」', () => {
    expect(needsImageImport([ups(1, '看图 [Image #1]', '2026-10-21T01:00:00.000Z')], new Map())).toBe(true);
    expect(
      needsImageImport([ups(1, '看图 [Image #1]', '2026-10-21T01:00:00.000Z')], new Map([[1, [{ id: 'x' }]]])),
    ).toBe(false);
    expect(needsImageImport([ups(1, '没有图', '2026-10-21T01:00:00.000Z')], new Map())).toBe(false);
  });
});

describe('importPromptImagesOnce', () => {
  it('同一会话只扫一次（第二次直接返回 false）', async () => {
    const path = transcript([userEntry('看图 [Image #1]', b64('one'), '2026-10-21T01:00:00.000Z')]);
    const rec = recorder([ups(1, '看图 [Image #1]', '2026-10-21T01:00:00.000Z')], [], path);
    expect(await importPromptImagesOnce(rec.deps, 'sess-once', 'claude')).toBe(true);
    expect(await importPromptImagesOnce(rec.deps, 'sess-once', 'claude')).toBe(false);
    expect(rec.links).toHaveLength(1);
    // 一次补采 = 两次 listBySession（待认领 + 取 transcriptPath）；再扫就会翻倍
    expect(rec.scans()).toBe(2);
  });
});
