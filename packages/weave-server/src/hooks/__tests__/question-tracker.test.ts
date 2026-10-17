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
    expect(q.options[0]).toMatchObject({ label: 'Redis', keys: ['1'] });
    expect(q.options[1]).toMatchObject({ label: 'SQLite', keys: ['2'] });
    // 宿主尾行：n+1 = Other（自定义输入，单选数字即变文本框 + 回车收尾）、
    // n+2 = Chat about this（两模式都有）；一问单选 → 无 Submit 步
    expect(q.options.map((o) => o.label)).toEqual([
      'Redis',
      'SQLite',
      'Type something',
      'Chat about this',
    ]);
    expect(q.options[2]).toMatchObject({ keys: ['3'], input: true, textTail: ['\r'] });
    expect(q.options[3]).toMatchObject({ keys: ['4'], chat: true });
    expect(q.submit).toBeUndefined();
  });

  it('多选问题：数字只勾选（不补 CR）、尾行（Other/Chat）与 Submit 步都在末尾', () => {
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
    const questions = tracker.get(SESSION)!.questions;
    expect(questions[0]!.options.map((o) => o.keys)).toEqual([['1'], ['2'], ['3'], ['4']]);
    expect(questions[0]!.options[2]).toMatchObject({ input: true, textTail: ['\t', '\r'] });
    expect(questions[0]!.options[3]).toMatchObject({ label: 'Chat about this', chat: true });
    expect(questions.at(-1)).toMatchObject({
      key: 'AskUserQuestion:submit',
      submit: true,
      options: [{ keys: ['\t', '1'] }, { keys: ['\t', '2'] }],
    });
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
      'Yes, auto-accept edits',
      'Yes, manually approve edits',
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
    expect(q.options.map((o) => o.label)).toEqual([
      'Yes',
      "Yes, and don't ask again for this tool",
      'No, and tell Claude what to do differently (esc)',
    ]);
  });

  it('auto 模式的权限确认 → 2 行分类器面（第 2 行是拒绝，不是「别再问」）', () => {
    feed(SESSION, payload({ eventType: 'PreToolUse', toolName: 'Bash', toolInput: {}, raw: { permission_mode: 'auto' } }));
    feed(SESSION, notification('permission_prompt'));
    const q = tracker.get(SESSION)!.questions[0]!;
    expect(q.options.map((o) => o.label)).toEqual([
      'Yes, and tell Claude what to do next',
      'No',
    ]);
  });

  it('阻塞工具进行中的 permission_prompt → 不覆盖问题面（claude 恒补发的噪声）', () => {
    feed(SESSION, preTool('AskUserQuestion', AUA_INPUT));
    feed(SESSION, notification('permission_prompt')); // claude 在 PreToolUse 后 ~6s 必发
    const entry = tracker.get(SESSION)!;
    expect(entry.kind).toBe('question');
    expect(entry.questions[0]!.question).toBe('Which library?');
  });

  it('真权限对话框（归属非阻塞工具）不受抑制——该覆盖就覆盖', () => {
    feed(SESSION, preTool('AskUserQuestion', AUA_INPUT));
    feed(SESSION, preTool('PowerShell', { command: 'npm publish' }));
    feed(SESSION, notification('permission_prompt'));
    const entry = tracker.get(SESSION)!;
    expect(entry.kind).toBe('permission');
    expect(entry.questions[0]!.question).toContain('PowerShell');
  });

  it('bypassPermissions 模式下 permission_prompt 恒为噪声（该模式不弹权限对话框）', () => {
    const pre = (tool: string): NormalizedHookPayload =>
      payload({
        eventType: 'PreToolUse',
        toolName: tool,
        raw: { permission_mode: 'bypassPermissions' },
      });
    feed(SESSION, pre('PowerShell'));
    feed(SESSION, notification('permission_prompt'));
    expect(tracker.get(SESSION)).toBeNull();

    feed(SESSION, pre('AskUserQuestion'));
    feed(SESSION, notification('permission_prompt'));
    expect(tracker.get(SESSION)!.kind).toBe('question');
  });

  it('dontAsk 同属静默模式（不提示权限、未预批准直接拒）', () => {
    const pre = (tool: string): NormalizedHookPayload =>
      payload({
        eventType: 'PreToolUse',
        toolName: tool,
        raw: { permission_mode: 'dontAsk' },
      });
    feed(SESSION, pre('PowerShell'));
    feed(SESSION, notification('permission_prompt'));
    expect(tracker.get(SESSION)).toBeNull();
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

  it('markAnswered：整 call 一次提交 → 整条摘除（无条目 = 空操作）', () => {
    feed(
      SESSION,
      preTool('AskUserQuestion', {
        questions: [
          { question: 'Q1', options: [{ label: 'a' }] },
          { question: 'Q2', options: [{ label: 'b' }] },
        ],
      }),
    );
    expect(tracker.get(SESSION)).not.toBeNull();
    tracker.markAnswered(SESSION);
    expect(tracker.get(SESSION)).toBeNull();
    tracker.markAnswered(SESSION);
    expect(tracker.get(SESSION)).toBeNull();
  });

  it('新挂起待答广播 onPending：只在「无 → 有」时播一次', () => {
    const seen: string[] = [];
    const t2 = new QuestionTracker({
      sessions,
      hookEvents: events,
      onPending: (e) => seen.push(e.sessionId),
    });
    const feed2 = (p: NormalizedHookPayload): void =>
      t2.onEvent({ sessionId: SESSION, source: 'claude', payload: p });

    feed2(preTool('AskUserQuestion', AUA_INPUT));
    expect(seen).toEqual([SESSION]);
    // 同一会话连续挂起（未清除）→ 不重复打扰
    feed2(preTool('AskUserQuestion', AUA_INPUT));
    expect(seen).toEqual([SESSION]);
    // 答完再挂起 → 算新的一次
    feed2(postTool('AskUserQuestion'));
    feed2(preTool('AskUserQuestion', AUA_INPUT));
    expect(seen).toEqual([SESSION, SESSION]);
  });

  it('seedFromDb 重放重建不广播 onPending（重建不是新发生）', () => {
    events.insert({
      projectId,
      source: 'claude',
      eventType: 'PreToolUse',
      sessionId: SESSION,
      payload: JSON.stringify(preTool('AskUserQuestion', AUA_INPUT)),
    });
    const seen: string[] = [];
    const t2 = new QuestionTracker({
      sessions,
      hookEvents: events,
      onPending: (e) => seen.push(e.sessionId),
    });
    t2.seedFromDb();
    expect(seen).toEqual([]);
    expect(t2.get(SESSION)).not.toBeNull();
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

  /** 模型切换确认事件（判据字段归 harness 规格读，tracker 只透传 raw）。 */
  const switchPre = (raw: unknown = {
    from_model: 'claude-sonnet-4-5',
    to_model: 'deepseek-flash',
    prompt_cache_warm: true,
    source: 'command',
  }): NormalizedHookPayload => payload({ eventType: 'PreModelSwitch', raw });

  it('PreModelSwitch（缓存已暖 + 换模型）→ 模型切换确认（kind=switch）', () => {
    feed(SESSION, switchPre());
    const entry = tracker.get(SESSION)!;
    expect(entry.kind).toBe('switch');
    const q = entry.questions[0]!;
    expect(q.key).toBe('model:switch');
    expect(q.options.map((o) => o.label)).toEqual(['Yes, switch to deepseek-flash', 'No, go back']);
    expect(q.options.map((o) => o.keys)).toEqual([['1'], ['2']]);
    expect(q.submit).toBeUndefined();
  });

  it('判据不成立（缓存冷 / 同模型）→ 不置位（面板有问、终端无框会打进输入框）', () => {
    feed(SESSION, switchPre({ from_model: 'a', to_model: 'b', prompt_cache_warm: false }));
    expect(tracker.get(SESSION)).toBeNull();
    feed(SESSION, switchPre({ from_model: 'a', to_model: 'a', prompt_cache_warm: true }));
    expect(tracker.get(SESSION)).toBeNull();
  });

  it('switch 态落定：PostModelSwitch / UserPromptSubmit / Stop 任意动静即清', () => {
    feed(SESSION, switchPre());
    feed(SESSION, payload({ eventType: 'PostModelSwitch' }));
    expect(tracker.get(SESSION)).toBeNull();

    feed(SESSION, switchPre());
    feed(SESSION, payload({ eventType: 'UserPromptSubmit' }));
    expect(tracker.get(SESSION)).toBeNull();

    feed(SESSION, switchPre());
    feed(SESSION, payload({ eventType: 'Stop' }));
    expect(tracker.get(SESSION)).toBeNull();
  });

  it('其他 Notification 不清 switch 态（idle 等与对话框无关）', () => {
    feed(SESSION, switchPre());
    feed(SESSION, notification('idle'));
    expect(tracker.get(SESSION)).not.toBeNull();
    expect(tracker.get(SESSION)!.kind).toBe('switch');
  });

  it('switch 的 onPending 同样只播「无→有」；落定后再来才算新的一次', () => {
    const seen: string[] = [];
    const t2 = new QuestionTracker({
      sessions,
      hookEvents: events,
      onPending: (e) => seen.push(`${e.sessionId}:${e.kind}`),
    });
    const feed2 = (p: NormalizedHookPayload): void =>
      t2.onEvent({ sessionId: SESSION, source: 'claude', payload: p });

    feed2(switchPre());
    expect(seen).toEqual([`${SESSION}:switch`]);
    feed2(switchPre()); // 同一确认框仍挂着 → 不重复打扰
    expect(seen).toEqual([`${SESSION}:switch`]);
    feed2(payload({ eventType: 'PostModelSwitch' }));
    feed2(switchPre());
    expect(seen).toEqual([`${SESSION}:switch`, `${SESSION}:switch`]);
  });

  it('markAnswered 对 switch 态同样整条摘除', () => {
    feed(SESSION, switchPre());
    tracker.markAnswered(SESSION);
    expect(tracker.get(SESSION)).toBeNull();
  });
});
