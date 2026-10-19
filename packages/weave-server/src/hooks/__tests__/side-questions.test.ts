import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CLAUDE_SIDE_QUESTION, type MessagingSurface } from '@weavecode/harness';
import { openDatabase } from '../../db/db.js';
import { SideQuestionRepository } from '../../repositories/side-questions.js';
import { HookEventBus, type HookBusMessage } from '../bus.js';
import {
  claimSideAnswer,
  readSideQuestions,
  SIDE_ANSWER_WINDOW_MS,
  type SideQuestionDeps,
} from '../side-questions.js';

/**
 * 旁路会话域回归：宿主两侧都不落盘（侧问查询开着 skipTranscript），故
 * ① 问句由 weave 自己记、② 回答只能从采集事件认领 —— 认领判据归 harness
 * 能力面（claude = `SubagentStop` 且宿主没给这个 fork 留转录）。
 */

let db: DatabaseSync;
let repo: SideQuestionRepository;
let bus: HookEventBus;
let frames: HookBusMessage[];
let dir: string;

const surfaceFor = (): MessagingSurface => ({ sideQuestion: CLAUDE_SIDE_QUESTION }) as MessagingSurface;

const deps = (now?: number): SideQuestionDeps => ({
  repo,
  bus,
  surfaceFor,
  now: now === undefined ? undefined : () => now,
});

/** 一条 SubagentStop 的归一化载荷（`agent_transcript_path` 指向不存在 = skipTranscript）。 */
const subagentStop = (answer: string, transcript?: string): unknown => ({
  eventType: 'SubagentStop',
  raw: {
    agent_transcript_path: transcript ?? join(dir, 'no-such-agent.jsonl'),
    last_assistant_message: answer,
  },
});

const ask = (question = '它用的是什么方案？'): number =>
  repo.insert({ sessionId: 's1', projectId: 1, question }).id;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = new SideQuestionRepository(db);
  bus = new HookEventBus();
  frames = [];
  bus.subscribe((m) => frames.push(m));
  dir = mkdtempSync(join(tmpdir(), 'weave-sideq-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('harness 判据（claude SideQuestionSpec.answerOf）', () => {
  it('没有转录的子 agent = 旁路回答，取全文', () => {
    expect(CLAUDE_SIDE_QUESTION.answerOf('SubagentStop', subagentStop('答案正文'))).toBe('答案正文');
  });

  it('有转录的子 agent（task / skill）不是旁路回答', () => {
    const file = join(dir, 'agent-abc.jsonl');
    writeFileSync(file, '{}\n');
    expect(CLAUDE_SIDE_QUESTION.answerOf('SubagentStop', subagentStop('子任务总结', file))).toBeNull();
  });

  it('压缩摘要形态不算旁路回答', () => {
    expect(
      CLAUDE_SIDE_QUESTION.answerOf('SubagentStop', subagentStop('<analysis>x</analysis>')),
    ).toBeNull();
  });

  it('非 SubagentStop 一律不认', () => {
    expect(CLAUDE_SIDE_QUESTION.answerOf('Stop', subagentStop('答案'))).toBeNull();
  });

  it('问句形态：单行、非空、不过长', () => {
    expect(CLAUDE_SIDE_QUESTION.validate(' 你好 ')).toEqual({ ok: true, text: '你好' });
    expect(CLAUDE_SIDE_QUESTION.validate('   ').ok).toBe(false);
    expect(CLAUDE_SIDE_QUESTION.validate('两\n行').ok).toBe(false);
    expect(CLAUDE_SIDE_QUESTION.validate('x'.repeat(2_001)).ok).toBe(false);
    expect(CLAUDE_SIDE_QUESTION.command('你好')).toBe('/btw 你好');
  });
});

describe('认领（claimSideAnswer）', () => {
  it('有 pending 行即认领最早那条，广播一帧', () => {
    ask('先问的');
    ask('后问的');
    const row = claimSideAnswer(deps(), {
      sessionId: 's1',
      source: 'claude',
      eventType: 'SubagentStop',
      payload: subagentStop('第一个的答案'),
      eventId: 77,
    });
    expect(row).toMatchObject({ question: '先问的', answer: '第一个的答案', status: 'answered' });
    expect(row?.answerEventId).toBe(77);
    expect(frames).toEqual([
      expect.objectContaining({ kind: 'sideQuestion.answered', sessionId: 's1', sideQuestionId: row!.id }),
    ]);
  });

  it('没有 pending 行（人工在宿主面板里发的侧问）不认领', () => {
    expect(
      claimSideAnswer(deps(), {
        sessionId: 's1',
        source: 'claude',
        eventType: 'SubagentStop',
        payload: subagentStop('别处的回答'),
        eventId: 1,
      }),
    ).toBeNull();
    expect(frames).toEqual([]);
  });

  it('超窗的 pending 不再认领（回答来得太晚）', () => {
    ask();
    const late = Date.now() + SIDE_ANSWER_WINDOW_MS + 60_000;
    expect(
      claimSideAnswer(deps(late), {
        sessionId: 's1',
        source: 'claude',
        eventType: 'SubagentStop',
        payload: subagentStop('太晚了'),
        eventId: 2,
      }),
    ).toBeNull();
  });

  it('别的 harness（能力面无旁路）不认领', () => {
    ask();
    expect(
      claimSideAnswer(
        { repo, surfaceFor: () => ({ sideQuestion: null }) as MessagingSurface },
        {
          sessionId: 's1',
          source: 'codex',
          eventType: 'SubagentStop',
          payload: subagentStop('答案'),
          eventId: 3,
        },
      ),
    ).toBeNull();
  });
});

describe('清理', () => {
  it('读列表前把超窗的 pending 落定成 timeout，并按 id 倒序分页', () => {
    ask('q1');
    ask('q2');
    const rows = readSideQuestions(deps(Date.now() + SIDE_ANSWER_WINDOW_MS + 60_000), 's1', {
      limit: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ question: 'q2', status: 'timeout' });
    expect(readSideQuestions(deps(), 's1', { limit: 10, beforeId: rows[0]!.id })[0]).toMatchObject({
      question: 'q1',
      status: 'timeout',
    });
  });

  it('删会话级联清掉该会话的旁路历史', () => {
    ask();
    repo.insert({ sessionId: 's2', projectId: 1, question: '别人的' });
    expect(repo.deleteBySession('s1')).toBe(1);
    expect(repo.list('s1', { limit: 10 })).toEqual([]);
    expect(repo.list('s2', { limit: 10 })).toHaveLength(1);
  });
});
