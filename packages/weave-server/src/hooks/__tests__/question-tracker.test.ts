import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { QuestionTracker, type QuestionEventInput } from '../question-tracker.js';
import type { NormalizedHookPayload } from '../types.js';

const SESSION = 'sess-q';
const CODEX = 'sess-q-cdx';

/** NormalizedHookPayload 的窄构造（tracker 只读这几个字段）。 */
const payload = (partial: Partial<NormalizedHookPayload>): NormalizedHookPayload => ({
  eventType: 'UserPromptSubmit',
  toolName: null,
  toolInput: null,
  toolResponse: null,
  cwd: null,
  transcriptPath: null,
  raw: null,
  ...partial,
});

const preTool = (toolName: string, toolInput: unknown = null): NormalizedHookPayload =>
  payload({ eventType: 'PreToolUse', toolName, toolInput });

const postTool = (toolName: string): NormalizedHookPayload =>
  payload({ eventType: 'PostToolUse', toolName });

const notification = (type: string): NormalizedHookPayload =>
  payload({ eventType: 'Notification', raw: { notification_type: type } });

const AUA_INPUT = {
  questions: [
    {
      question: 'Which library?',
      header: 'Library',
      multiSelect: false,
      options: [
        { label: 'Redis', description: 'in-memory' },
        { label: 'SQLite', description: 'on-disk' },
      ],
    },
  ],
};

describe('QuestionTracker 状态机', () => {
  let db: ReturnType<typeof openDatabase>;
  let sessions: SessionRepository;
  let events: HookEventRepository;
  let projectId: number;
  let tracker: QuestionTracker;

  const feed = (
    sessionId: string,
    p: NormalizedHookPayload,
    source: QuestionEventInput['source'] = 'claude',
  ): void => tracker.onEvent({ sessionId, source, payload: p });

  beforeEach(() => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projectId = projects.register({
      path: '/q-proj',
      name: 'q',
      token: 'qtoken',
      source: 'init',
    }).id;
    sessions = new SessionRepository(db);
    events = new HookEventRepository(db);
    sessions.touch(SESSION, projectId);
    sessions.touch(CODEX, projectId);
    tracker = new QuestionTracker({ sessions, hookEvents: events });
  });

  afterEach(() => {
    db.close();
  });

  it('PreToolUse(AskUserQuestion) → 置位（问题面从 toolInput 解析）', () => {
    feed(SESSION, preTool('AskUserQuestion', AUA_INPUT));
    const entry = tracker.get(SESSION)!;
    expect(entry).not.toBeNull();
    expect(entry.kind).toBe('question');
    expect(entry.harness).toBe('claude');
    expect(entry.questions).toHaveLength(1);
    const q = entry.questions[0]!;
    expect(q.question).toBe('Which library?');
    expect(q.header).toBe('Library');
    expect(q.options).toHaveLength(2);
    expect(q.options[0]).toMatchObject({ label: 'Redis', keys: '1' });
    expect(q.options[1]).toMatchObject({ label: 'SQLite', keys: '2' });
  });

  it('多选问题：选项键序补一记 CR（数字勾选 + 回车确认）', () => {
    feed(
      SESSION,
      preTool('AskUserQuestion', {
        questions: [
          {
            question: 'Pick any',
            multiSelect: true,
            options: [{ label: 'A' }, { label: 'B' }],
          },
        ],
      }),
    );
    expect(tracker.get(SESSION)!.questions[0]!.options.map((o) => o.keys)).toEqual(['1\r', '2\r']);
  });

  it('坏 toolInput → OPAQUE 兜底（看得见阻塞、无远程作答面）', () => {
    feed(SESSION, preTool('AskUserQuestion', null));
    const entry = tracker.get(SESSION)!;
    expect(entry.questions).toHaveLength(1);
    expect(entry.questions[0]!.options).toHaveLength(0);
  });

  it('ExitPlanMode（toolInput 恒空）→ 合成计划确认问题', () => {
    feed(SESSION, preTool('ExitPlanMode', {}));
    const q = tracker.get(SESSION)!.questions[0]!;
    expect(q.key).toBe('ExitPlanMode:approve');
    expect(q.options.map((o) => o.label)).toEqual([
      'Yes, and auto-accept edits',
      'Yes, and manually approve edits',
      'No, keep planning',
    ]);
  });

  it('清除：PostToolUse(同名阻塞工具) / UserPromptSubmit / Stop', () => {
    feed(SESSION, preTool('AskUserQuestion', AUA_INPUT));
    feed(SESSION, postTool('AskUserQuestion'));
    expect(tracker.get(SESSION)).toBeNull();

    feed(SESSION, preTool('AskUserQuestion', AUA_INPUT));
    feed(SESSION, payload({ eventType: 'UserPromptSubmit' }));
    expect(tracker.get(SESSION)).toBeNull();

    feed(SESSION, preTool('AskUserQuestion', AUA_INPUT));
    feed(SESSION, payload({ eventType: 'Stop' }));
    expect(tracker.get(SESSION)).toBeNull();
  });

  it('PostToolUse(非阻塞工具) 不清 question 态（答完的信号只认同名阻塞工具）', () => {
    feed(SESSION, preTool('AskUserQuestion', AUA_INPUT));
    feed(SESSION, postTool('Bash'));
    expect(tracker.get(SESSION)).not.toBeNull();
  });

  it('Notification(permission_prompt) → 权限确认（带最近 PreToolUse 上下文）', () => {
    feed(SESSION, preTool('Bash', { command: 'rm -rf /tmp/x' }));
    feed(SESSION, notification('permission_prompt'));
    const entry = tracker.get(SESSION)!;
    expect(entry.kind).toBe('permission');
    const q = entry.questions[0]!;
    expect(q.key).toBe('permission:confirm');
    expect(q.question).toContain('Bash');
    expect(q.options.map((o) => o.label)).toEqual(['Yes', "Yes, and don't ask again this session", 'No (esc)']);
  });

  it('阻塞工具进行中的 permission_prompt → 不覆盖问题面（claude 恒补发的噪声）', () => {
    feed(SESSION, preTool('AskUserQuestion', AUA_INPUT));
    feed(SESSION, notification('permission_prompt')); // claude 在 PreToolUse 后 ~6s 必发
    const entry = tracker.get(SESSION)!;
    expect(entry.kind).toBe('question');
    expect(entry.questions[0]!.question).toBe('Which library?');
  });

  it('权限确认无前导工具事件 → 通用文案（不瞎猜工具）', () => {
    feed(SESSION, notification('permission_prompt'));
    expect(tracker.get(SESSION)!.questions[0]!.question).toBe('Claude needs your permission');
  });

  it('permission 态：任何非 Notification 事件即清（对话框了结必有下文）', () => {
    feed(SESSION, notification('permission_prompt'));
    feed(SESSION, postTool('Bash'));
    expect(tracker.get(SESSION)).toBeNull();

    feed(SESSION, notification('permission_prompt'));
    feed(SESSION, payload({ eventType: 'UserPromptSubmit' }));
    expect(tracker.get(SESSION)).toBeNull();
  });

  it('其他 Notification（idle 等）不动状态', () => {
    feed(SESSION, preTool('AskUserQuestion', AUA_INPUT));
    feed(SESSION, notification('idle'));
    expect(tracker.get(SESSION)).not.toBeNull();
  });

  it('非 harness 事件源 / 无 questions 槽的 harness 忽略', () => {
    feed(SESSION, preTool('AskUserQuestion', AUA_INPUT), 'webhook');
    expect(tracker.get(SESSION)).toBeNull();
    feed(CODEX, preTool('AskUserQuestion', AUA_INPUT), 'codex');
    expect(tracker.get(CODEX)).toBeNull();
  });

  it('markAnswered：多问题面只摘答的那问，摘空即删条目', () => {
    feed(
      SESSION,
      preTool('AskUserQuestion', {
        questions: [
          { question: 'Q1', options: [{ label: 'a' }] },
          { question: 'Q2', options: [{ label: 'b' }] },
        ],
      }),
    );
    const first = tracker.get(SESSION)!.questions[0]!;
    tracker.markAnswered(SESSION, first.key);
    const rest = tracker.get(SESSION)!;
    expect(rest.questions.map((q) => q.question)).toEqual(['Q2']);
    tracker.markAnswered(SESSION, rest.questions[0]!.key);
    expect(tracker.get(SESSION)).toBeNull();
    // 未知键 / 无条目 = 空操作
    tracker.markAnswered(SESSION, 'nope');
    expect(tracker.get(SESSION)).toBeNull();
  });

  it('snapshot 新在前；forgetSession 级联清', () => {
    feed(SESSION, preTool('ExitPlanMode', {}));
    feed(CODEX, preTool('ExitPlanMode', {})); // 后到 = 新
    expect(tracker.snapshot().map((e) => e.sessionId)[0]).toBe(CODEX);
    tracker.forgetSession(CODEX);
    expect(tracker.get(CODEX)).toBeNull();
    expect(tracker.snapshot()).toHaveLength(1);
  });

  it('seedFromDb：重放最近事件窗口重建待答面（含已答的中间事件）', () => {
    const insert = (p: NormalizedHookPayload): void => {
      events.insert({
        projectId,
        source: 'claude',
        eventType: p.eventType,
        sessionId: SESSION,
        payload: JSON.stringify(p),
      });
    };
    insert(payload({ eventType: 'UserPromptSubmit' })); // 前情
    insert(preTool('Bash', { command: 'ls' }));
    insert(preTool('AskUserQuestion', AUA_INPUT)); // 挂起中（最后一条）
    const fresh = new QuestionTracker({ sessions, hookEvents: events });
    fresh.seedFromDb();
    const entry = fresh.get(SESSION)!;
    expect(entry).not.toBeNull();
    expect(entry.questions[0]!.question).toBe('Which library?');

    // 末条是 PostToolUse（答完了）→ 重放后无待答
    insert(postTool('AskUserQuestion'));
    const settled = new QuestionTracker({ sessions, hookEvents: events });
    settled.seedFromDb();
    expect(settled.get(SESSION)).toBeNull();
  });
});
