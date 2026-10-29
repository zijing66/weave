import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { SpawnOptions } from 'node:child_process';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { CLAUDE_PROMPT_INBOX, type MessagingSurface, type PromptRelaySpec } from '@weavecode/harness';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { HookDispatchRepository } from '../../repositories/hook-dispatches.js';
import { HookRuleRepository } from '../../repositories/hook-rules.js';
import { HookEventBus, type HookBusMessage } from '../bus.js';
import { HeadlessRunner, type SpawnLike } from '../headless-runner.js';
import {
  MessageDeliverer,
  type MessageDelivererDeps,
  type PromptTerminal,
  type SendResult,
} from '../message-deliverer.js';
import { ResumeRunner } from '../resume-runner.js';
import { CLAUDE_REG_GRACE_MS } from '../../daemon/claude-liveness.js';
import { hookShardId } from '../mirror.js';
import { INBOX_TARGETS_FILE } from '../inbox-socket.js';
import { readPromptbox } from '../promptbox.js';

const PROJECT_PATH = resolve('/msg-proj');
const TOKEN = 'mtoken';
const SESSION_ID = 'sess-msg';
const CODEX_SESSION = 'sess-cdx';
const PEER_NAME = 'msg-target';

/** 结构上满足 SpawnChild.stdin 的假管道：记录 prompt 写入。 */
class FakeStdin extends EventEmitter {
  readonly writes: string[] = [];
  write(chunk: string): void {
    this.writes.push(chunk);
  }
  end(): void {}
}

class FakeChild extends EventEmitter {
  readonly pid = 7777;
  readonly stdin = new FakeStdin();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

interface SpawnCall {
  cmd: string;
  args: readonly string[];
  options: SpawnOptions;
}

function createFakeSpawn() {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawnImpl: SpawnLike = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { calls, children, spawnImpl };
}

/** prompt 测试面：resolve 可控的中继规格（默认命中 PEER_NAME）。 */
function relaySurface(resolve: (sessionId: string) => { name: string } | null = () => ({ name: PEER_NAME })) {
  const relay: PromptRelaySpec = {
    bin: 'fake-relay',
    args: ['-p', '--no-session-persistence'],
    senderName: 'weave',
    instruction: (peerName, text, opts) =>
      `Send to "${peerName}"${opts.oneWay ? ' [one-way]' : ''}: ${text}`,
    resolve,
  };
  const surface: MessagingSurface = {
    harness: 'claude',
    discovery: true,
    prompt: relay,
    promptInbox: CLAUDE_PROMPT_INBOX,
    inject: { rideEvents: ['UserPromptSubmit'] },
    headless: null,
    idleSignals: ['Stop'],
    sideQuestion: null,
  };
  return { relay, surface };
}

/** 假会话 inbox：起一个本地地址（win32 命名管 / POSIX unix socket），回传收到的字节。 */
const fakeInboxAt = (path: string, onData: (text: string) => void): Promise<net.Server> =>
  new Promise((resolve) => {
    const server = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (c) => {
        buf += String(c);
      });
      conn.on('end', () => onData(buf));
    });
    server.listen(path, () => resolve(server));
  });

const uniqueInboxPath = (): string =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\weave-msg-test-${randomBytes(8).toString('hex')}`
    : `/tmp/weave-msg-test-${randomBytes(8).toString('hex')}.sock`;

describe('MessageDeliverer 裁决表', () => {
  let db: ReturnType<typeof openDatabase>;
  let sessions: SessionRepository;
  let events: HookEventRepository;
  let bus: HookEventBus;
  let busEvents: HookBusMessage[];
  let projectId: number;
  let hooksDir: string;

  const pushEvent = (sessionId: string, eventType: string, source: 'claude' | 'codex' = 'claude') =>
    events.insert({ projectId, source, eventType, sessionId, payload: '{}' });

  /** 把 last_seen 推回新会话豁免窗之外（判活的「不是新鲜会话」前提）。 */
  const backdateLastSeen = (sessionId: string) =>
    db
      .prepare('UPDATE sessions SET last_seen_at = ? WHERE session_id = ?')
      .run(new Date(Date.now() - CLAUDE_REG_GRACE_MS * 10).toISOString(), sessionId);

  const makeDeps = (extra: Partial<MessageDelivererDeps> = {}): MessageDelivererDeps => ({
    sessions,
    projects: new ProjectRepository(db),
    hookEvents: events,
    bus,
    hooksDir,
    ...extra,
  });

  const send = (deliverer: MessageDeliverer, body: Record<string, unknown>) =>
    deliverer.send({
      toSessionId: SESSION_ID,
      text: 'hello',
      mode: 'auto',
      fromKind: 'dashboard',
      ...body,
    });

  beforeEach(() => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const project = projects.register({
      path: PROJECT_PATH,
      name: 'msg',
      token: TOKEN,
      source: 'init',
    });
    projectId = project.id;
    sessions = new SessionRepository(db);
    events = new HookEventRepository(db);
    bus = new HookEventBus();
    busEvents = [];
    bus.subscribe((m) => busEvents.push(m));
    sessions.touch(SESSION_ID, projectId);
    sessions.touch(CODEX_SESSION, projectId);
    hooksDir = mkdtempSync(join(tmpdir(), 'weave-msg-'));
  });

  afterEach(() => {
    db.close();
    rmSync(hooksDir, { recursive: true, force: true });
  });

  it('会话不存在 → 404，且无任何管道痕迹', async () => {
    const deliverer = new MessageDeliverer(makeDeps());
    const result = await send(deliverer, { toSessionId: 'sess-unknown' });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(deliverer.listVisible('sess-unknown')).toHaveLength(0);
  });

  it('harness 无法判定（零事件）→ 400', async () => {
    const deliverer = new MessageDeliverer(makeDeps());
    const result = await send(deliverer, { toSessionId: CODEX_SESSION });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it('codex 面：inject / headless / auto 均 409 + 面内原因；prompt 走宿主队列', async () => {
    const deliverer = new MessageDeliverer(makeDeps());
    pushEvent(CODEX_SESSION, 'Stop', 'codex');
    for (const mode of ['inject', 'headless', 'auto'] as const) {
      const result = await deliverer.send({
        toSessionId: CODEX_SESSION,
        text: 'hi',
        mode,
        fromKind: 'dashboard',
      });
      expect(result, mode).toMatchObject({ ok: false, status: 409 });
    }
    // prompt：codex 面有 queuedPrompt（codex queue）——spawn 真实 CLI 会失败（无此会话），
    // 失败即回落，三层全无通路 → 入队（不 409）。
    const prompt = await deliverer.send({
      toSessionId: CODEX_SESSION,
      text: 'hi',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(prompt).toMatchObject({ ok: true, status: 'pending' });
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(1);
  });

  it('inject 通道：信封落 outbox → injected + created/delivered 帧', async () => {
    const deliverer = new MessageDeliverer(makeDeps());
    pushEvent(SESSION_ID, 'UserPromptSubmit');

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'hello body',
      mode: 'inject',
      fromKind: 'dashboard',
    });
    expect(result).toMatchObject({ ok: true, status: 'injected' });

    const lines = readFileSync(join(hooksDir, 'outbox', `${hookShardId(TOKEN)}.jsonl`), 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as { sessionId: string; text: string; at: string };
    expect(entry.sessionId).toBe(SESSION_ID);
    expect(entry.text).toContain('[weave message] from=dashboard');
    expect(entry.text).toContain('mode=inject');
    expect(entry.text.endsWith('hello body')).toBe(true);

    const msg = deliverer.getMessage(result.ok ? result.messageId : '')!;
    expect(msg.status).toBe('injected');
    expect(msg.mode).toBe('inject');
    expect(busEvents).toContainEqual(
      expect.objectContaining({ kind: 'message.created', sessionId: SESSION_ID }),
    );
    expect(busEvents).toContainEqual(
      expect.objectContaining({ kind: 'message.delivered', messageId: msg.id }),
    );
  });

  it('headless 通道：spawn 参数带信封、running → 退出 0 落 succeeded + finished 帧', async () => {
    const fake = createFakeSpawn();
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, bin: 'fake-claude' }),
    );
    pushEvent(SESSION_ID, 'Stop');

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'run this',
      mode: 'headless',
      fromKind: 'dashboard',
    });
    expect(result).toMatchObject({ ok: true, status: 'running' });
    expect(typeof (result as { messageId: string }).messageId).toBe('string');
    expect(fake.calls).toHaveLength(1);
    // CLAUDE_RESUME.promptStdin：信封经 stdin，命令行无用户内容（win32 = joined 串）
    const onWin = process.platform === 'win32';
    expect(fake.calls[0]!.cmd).toBe(onWin ? `fake-claude --resume ${SESSION_ID} -p` : 'fake-claude');
    expect(fake.calls[0]!.args).toEqual(onWin ? [] : ['--resume', SESSION_ID, '-p']);
    expect(fake.children[0]!.stdin.writes[0]).toContain('run this');
    expect(fake.calls[0]!.options.cwd).toBe(PROJECT_PATH);

    fake.children[0]!.stdout.emit('data', Buffer.from('answer'));
    fake.children[0]!.emit('exit', 0, null);

    const msg = deliverer.getMessage((result as { messageId: string }).messageId)!;
    expect(msg.status).toBe('succeeded');
    expect(msg.output).toContain('answer');
    expect(busEvents).toContainEqual(
      expect.objectContaining({ kind: 'message.finished', messageId: msg.id, status: 'succeeded' }),
    );
    // 终态驻留在途视图（headless 结果可见 = 设计语义）
    expect(deliverer.listVisible(SESSION_ID).map((m) => m.status)).toContain('succeeded');
  });

  it('auto 忙（turnOpen）→ inject 落 outbox，绝不无头抢占', async () => {
    const deliverer = new MessageDeliverer(makeDeps());
    pushEvent(SESSION_ID, 'UserPromptSubmit');
    pushEvent(SESSION_ID, 'Stop');
    pushEvent(SESSION_ID, 'UserPromptSubmit'); // 回合开

    const result = await send(deliverer, {});
    expect(result).toMatchObject({ ok: true, status: 'injected' });
    expect(deliverer.getMessage((result as { messageId: string }).messageId)!.mode).toBe('auto');
    expect(readFileSync(join(hooksDir, 'outbox', `${hookShardId(TOKEN)}.jsonl`), 'utf8')).toContain(
      'mode=inject',
    );
  });

  it('auto 闲 → headless 强制回合', async () => {
    const fake = createFakeSpawn();
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, bin: 'fake-claude' }),
    );
    pushEvent(SESSION_ID, 'UserPromptSubmit');
    pushEvent(SESSION_ID, 'Stop'); // 回合合

    const result = await send(deliverer, {});
    expect(result).toMatchObject({ ok: true, status: 'running' });
    expect(fake.calls).toHaveLength(1);
    expect(deliverer.getMessage((result as { messageId: string }).messageId)!.mode).toBe('auto');
  });

  it('auto 忙 + 面无 inject 通道 → 409（不降级无头抢占）', async () => {
    const noInject: MessagingSurface = {
      harness: 'claude',
      discovery: true,
      prompt: null,
      inject: null,
      headless: {
        supported: true,
        bin: 'claude',
        args: (sessionId: string, prompt: string) => ['--resume', sessionId, '-p', prompt],
      },
      idleSignals: ['Stop'],
      unsupportedReasons: { inject: 'test harness has no inject channel' },
    };
    const deliverer = new MessageDeliverer(makeDeps({ surfaceFor: () => noInject }));
    pushEvent(SESSION_ID, 'UserPromptSubmit');

    const result = await send(deliverer, {});
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as Extract<SendResult, { ok: false }>).error).toContain('no inject channel');
    expect(deliverer.listVisible(SESSION_ID)).toHaveLength(0);
  });

  it('auto 闲 + 面无 headless 通道 → 409', async () => {
    const noHeadless: MessagingSurface = {
      harness: 'claude',
      discovery: true,
      prompt: null,
      inject: { rideEvents: ['UserPromptSubmit'] },
      headless: null,
      idleSignals: ['Stop'],
      unsupportedReasons: { headless: 'test harness has no headless channel' },
    };
    const deliverer = new MessageDeliverer(makeDeps({ surfaceFor: () => noHeadless }));
    pushEvent(SESSION_ID, 'Stop');

    const result = await send(deliverer, {});
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as Extract<SendResult, { ok: false }>).error).toContain('no headless channel');
  });

  it('无项目 → 400（各通道都需要项目）', async () => {
    sessions.touch('sess-orphan', null);
    pushEvent('sess-orphan', 'UserPromptSubmit');
    const deliverer = new MessageDeliverer(makeDeps());
    const result = await send(deliverer, { toSessionId: 'sess-orphan' });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it('headless 被占 → 409；与 ResumeRunner 共享并发闸（跨域）', async () => {
    const fake = createFakeSpawn();
    const headless = new HeadlessRunner({ spawnImpl: fake.spawnImpl });
    const projects = new ProjectRepository(db);
    const dispatches = new HookDispatchRepository(db);
    const ruleId = new HookRuleRepository(db)
      .create({
        name: '规则',
        projectId: null,
        source: { kind: 'claude-event', event: 'PostToolUse' },
        handler: { type: 'manual', template: 'x' },
      })
      .id;
    const dispatch = dispatches.insert({
      ruleId,
      sessionId: SESSION_ID,
      prompt: 'dispatch prompt',
      status: 'pending',
      mode: 'manual',
    });
    const resumeRunner = new ResumeRunner({
      dispatches,
      sessions,
      projects,
      bus,
      claudeBin: 'fake-claude',
      headless,
    });
    const deliverer = new MessageDeliverer(makeDeps({ headless }));
    pushEvent(SESSION_ID, 'Stop'); // 闲 → 双方都走 headless

    expect(await resumeRunner.run(dispatch.id, SESSION_ID)).toMatchObject({ ok: true });
    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'hello',
      mode: 'headless',
      fromKind: 'dashboard',
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(fake.calls).toHaveLength(1); // 只有 dispatch 的 spawn

    // dispatch 退出 → 闸开，消息可投
    fake.children[0]!.emit('exit', 0, null);
    const retry = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'hello',
      mode: 'headless',
      fromKind: 'dashboard',
    });
    expect(retry).toMatchObject({ ok: true, status: 'running' });
    expect(fake.calls).toHaveLength(2);
  });

  it('信封覆写：面 renderEnvelope 生效', async () => {
    const custom: MessagingSurface = {
      harness: 'claude',
      discovery: true,
      prompt: null,
      inject: { rideEvents: ['UserPromptSubmit'] },
      headless: null,
      idleSignals: ['Stop'],
      renderEnvelope: (text, meta) => `«${meta.fromLabel}|${meta.mode}» ${text}`,
    };
    const deliverer = new MessageDeliverer(makeDeps({ surfaceFor: () => custom }));
    pushEvent(SESSION_ID, 'UserPromptSubmit');

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'payload',
      mode: 'inject',
      fromKind: 'session',
      fromSessionId: 'sess-from',
    });
    expect(result).toMatchObject({ ok: true, status: 'injected' });
    const lines = readFileSync(join(hooksDir, 'outbox', `${hookShardId(TOKEN)}.jsonl`), 'utf8');
    expect(lines).toContain('«session sess-from|inject» payload');
  });

  it('headless 非 0 退出 → failed（error 含 stderr 尾部）', async () => {
    const fake = createFakeSpawn();
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, bin: 'fake-claude' }),
    );
    pushEvent(SESSION_ID, 'Stop');
    const result = await send(deliverer, { mode: 'headless' });

    fake.children[0]!.stderr.emit('data', Buffer.from('boom'));
    fake.children[0]!.emit('exit', 3, null);

    const msg = deliverer.getMessage((result as { messageId: string }).messageId)!;
    expect(msg.status).toBe('failed');
    expect(msg.error).toContain('exit 3');
    expect(msg.error).toContain('boom');
  });

  it('headless 超时 → timeout + kill', async () => {
    const fake = createFakeSpawn();
    const killImpl = vi.fn();
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, bin: 'fake-claude', timeoutMs: 30, killImpl }),
    );
    pushEvent(SESSION_ID, 'Stop');
    const result = await send(deliverer, { mode: 'headless' });

    await vi.waitFor(
      () => expect(deliverer.getMessage((result as { messageId: string }).messageId)!.status).toBe('timeout'),
      { timeout: 2000, interval: 10 },
    );
    expect(killImpl).toHaveBeenCalledWith(7777);
  });

  // ---- prompt 通道（消息域重塑）：层① 中继 / 层② 终端兜底 / 层③ 队列 ----

  it('prompt 层①：中继 spawn——固定参数 + stdin 指令（含 peer 名与原文）；退出 0 = delivered', async () => {
    const fake = createFakeSpawn();
    const { surface } = relaySurface();
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    pushEvent(SESSION_ID, 'Stop');

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'go check the build',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true, // 手动面：单向注入
    });
    expect(result).toMatchObject({ ok: true, status: 'delivering' });
    expect(fake.calls).toHaveLength(1);
    const onWin = process.platform === 'win32';
    expect(fake.calls[0]!.cmd).toBe(
      onWin ? 'fake-relay -p --no-session-persistence' : 'fake-relay',
    );
    expect(fake.calls[0]!.args).toEqual(onWin ? [] : ['-p', '--no-session-persistence']);
    // 中性 cwd（防项目 hooks 幽灵事件），不是项目路径
    expect(fake.calls[0]!.options.cwd).not.toBe(PROJECT_PATH);
    const stdinText = fake.children[0]!.stdin.writes[0]!;
    // 指令全文由 harness 规格给出（server 只传 peer 名 + 原文 + oneWay，逐字透传）
    expect(stdinText).toBe(`Send to "${PEER_NAME}" [one-way]: go check the build`);
    // 队列不落行（层① 命中即时投递）
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);

    fake.children[0]!.emit('exit', 0, null);
    const msg = deliverer.getMessage((result as { messageId: string }).messageId)!;
    expect(msg.status).toBe('delivered');
    expect(busEvents).toContainEqual(
      expect.objectContaining({ kind: 'message.delivered', messageId: msg.id }),
    );
    // delivered 短时驻留在途视图（60s 窗口内展示 via/acked；过后消失）
    expect(deliverer.listVisible(SESSION_ID).map((m) => m.id)).toContain(msg.id);
  });

  it('prompt 层①：编排域发送（非 oneWay）不带单向标记——双向对话保留', async () => {
    const fake = createFakeSpawn();
    const { surface } = relaySurface();
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    pushEvent(SESSION_ID, 'Stop');

    await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'step 1 text',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(fake.children[0]!.stdin.writes[0]).toBe(`Send to "${PEER_NAME}": step 1 text`);
  });

  it('在途计数（会话行角标）：队列 pending ∪ 内存 delivering 计入，delivered 归零', async () => {
    const fake = createFakeSpawn();
    let registered = false;
    const { surface } = relaySurface((sessionId) =>
      registered ? { name: PEER_NAME } : null,
    );
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    pushEvent(SESSION_ID, 'Stop');

    // 会话没开 → 队列 pending
    await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'queued',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    expect([...deliverer.listInflightCounts()]).toEqual([[SESSION_ID, 1]]);

    // 登记出现 → 冲洗转中继（delivering 在内存，仍在途计数为 1）
    registered = true;
    await deliverer.flushSession(SESSION_ID);
    expect([...deliverer.listInflightCounts()]).toEqual([[SESSION_ID, 1]]);

    // 中继退出 0 → delivered（终态）→ 计数归零
    fake.children[0]!.emit('exit', 0, null);
    expect(deliverer.listInflightCounts().size).toBe(0);
  });

  it('冲洗：层② 终端一条一条发，回执到了才发下一条（同框叠字会并成一条提交）', async () => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    const sent: string[] = [];
    const sendText = vi.fn().mockImplementation(async (paneId: string, text: string) => {
      sent.push(`${paneId}:${text}`);
    });
    const noNative: MessagingSurface = {
      harness: 'codex',
      discovery: true,
      prompt: null,
      queuedPrompt: null,
      inject: null,
      headless: null,
      idleSignals: [],
    };
    // 走层② 终端通道（没有同会话中继闸，唯一可能连发突发的路径）
    let panes: Array<{ id: string; title: string; cwd: string }> = [];
    const deliverer = new MessageDeliverer(
      makeDeps({
        surfaceFor: () => noNative,
        flushGapMs: 0,
        terminal: {
          available: () => true,
          listPanes: async () => panes,
          sendText,
          sendKeys: vi.fn(),
          closePane: vi.fn(),
        },
      }),
    );
    pushEvent(SESSION_ID, 'Stop', 'codex');
    // pane 还没出现：7 条全部积压入队
    for (let i = 1; i <= 7; i++) {
      await deliverer.send({
        toSessionId: SESSION_ID,
        text: `m${i}`,
        mode: 'prompt',
        fromKind: 'dashboard',
        oneWay: true,
      });
    }
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(7);

    panes = [{ id: 'p1', title: 'msg-target', cwd: PROJECT_PATH }];
    await deliverer.flushSession(SESSION_ID);
    // 层② 一轮只发一条：贴进输入框的那条要等回执（再贴一份会在同框叠成一段）
    expect(sent).toEqual(['p1:m1']);
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(6);

    await deliverer.flushSession(SESSION_ID); // 没回执：再冲也不动
    expect(sent).toEqual(['p1:m1']);

    deliverer.onSessionPrompt(SESSION_ID, 'm1'); // 回执到 → 撤防
    await deliverer.flushSession(SESSION_ID);
    expect(sent).toEqual(['p1:m1', 'p1:m2']);
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(5);
  });

  it('中继作为子进程启动（非 detached）——三平台同一语义，并随 daemon 退出被回收', async () => {
    const fake = createFakeSpawn();
    const killImpl = vi.fn();
    const runner = new HeadlessRunner({ spawnImpl: fake.spawnImpl, killImpl });
    const { surface } = relaySurface();
    const deliverer = new MessageDeliverer(
      makeDeps({ headless: runner, spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    pushEvent(SESSION_ID, 'Stop');

    await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'child please',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    // win32（shell 模式恒 false）与 POSIX（中继显式 false）都不自成进程组
    expect(fake.calls[0]!.options.detached).toBe(false);
    expect(fake.children[0]!.pid).toBe(7777);

    // daemon 退出：在飞中继随它一起收
    expect(runner.killAll()).toBe(1);
    expect(killImpl).toHaveBeenCalledWith(7777);
    // 已回收：再调不重复杀
    expect(runner.killAll()).toBe(0);
  });

  it('message.created 在在途状态建立之后才广播——角标推送重算不落后一拍', async () => {
    const fake = createFakeSpawn();
    const { surface } = relaySurface(() => null); // 会话没开 → 入队（pending）
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    // 在 created 帧到达的那一刻取计数（角标推送就是这么算的）
    const atCreated: number[] = [];
    bus.subscribe((m) => {
      if (m.kind === 'message.created') {
        atCreated.push(deliverer.listInflightCounts().get(SESSION_ID) ?? 0);
      }
    });
    pushEvent(SESSION_ID, 'Stop');

    await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'queued for badge',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    expect(atCreated).toEqual([1]);
  });

  it('prompt 层③：oneWay 随队列行落盘——换投递器（daemon 重启）后冲洗仍带单向标记', async () => {
    const fake = createFakeSpawn();
    const { surface } = relaySurface(() => null); // 会话没开 → 入队
    const first = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    pushEvent(SESSION_ID, 'Stop');
    await first.send({
      toSessionId: SESSION_ID,
      text: 'queued manual',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    expect(readPromptbox(hooksDir, TOKEN)[0]).toMatchObject({ oneWay: true });

    // 全重启：新投递器（内存注册表空）+ peer 已登记 → 冲洗走中继
    const open = relaySurface();
    const second = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => open.surface, bin: 'fake-relay' }),
    );
    await second.flushSession(SESSION_ID);
    expect(fake.children[0]!.stdin.writes[0]).toContain('[one-way]');
  });

  it('自续冲洗：一轮到量后自动继续，排空积压（不必等下一次事件）', async () => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    const sent: string[] = [];
    const noNative: MessagingSurface = {
      harness: 'codex',
      discovery: true,
      prompt: null,
      queuedPrompt: null,
      promptInbox: null,
      inject: null,
      headless: null,
      idleSignals: [],
    };
    let panes: Array<{ id: string; title: string; cwd: string }> = [];
    const deliverer = new MessageDeliverer(
      makeDeps({
        surfaceFor: () => noNative,
        flushGapMs: 0,
        terminal: {
          available: () => true,
          listPanes: async () => panes,
          sendText: async (_paneId, text) => {
            sent.push(text);
          },
          sendKeys: vi.fn(),
          closePane: vi.fn(),
        },
      }),
    );
    pushEvent(SESSION_ID, 'Stop', 'codex');
    for (let i = 1; i <= 7; i++) {
      await deliverer.send({
        toSessionId: SESSION_ID,
        text: `auto${i}`,
        mode: 'prompt',
        fromKind: 'dashboard',
        oneWay: true,
      });
    }
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(7);

    panes = [{ id: 'p1', title: 'msg-target', cwd: PROJECT_PATH }];
    await deliverer.flushSession(SESSION_ID); // 第一条进终端
    expect(sent).toEqual(['auto1']);
    // 回执逐条到 → 自续（不必再手动 flush）把剩下 6 条一条条发完
    for (let i = 1; i <= 7; i++) {
      deliverer.onSessionPrompt(SESSION_ID, `auto${i}`);
      await vi.waitFor(() => expect(sent).toHaveLength(Math.min(i + 1, 7)));
    }
    await vi.waitFor(() => expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0));
    expect(sent).toHaveLength(7);
  });

  it('层①-a inbox 直投：oneWay + 已登记目标 → 走 socket（不起中继进程）', async () => {
    const path = uniqueInboxPath();
    let got = '';
    const inbox = await fakeInboxAt(path, (t) => {
      got = t;
    });
    const fake = createFakeSpawn();
    const { surface } = relaySurface();
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    pushEvent(SESSION_ID, 'Stop');
    deliverer.noteInboxSocket(SESSION_ID, { socket: path, token: 'tok-1' });

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'socket 直投正文',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    expect(result).toMatchObject({ ok: true, status: 'delivered' });
    expect(fake.calls).toHaveLength(0); // 没有起中继进程
    await new Promise((r) => setTimeout(r, 50));
    // 载荷就是正文本体：不再加来源前缀
    expect(got).toContain('socket 直投正文');
    expect(got).not.toContain('[weave] ');
    expect(got).toContain('"type":"auth"');
    expect(deliverer.getMessage((result as { messageId: string }).messageId)).toMatchObject({
      status: 'delivered',
      via: 'socket',
    });
    inbox.close();
  });

  it('层①-q 宿主队列（codex）：spawn 面给的命令，exit 0 = delivered + 布防回执闸', async () => {
    const fake = createFakeSpawn();
    const queueCalls: Array<{ bin: string; args: readonly string[] }> = [];
    const surface: MessagingSurface = {
      harness: 'codex',
      discovery: false,
      prompt: null,
      promptInbox: null,
      queuedPrompt: {
        command(sessionId, text) {
          const call = { bin: 'fake-codex', args: ['queue', '--thread', sessionId, '--message', text] };
          queueCalls.push(call);
          return call;
        },
      },
      inject: null,
      headless: null,
      idleSignals: [],
    };
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface }),
    );
    pushEvent(CODEX_SESSION, 'Stop', 'codex');

    const sending = deliverer.send({
      toSessionId: CODEX_SESSION,
      text: 'queue 正文',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    fake.children[0]!.emit('exit', 0, null);
    const result = await sending;
    expect(result).toMatchObject({ ok: true, status: 'delivered' });
    expect(queueCalls).toEqual([
      { bin: 'fake-codex', args: ['queue', '--thread', CODEX_SESSION, '--message', 'queue 正文'] },
    ]);
    // 正文进 argv、不经 shell 拼串
    expect(fake.calls[0]!.options.shell).toBeFalsy();
    expect(deliverer.getMessage((result as { messageId: string }).messageId)).toMatchObject({
      status: 'delivered',
      via: 'queue',
    });
    // 手动面（oneWay）也走它：宿主眼里队列投递就是用户输入
    expect(busEvents.some((m) => m.kind === 'message.delivered')).toBe(true);
  });

  it('层①-q 失败即回落：exit 非 0 → 不留痕，照旧走下一层（入队）', async () => {
    const fake = createFakeSpawn();
    const surface: MessagingSurface = {
      harness: 'codex',
      discovery: false,
      prompt: null,
      promptInbox: null,
      queuedPrompt: {
        command: (sessionId, text) => ({ bin: 'fake-codex', args: ['queue', '--thread', sessionId, '--message', text] }),
      },
      inject: null,
      headless: null,
      idleSignals: [],
    };
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface }),
    );
    pushEvent(CODEX_SESSION, 'Stop', 'codex');

    const sending = deliverer.send({
      toSessionId: CODEX_SESSION,
      text: 'queue 失败',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    fake.children[0]!.emit('exit', 1, null);
    const result = await sending;
    // 队列拒绝（exit 1）→ 回落：三层全无通路 → 入队等下一次事件
    expect(result).toMatchObject({ ok: true, status: 'pending' });
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(1);
    expect(deliverer.getMessage((result as { messageId: string }).messageId)).toBeNull();
  });

  it('层①-q 带图不走：CLI 硬拒 --images，带图消息直接落下一层', async () => {
    const fake = createFakeSpawn();
    const surface: MessagingSurface = {
      harness: 'codex',
      discovery: false,
      prompt: null,
      promptInbox: null,
      queuedPrompt: {
        command: (sessionId, text) => ({ bin: 'fake-codex', args: ['queue', '--thread', sessionId, '--message', text] }),
      },
      inject: null,
      headless: null,
      idleSignals: [],
      attach: {
        kinds: ['image', 'file'],
        composePrompt: (text, files) => `${text}\n\n${files.map((i) => i.path).join('\n')}`,
      },
    };
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface }),
    );
    pushEvent(CODEX_SESSION, 'Stop', 'codex');

    const result = await deliverer.send({
      toSessionId: CODEX_SESSION,
      text: '带图',
      mode: 'prompt',
      fromKind: 'dashboard',
      attachments: [{ id: 'img-1', name: 'a.png', mediaType: 'image/png', path: '/uploads/a.png' }],
    });
    expect(fake.calls).toHaveLength(0); // 队列没起进程
    expect(result).toMatchObject({ ok: true, status: 'pending' });
  });

  it('awaitInboxReady：无凭据到点 false，凭据在手 true，机制缺席立刻 false', async () => {
    const { surface } = relaySurface();
    const deliverer = new MessageDeliverer(makeDeps({ surfaceFor: () => surface }));
    pushEvent(SESSION_ID, 'Stop');
    await expect(deliverer.awaitInboxReady(SESSION_ID, 0)).resolves.toBe(false);

    deliverer.noteInboxSocket(SESSION_ID, { socket: uniqueInboxPath(), token: 'tok' });
    await expect(deliverer.awaitInboxReady(SESSION_ID, 1_000)).resolves.toBe(true);

    const noInbox = new MessageDeliverer(
      makeDeps({ surfaceFor: () => ({ ...surface, promptInbox: null }) }),
    );
    noInbox.noteInboxSocket(SESSION_ID, { socket: uniqueInboxPath(), token: 'tok' });
    await expect(noInbox.awaitInboxReady(SESSION_ID, 1_000)).resolves.toBe(false);
  });

  it('awaitInboxReady：等的那会儿凭据才上报（刚拉起的会话）→ 放行', async () => {
    const { surface } = relaySurface();
    const deliverer = new MessageDeliverer(makeDeps({ surfaceFor: () => surface }));
    pushEvent(SESSION_ID, 'Stop');
    const waiting = deliverer.awaitInboxReady(SESSION_ID, 3_000);
    setTimeout(() => {
      deliverer.noteInboxSocket(SESSION_ID, { socket: uniqueInboxPath(), token: 'tok' });
    }, 20);
    await expect(waiting).resolves.toBe(true);
  });

  it('lastTurnOutput：取最近一轮的最终输出，跳过空回合与坏 payload', () => {
    const deliverer = new MessageDeliverer(makeDeps());
    expect(deliverer.lastTurnOutput(SESSION_ID)).toBeNull();

    const withOutput = (text: string) =>
      events.insert({
        projectId,
        source: 'claude',
        eventType: 'Stop',
        sessionId: SESSION_ID,
        payload: JSON.stringify({ raw: { last_assistant_message: text } }),
      });
    withOutput('第一轮结论');
    withOutput('');
    events.insert({
      projectId,
      source: 'claude',
      eventType: 'UserPromptSubmit',
      sessionId: SESSION_ID,
      payload: 'not json',
    });

    expect(deliverer.lastTurnOutput(SESSION_ID)).toMatchObject({ output: '第一轮结论' });
    expect(deliverer.lastTurnOutput(CODEX_SESSION)).toBeNull();
  });

  it('层①-a 凭据落盘：daemon 重启（新投递器，内存空）后仍直投，不回落中继/终端', async () => {
    const path = uniqueInboxPath();
    let got = '';
    const inbox = await fakeInboxAt(path, (t) => {
      got = t;
    });
    const fake = createFakeSpawn();
    const { surface } = relaySurface();
    const first = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    pushEvent(SESSION_ID, 'Stop');
    first.noteInboxSocket(SESSION_ID, { socket: path, token: 'tok-restart' });

    // 重启：新投递器只从盘上捡凭据（凭据活在会话进程里，没跟着 daemon 一起没）
    const second = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    const result = await second.send({
      toSessionId: SESSION_ID,
      text: '重启后直投',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    expect(result).toMatchObject({ ok: true, status: 'delivered' });
    expect(fake.calls).toHaveLength(0); // 没有起中继进程
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toContain('重启后直投');
    inbox.close();
  });

  it('层①-a 失败即回落中继：目标地址不存在 → 仍投出去（走中继）', async () => {
    const fake = createFakeSpawn();
    const { surface } = relaySurface();
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    pushEvent(SESSION_ID, 'Stop');
    deliverer.noteInboxSocket(SESSION_ID, { socket: uniqueInboxPath(), token: 'tok' });

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'fallback 正文',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    expect(result).toMatchObject({ ok: true, status: 'delivering' });
    expect(fake.calls).toHaveLength(1); // 回落：起了中继
    expect(deliverer.getMessage((result as { messageId: string }).messageId)).toMatchObject({
      via: 'relay',
    });
  });

  it('层①-a 无凭据时手动面先走终端：中继退到最后（跨会话外壳不是手动面要的东西）', async () => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    const fake = createFakeSpawn();
    const sendText = vi.fn().mockResolvedValue(undefined);
    const { surface } = relaySurface(); // peer 已登记：中继此刻可用
    const deliverer = new MessageDeliverer(
      makeDeps({
        spawnImpl: fake.spawnImpl,
        surfaceFor: () => surface,
        bin: 'fake-relay',
        terminal: {
          available: () => true,
          listPanes: async () => [{ id: 'pane-1', title: 'msg-target', cwd: PROJECT_PATH }],
          sendText,
          sendKeys: vi.fn(),
          closePane: vi.fn(),
        },
      }),
    );
    pushEvent(SESSION_ID, 'Stop');

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'manual plain',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    expect(result).toMatchObject({ ok: true, status: 'delivering' });
    expect(sendText).toHaveBeenCalledWith('pane-1', 'manual plain');
    expect(fake.calls).toHaveLength(0); // 没起中继子进程
    expect(deliverer.getMessage((result as { messageId: string }).messageId)).toMatchObject({
      via: 'terminal',
    });
  });

  it('强制终端：直投与中继都跳过——发送人要的是宿主认作「用户输入」的那条路', async () => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    const path = uniqueInboxPath();
    let got = '';
    const inbox = await fakeInboxAt(path, (t) => {
      got = t;
    });
    const fake = createFakeSpawn();
    const sendText = vi.fn().mockResolvedValue(undefined);
    const { surface } = relaySurface();
    const deliverer = new MessageDeliverer(
      makeDeps({
        spawnImpl: fake.spawnImpl,
        surfaceFor: () => surface,
        bin: 'fake-relay',
        terminal: {
          available: () => true,
          listPanes: async () => [{ id: 'pane-1', title: 'msg-target', cwd: PROJECT_PATH }],
          sendText,
          sendKeys: vi.fn(),
          closePane: vi.fn(),
        },
      }),
    );
    pushEvent(SESSION_ID, 'Stop');
    deliverer.noteInboxSocket(SESSION_ID, { socket: path, token: 'tok-forced' });

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'forced terminal',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
      forceTerminal: true,
    });
    expect(result).toMatchObject({ ok: true, status: 'delivering' });
    expect(sendText).toHaveBeenCalledWith('pane-1', 'forced terminal');
    expect(fake.calls).toHaveLength(0); // 中继一个都不起（哪怕 peer 已登记）
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toBe(''); // 直投也没伸过手（凭据在手）
    expect(deliverer.getMessage((result as { messageId: string }).messageId)).toMatchObject({
      via: 'terminal',
    });
    inbox.close();
  });

  it('斜杠命令：内建命令过了短窗口按已回执收（不发 UPS），skill 命令仍由 UPS 即时认领', async () => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliverer = new MessageDeliverer(
      makeDeps({
        commandAckGraceMs: 20,
        terminal: {
          available: () => true,
          listPanes: async () => [{ id: 'pane-1', title: 'msg-target', cwd: PROJECT_PATH }],
          sendText,
          sendKeys: vi.fn(),
          closePane: vi.fn(),
        },
      }),
    );
    pushEvent(SESSION_ID, 'Stop');

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '/compact',
      mode: 'prompt',
      fromKind: 'dashboard',
      forceTerminal: true,
    });
    const id = (result as { messageId: string }).messageId;
    expect(sendText).toHaveBeenCalledWith('pane-1', '/compact');
    // 窗口内先不 ack：skill/插件命令会在这几秒里报一条 UPS，要留出认领的机会
    expect(deliverer.getMessage(id)?.acked).not.toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    // 内建命令：窗口过期即按已送达收，且不布防未回执闸
    expect(deliverer.getMessage(id)).toMatchObject({ via: 'terminal', status: 'delivered', acked: true });
    expect(deliverer.getMessage(id)?.stalled).not.toBe(true);

    // 对照：skill 命令的 UPS（正文就是用户敲的那行）到了就即时核销，不等窗口
    const skill = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '/playwright-cli https://localhost:5173/',
      mode: 'prompt',
      fromKind: 'dashboard',
      forceTerminal: true,
    });
    const skillId = (skill as { messageId: string }).messageId;
    deliverer.onSessionPrompt(SESSION_ID, '/playwright-cli https://localhost:5173/');
    expect(deliverer.getMessage(skillId)).toMatchObject({ status: 'delivered', acked: true });

    // 普通文本仍走「等 UPS 回执」的老路
    const plain = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'plain text',
      mode: 'prompt',
      fromKind: 'dashboard',
      forceTerminal: true,
    });
    await new Promise((r) => setTimeout(r, 50));
    const plainId = (plain as { messageId: string }).messageId;
    expect(deliverer.getMessage(plainId)).toMatchObject({ status: 'delivered' });
    expect(deliverer.getMessage(plainId)?.acked).not.toBe(true);
    deliverer.onSessionPrompt(SESSION_ID, 'plain text');
    expect(deliverer.getMessage(plainId)).toMatchObject({ acked: true });
  });

  it('bash 模式也算命令形态（触发符 `!` 归能力面）：宿主本地执行不发 UPS，过短窗口按已执行收、不置暂停闸', async () => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliverer = new MessageDeliverer(
      makeDeps({
        commandAckGraceMs: 20,
        terminal: {
          available: () => true,
          listPanes: async () => [{ id: 'pane-1', title: 'msg-target', cwd: PROJECT_PATH }],
          sendText,
          sendKeys: vi.fn(),
          closePane: vi.fn(),
        },
      }),
    );
    pushEvent(SESSION_ID, 'Stop');

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '!weave-dev init',
      mode: 'prompt',
      fromKind: 'dashboard',
      forceTerminal: true,
    });
    const id = (result as { messageId: string }).messageId;
    expect(sendText).toHaveBeenCalledWith('pane-1', '!weave-dev init');
    await new Promise((r) => setTimeout(r, 60));
    // bash 模式压根不发 UserPromptSubmit：窗口过期即按已执行收，也不该挂「未回执」闸
    expect(deliverer.getMessage(id)).toMatchObject({ via: 'terminal', status: 'delivered', acked: true });
    expect(deliverer.getMessage(id)?.stalled).not.toBe(true);
  });

  it('活动旁证：内建命令行靠宿主后续事件及时翻牌（不等 5s 短窗口），普通文本行不掺和', async () => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliverer = new MessageDeliverer(
      makeDeps({
        commandAckGraceMs: 60_000, // 短窗口故意拉长：翻牌只能来自 noteActivity
        terminal: {
          available: () => true,
          listPanes: async () => [{ id: 'pane-1', title: 'msg-target', cwd: PROJECT_PATH }],
          sendText,
          sendKeys: vi.fn(),
          closePane: vi.fn(),
        },
      }),
    );
    pushEvent(SESSION_ID, 'Stop');

    const cmd = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '/compact',
      mode: 'prompt',
      fromKind: 'dashboard',
      forceTerminal: true,
    });
    const cmdId = (cmd as { messageId: string }).messageId;
    expect(deliverer.getMessage(cmdId)).toMatchObject({ status: 'delivered' });
    expect(deliverer.getMessage(cmdId)?.acked).not.toBe(true);

    // 宿主受理命令后的第一笔事件（PreCompact）= 活动旁证：命令行即时翻牌 + 帧
    deliverer.noteActivity(SESSION_ID);
    expect(deliverer.getMessage(cmdId)).toMatchObject({ status: 'delivered', acked: true });
    expect(busEvents.filter((m) => m.kind === 'message.acknowledged' && m.messageId === cmdId)).toHaveLength(1);

    // 普通文本行没有 UPS 就不翻牌（「发了没进」要靠未回执闸说话）
    const plain = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'plain text body',
      mode: 'prompt',
      fromKind: 'dashboard',
      forceTerminal: true,
    });
    const plainId = (plain as { messageId: string }).messageId;
    deliverer.noteActivity(SESSION_ID);
    expect(deliverer.getMessage(plainId)).toMatchObject({ status: 'delivered' });
    expect(deliverer.getMessage(plainId)?.acked).not.toBe(true);
  });

  it('已执行的斜杠命令常驻在途视图（TTL 豁免）——/rewind 类没有认领事件，TTL 一到就消失无从查起', async () => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliverer = new MessageDeliverer(
      makeDeps({
        commandAckGraceMs: 20,
        visibleTtlMs: 80,
        terminal: {
          available: () => true,
          listPanes: async () => [{ id: 'pane-1', title: 'msg-target', cwd: PROJECT_PATH }],
          sendText,
          sendKeys: vi.fn(),
          closePane: vi.fn(),
        },
      }),
    );
    pushEvent(SESSION_ID, 'Stop');

    const cmd = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '/rewind',
      mode: 'prompt',
      fromKind: 'dashboard',
      forceTerminal: true,
    });
    const cmdId = (cmd as { messageId: string }).messageId;
    await new Promise((r) => setTimeout(r, 60)); // 短窗口过期 → 翻牌 acked
    expect(deliverer.getMessage(cmdId)).toMatchObject({ status: 'delivered', acked: true });

    const plain = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'plain body',
      mode: 'prompt',
      fromKind: 'dashboard',
      forceTerminal: true,
    });
    const plainId = (plain as { messageId: string }).messageId;

    await new Promise((r) => setTimeout(r, 160)); // 双双越过 TTL
    const visible = deliverer.listVisible(SESSION_ID).map((m) => m.id);
    // 命令行常驻；普通文本行（未回执）也跨窗留着，但那是「在飞」语义，不是豁免
    expect(visible).toContain(cmdId);
    deliverer.onSessionPrompt(SESSION_ID, 'plain body');
    // 普通行回执一到即退场（TTL 早过了）；命令行还在
    expect(deliverer.listVisible(SESSION_ID).map((m) => m.id)).not.toContain(plainId);
    expect(deliverer.listVisible(SESSION_ID).map((m) => m.id)).toContain(cmdId);
  });

  it('强制终端随队列行落盘：pane 不在时入队，冲洗仍只打终端（不回落直投/中继）', async () => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    const path = uniqueInboxPath();
    let got = '';
    const inbox = await fakeInboxAt(path, (t) => {
      got = t;
    });
    const fake = createFakeSpawn();
    const sendText = vi.fn().mockResolvedValue(undefined);
    let paneReady = false;
    const { surface } = relaySurface();
    const deliverer = new MessageDeliverer(
      makeDeps({
        spawnImpl: fake.spawnImpl,
        surfaceFor: () => surface,
        bin: 'fake-relay',
        terminal: {
          available: () => true,
          listPanes: async () =>
            paneReady ? [{ id: 'pane-1', title: 'msg-target', cwd: PROJECT_PATH }] : [],
          sendText,
          sendKeys: vi.fn(),
          closePane: vi.fn(),
        },
      }),
    );
    pushEvent(SESSION_ID, 'Stop');
    deliverer.noteInboxSocket(SESSION_ID, { socket: path, token: 'tok-forced-q' });

    const queued = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'forced queued',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
      forceTerminal: true,
    });
    expect(queued).toMatchObject({ ok: true, status: 'pending' });
    expect(readPromptbox(hooksDir, TOKEN)).toContainEqual(expect.objectContaining({ forceTerminal: true }));

    paneReady = true;
    await deliverer.flushSession(SESSION_ID);
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledWith('pane-1', 'forced queued'));
    expect(fake.calls).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toBe('');
    inbox.close();
  });

  it('重发「已贴进框、没回执」的终端投递只补回车——重贴会把正文与图在框里叠一份', async () => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    const fake = createFakeSpawn();
    const sendText = vi.fn().mockResolvedValue(undefined);
    const sendKeys = vi.fn().mockResolvedValue(undefined);
    const { surface } = relaySurface();
    const deliverer = new MessageDeliverer(
      makeDeps({
        spawnImpl: fake.spawnImpl,
        surfaceFor: () => surface,
        bin: 'fake-relay',
        terminal: {
          available: () => true,
          listPanes: async () => [{ id: 'pane-1', title: 'msg-target', cwd: PROJECT_PATH }],
          sendText,
          sendKeys,
          closePane: vi.fn(),
        },
      }),
    );
    pushEvent(SESSION_ID, 'Stop');

    const sent = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'no ack after paste',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    const id = (sent as { messageId: string }).messageId;
    await vi.waitFor(() => expect(deliverer.getMessage(id)).toMatchObject({ status: 'delivered' }));

    await expect(deliverer.resend(id)).resolves.toMatchObject({ ok: true, status: 'delivering' });
    await vi.waitFor(() => expect(sendKeys).toHaveBeenCalledWith('pane-1', '\r'));
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('层序随面变：编排域（非 oneWay）无 inbox 凭据时，中继先于终端', async () => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    const fake = createFakeSpawn();
    const sendText = vi.fn().mockResolvedValue(undefined);
    const { surface } = relaySurface();
    const deliverer = new MessageDeliverer(
      makeDeps({
        spawnImpl: fake.spawnImpl,
        surfaceFor: () => surface,
        bin: 'fake-relay',
        terminal: {
          available: () => true,
          listPanes: async () => [{ id: 'pane-1', title: 'msg-target', cwd: PROJECT_PATH }],
          sendText,
          sendKeys: vi.fn(),
          closePane: vi.fn(),
        },
      }),
    );
    pushEvent(SESSION_ID, 'Stop');

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'orchestration',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(result).toMatchObject({ ok: true, status: 'delivering' });
    expect(fake.calls).toHaveLength(1);
    expect(sendText).not.toHaveBeenCalled();
    expect(deliverer.getMessage((result as { messageId: string }).messageId)).toMatchObject({
      via: 'relay',
    });
  });

  it('层①-a 队列冲洗优先直投：凭据在手时手动面行走 socket，不落中继也不打终端', async () => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    let registered = false;
    const path = uniqueInboxPath();
    let got = '';
    const inbox = await fakeInboxAt(path, (t) => {
      got = t;
    });
    const fake = createFakeSpawn();
    const sendText = vi.fn().mockResolvedValue(undefined);
    let panes: Array<{ id: string; title: string; cwd: string }> = [];
    const { surface } = relaySurface(() => (registered ? { name: PEER_NAME } : null));
    const deliverer = new MessageDeliverer(
      makeDeps({
        spawnImpl: fake.spawnImpl,
        flushGapMs: 0,
        surfaceFor: () => surface,
        bin: 'fake-relay',
        terminal: {
          available: () => true,
          listPanes: async () => panes,
          sendText,
          sendKeys: vi.fn(),
          closePane: vi.fn(),
        },
      }),
    );
    pushEvent(SESSION_ID, 'Stop');

    // 发的那一刻：无凭据 + pane 没出现 + peer 未登记 → 入队
    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'queued one-way',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    expect(result).toMatchObject({ status: 'pending' });
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(1);

    // 冲洗那一刻三条路都可用（凭据正是刚上报的）：直投必须是第一顺位
    deliverer.noteInboxSocket(SESSION_ID, { socket: path, token: 'tok-1' });
    registered = true;
    panes = [{ id: 'pane-1', title: 'msg-target', cwd: PROJECT_PATH }];
    await deliverer.flushSession(SESSION_ID);
    await vi.waitFor(() => expect(got).toContain('queued one-way'));
    expect(sendText).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
    expect(deliverer.getMessage((result as { messageId: string }).messageId)).toMatchObject({
      status: 'delivered',
      via: 'socket',
    });
    inbox.close();
  });

  it('编排域（非 oneWay）有 inbox 目标即直投——层①-a 排在中继之前', async () => {
    const path = uniqueInboxPath();
    let got = '';
    const inbox = await fakeInboxAt(path, (t) => {
      got = t;
    });
    const fake = createFakeSpawn();
    const { surface } = relaySurface();
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    pushEvent(SESSION_ID, 'Stop');
    deliverer.noteInboxSocket(SESSION_ID, { socket: path, token: 'tok' });

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'orchestration step',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(fake.calls).toHaveLength(0);
    expect(deliverer.getMessage((result as { messageId: string }).messageId)).toMatchObject({
      status: 'delivered',
      via: 'socket',
    });
    await vi.waitFor(() => expect(got).toContain('orchestration step'));
    inbox.close();
  });

  it('投递回执：会话 UPS 原文（带 Claude Code 外壳）命中在途条目 → acked + 帧', async () => {
    const fake = createFakeSpawn();
    const { surface } = relaySurface();
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    pushEvent(SESSION_ID, 'Stop');
    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '回执比对正文（够长）',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    const id = (result as { messageId: string }).messageId;
    expect(deliverer.getMessage(id)?.acked).toBeUndefined();

    // Claude Code 把会话间消息裹在自己的外壳里；比对必须剥壳
    deliverer.onSessionPrompt(
      SESSION_ID,
      `<cross-session-message from="uds:\\\\?\\pipe\\LOCAL\\cc-msg-x">回执比对正文（够长）</cross-session-message>`,
      777,
    );
    expect(deliverer.getMessage(id)?.acked).toBe(true);
    // 命中的那条事件 id 记在行上：对话面按它把投递行挂到对应气泡（文案对不上也认得出）
    expect(deliverer.getMessage(id)?.ackedEventId).toBe(777);
    // 帧里带上命中的事件 id：前端据此把队列行退场与气泡出现放进同一拍
    expect(busEvents).toContainEqual(
      expect.objectContaining({ kind: 'message.acknowledged', messageId: id, eventId: 777 }),
    );

    // 短文本（< ACK_MIN_TEXT）认**尾部相等**：宿主在后面接的别的后文不算，尾部是本
    // 行原文才算。另起一个实例：上面那条中继还在飞，同一会话再发会直接落队列（没有
    // 内存行可比）。
    const shortDeliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: createFakeSpawn().spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    const tiny = await shortDeliverer.send({
      toSessionId: SESSION_ID,
      text: 'ok',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    const tinyId = (tiny as { messageId: string }).messageId;
    shortDeliverer.onSessionPrompt(SESSION_ID, 'ok 我这边没问题');
    expect(shortDeliverer.getMessage(tinyId)?.acked).toBeUndefined();
    // 尾部相等即回执（整条相等是它的特例）
    shortDeliverer.onSessionPrompt(SESSION_ID, 'ok');
    expect(shortDeliverer.getMessage(tinyId)?.acked).toBe(true);
  });

  it('回执比对：多行 chunk 被宿主用空串拼接（带空白比不中）→ 去空白再比一次', async () => {
    pushEvent(SESSION_ID, 'Stop');
    const { surface } = relaySurface();
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: createFakeSpawn().spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '第一行正文\n第二行正文',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    const id = (result as { messageId: string }).messageId;
    // 归一把换行折成空格 → 与宿主拼接后的原文差一个空白，包含比对落空；
    // 不补这一档这条永远等不到回执，行落 failed 而气泡已经在了（同一条显示两遍）
    deliverer.onSessionPrompt(SESSION_ID, '第一行正文第二行正文', 888);
    expect(deliverer.getMessage(id)).toMatchObject({ acked: true, ackedEventId: 888 });

    // 只沾前半句（去空白后也不够长/不包含）不许被误认领
    const other = new MessageDeliverer(
      makeDeps({ spawnImpl: createFakeSpawn().spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    const second = await other.send({
      toSessionId: SESSION_ID,
      text: '另一条完全不同的正文内容',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    const secondId = (second as { messageId: string }).messageId;
    other.onSessionPrompt(SESSION_ID, '另一条', 889);
    expect(other.getMessage(secondId)?.acked).toBeUndefined();
  });

  it('一条 UPS 核销多条在途：宿主把连着发的两次合成一次提交，不能只认第一条', async () => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliverer = new MessageDeliverer(
      makeDeps({
        terminal: {
          available: () => true,
          listPanes: async () => [{ id: 'pane-1', title: 'msg-target', cwd: PROJECT_PATH }],
          sendText,
          sendKeys: vi.fn(),
          closePane: vi.fn(),
        },
      }),
    );
    pushEvent(SESSION_ID, 'Stop');
    const first = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '第一句正文（够长）',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    const firstId = (first as { messageId: string }).messageId;
    // 会话退出清掉了等待位（进程没了回执不会再来了），但它的行还在在途视图里未回执；
    // 会话起回来再发一条 → 内存里此刻躺着两条未回执的 prompt 行
    deliverer.sessionExited(SESSION_ID);
    const second = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '第二句正文（够长）',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    const secondId = (second as { messageId: string }).messageId;
    expect(deliverer.getMessage(firstId)?.acked).toBeUndefined();
    expect(deliverer.getMessage(secondId)?.acked).toBeUndefined();

    // 宿主把两次粘贴合成一条 UPS 提交：一条回执核销两条（只核销首条的话，剩下那条
    // 会一路挂到未回执闸，把该会话的队列误暂停）
    deliverer.onSessionPrompt(SESSION_ID, '第一句正文（够长）\n第二句正文（够长）', 901);
    expect(deliverer.getMessage(firstId)?.acked).toBe(true);
    expect(deliverer.getMessage(secondId)?.acked).toBe(true);
    expect(deliverer.getMessage(secondId)?.ackedEventId).toBe(901);
  });

  it('短文本核销：框内残留垫在前面（1继续继续）也认——整条相等在这些形态面前永不命中', async () => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    const deliverer = new MessageDeliverer(
      makeDeps({
        terminal: {
          available: () => true,
          listPanes: async () => [{ id: 'pane-1', title: 'msg-target', cwd: PROJECT_PATH }],
          sendText: vi.fn().mockResolvedValue(undefined),
          sendKeys: vi.fn(),
          closePane: vi.fn(),
        },
      }),
    );
    pushEvent(SESSION_ID, 'Stop');
    const first = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '继续',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    const firstId = (first as { messageId: string }).messageId;
    // 清等待位让第二条同时在飞（同上一条测试的手法）：两条「继续」都贴进了框
    deliverer.sessionExited(SESSION_ID);
    const second = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '继续',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    const secondId = (second as { messageId: string }).messageId;

    // 实测形态：框里先有一个手敲的「1」，两条「继续」叠进去后一并提交——尾部相等
    // 把两条都核销（整条相等则两条都只能挂到未回执闸，队列每条吃一次 10 分钟闸）
    deliverer.onSessionPrompt(SESSION_ID, '1继续继续', 910);
    expect(deliverer.getMessage(firstId)?.acked).toBe(true);
    expect(deliverer.getMessage(secondId)?.acked).toBe(true);
    expect(deliverer.getMessage(firstId)?.ackedEventId).toBe(910);
  });

  it('中继失败但回执已到：按已送达收、不置闸（已送达的会话队列不能被无限期停住）', async () => {
    const fake = createFakeSpawn();
    const { surface } = relaySurface();
    const deliverer = new MessageDeliverer(
      makeDeps({
        spawnImpl: fake.spawnImpl,
        surfaceFor: () => surface,
        bin: 'fake-relay',
        flushGapMs: 0,
      }),
    );
    pushEvent(SESSION_ID, 'Stop');
    const first = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '回执先到的中继正文',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    const firstId = (first as { messageId: string }).messageId;

    // 消息确实进去了（宿主先发了回执），中继进程随后非 0 退出——exit 只管进程，不管送达
    deliverer.onSessionPrompt(SESSION_ID, '回执先到的中继正文');
    fake.children[0]!.emit('exit', 1, null);

    expect(deliverer.getMessage(firstId)).toMatchObject({ status: 'delivered', acked: true });
    expect(deliverer.getMessage(firstId)?.stalled).not.toBe(true);
    expect(busEvents).not.toContainEqual(
      expect.objectContaining({ kind: 'message.stalled', messageId: firstId }),
    );

    // 闸没落下 → 队列照常推进（会话级暂停会让后续消息永远排着）
    const second = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '闸后那条正文',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    expect(second).toMatchObject({ ok: true, status: 'delivering' });
    expect(fake.calls).toHaveLength(2);
  });

  it('终端投递的回执落在 write 期间：已送达按当前行收尾，不被快照抹掉、也不置闸', async () => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    const gate: { resolve: () => void; reject: (err: Error) => void } = {
      resolve: () => {},
      reject: () => {},
    };
    let armed = false;
    const terminalOf = () => ({
      available: () => true,
      listPanes: async () => [{ id: 'pane-1', title: 'msg-target', cwd: PROJECT_PATH }],
      sendText: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve, reject) => {
            gate.resolve = resolve;
            gate.reject = reject;
            armed = true;
          }),
      ),
      sendKeys: vi.fn(),
      closePane: vi.fn(),
    });

    for (const outcome of ['ok', 'fail'] as const) {
      const deliverer = new MessageDeliverer(makeDeps({ terminal: terminalOf() }));
      pushEvent(SESSION_ID, 'Stop');
      const text = `write 期间回执（${outcome}）`;
      const sending = deliverer.send({
        toSessionId: SESSION_ID,
        text,
        mode: 'prompt',
        fromKind: 'dashboard',
        oneWay: true,
      });
      await vi.waitFor(() => expect(armed).toBe(true));
      armed = false;
      // 文本已经进了框、宿主先发了回执，write 这一刻才落定（正常返回 / 抛错都可能）
      deliverer.onSessionPrompt(SESSION_ID, text);
      if (outcome === 'ok') gate.resolve();
      else gate.reject(new Error('pane write failed'));
      const result = await sending;
      const id = (result as { messageId: string }).messageId;
      expect(deliverer.getMessage(id)).toMatchObject({ status: 'delivered', acked: true });
      expect(deliverer.getMessage(id)?.stalled).not.toBe(true);
      expect(busEvents).not.toContainEqual(
        expect.objectContaining({ kind: 'message.stalled', messageId: id }),
      );
    }
  });

  it('中继不设超时：等多久都留在途中（等待发生在目标会话内，不得误判 timeout）', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeSpawn();
      const killImpl = vi.fn();
      const { surface } = relaySurface();
      const deliverer = new MessageDeliverer(
        makeDeps({ spawnImpl: fake.spawnImpl, killImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
      );
      pushEvent(SESSION_ID, 'Stop');

      const result = await deliverer.send({
        toSessionId: SESSION_ID,
        text: 'long delivery',
        mode: 'prompt',
        fromKind: 'dashboard',
        oneWay: true,
      });
      // 远超旧 120s 上限：不杀进程、状态仍是 delivering
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(killImpl).not.toHaveBeenCalled();
      expect(deliverer.getMessage((result as { messageId: string }).messageId)!.status).toBe(
        'delivering',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('prompt 层① 中继键 = 合成键：目标会话 headless 被占不挡中继', async () => {
    const fake = createFakeSpawn();
    const headless = new HeadlessRunner({ spawnImpl: fake.spawnImpl });
    const { surface } = relaySurface();
    const deliverer = new MessageDeliverer(
      makeDeps({ headless, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    pushEvent(SESSION_ID, 'Stop');

    // 先占住目标会话的 headless 闸
    expect(
      headless.run({
        sessionId: SESSION_ID,
        cwd: PROJECT_PATH,
        prompt: 'occupy',
        spec: {
          supported: true,
          bin: 'fake-claude',
          args: (sid) => ['--resume', sid, '-p'],
          promptStdin: true,
        },
        bin: 'fake-claude',
      }),
    ).toBe(true);

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'via relay',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(result).toMatchObject({ ok: true, status: 'delivering' });
    expect(fake.calls).toHaveLength(2); // 占位 spawn + 中继 spawn
  });

  it('prompt 层③：peer 未登记（会话没开）→ 入 promptbox 队列；登记出现后 flushSession 中继冲洗', async () => {
    const fake = createFakeSpawn();
    let registered = false;
    const { surface } = relaySurface((sessionId) =>
      registered ? { name: PEER_NAME } : null,
    );
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    pushEvent(SESSION_ID, 'Stop');

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'queued hello',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(result).toMatchObject({ ok: true, status: 'pending' });
    expect(fake.calls).toHaveLength(0);
    const queued = readPromptbox(hooksDir, TOKEN);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.text).toBe('queued hello');
    expect(deliverer.hasQueued(SESSION_ID)).toBe(true);
    // pending 在在途视图里
    expect(deliverer.listVisible(SESSION_ID).map((m) => m.status)).toContain('pending');

    // 会话开了（peer 注册表出现）→ 冲洗：中继启动 + 行删除
    registered = true;
    await deliverer.flushSession(SESSION_ID);
    expect(fake.calls).toHaveLength(1);
    expect(fake.children[0]!.stdin.writes[0]).toContain(PEER_NAME);
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
    expect(deliverer.hasQueued(SESSION_ID)).toBe(false);
    expect(deliverer.getMessage((result as { messageId: string }).messageId)!.status).toBe('delivering');
  });

  it('prompt 层③ 驻留：peer 仍缺 → flushSession 幂等不动行；中继失败不回队（failed 可见）', async () => {
    const fake = createFakeSpawn();
    const { surface } = relaySurface(() => null); // 永不登记
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    pushEvent(SESSION_ID, 'Stop');
    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'stays queued',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(result).toMatchObject({ ok: true, status: 'pending' });

    await deliverer.flushSession(SESSION_ID);
    expect(fake.calls).toHaveLength(0);
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(1); // 行留队列

    // 队列里那条撤掉（用户取消发送）：否则新投递器一启动就看见积压，新消息只能排队尾
    deliverer.dismiss(SESSION_ID, readPromptbox(hooksDir, TOKEN)[0]!.id);

    // 层① 闪现（登记了一瞬）→ 中继非 0 退出 → failed 留内存可见、不回队
    const flaky = relaySurface((sessionId) => ({ name: PEER_NAME }));
    const flakyDeliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => flaky.surface, bin: 'fake-relay' }),
    );
    // 直接对 flaky 面发一条即时中继，然后让它失败
    const flakyResult = await flakyDeliverer.send({
      toSessionId: SESSION_ID,
      text: 'will fail',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    fake.children[fake.children.length - 1]!.emit('exit', 1, null);
    const failedMsg = flakyDeliverer.getMessage((flakyResult as { messageId: string }).messageId)!;
    expect(failedMsg.status).toBe('failed');
    expect(busEvents).toContainEqual(
      expect.objectContaining({ kind: 'message.finished', messageId: failedMsg.id, status: 'failed' }),
    );
    expect(readPromptbox(hooksDir, TOKEN).some((e) => e.id === failedMsg.id)).toBe(false);
  });

  it('判死：三层全无通路 + 目标进程不在 → 不假装排队，落 failed + offline（不置暂停闸）', async () => {
    const fake = createFakeSpawn();
    const { surface } = relaySurface(() => null); // peer 未登记
    const deliverer = new MessageDeliverer(
      makeDeps({
        spawnImpl: fake.spawnImpl,
        surfaceFor: () => surface,
        bin: 'fake-relay',
        livenessOf: () => new Map([[SESSION_ID, false]]),
      }),
    );
    pushEvent(SESSION_ID, 'Stop');

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '谁也收不到',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(result).toMatchObject({ ok: true, status: 'failed' });
    if (!result.ok) throw new Error('unreachable');
    const failed = result.message;
    expect(failed.reason).toBe('offline');
    expect(failed.error).toBe('Session is not running');
    expect(fake.calls).toHaveLength(0);
    // 不入队：没有死信排在队列里等一个永远不来的取件人
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
    expect(deliverer.hasQueued(SESSION_ID)).toBe(false);
    // 终态 + 帧（既有 messageFailed 订阅提醒照常），且不置暂停闸（不挡重发）
    expect(deliverer.getMessage(failed.id)!.status).toBe('failed');
    expect(busEvents).toContainEqual(
      expect.objectContaining({ kind: 'message.finished', messageId: failed.id, status: 'failed' }),
    );
    expect(busEvents.some((m) => m.kind === 'message.stalled')).toBe(false);
    const visible = deliverer.listVisible(SESSION_ID).find((m) => m.id === failed.id);
    expect(visible).toMatchObject({ status: 'failed', reason: 'offline' });

    // 同判据的另一半：注册表里查无此人（daemon 重启后凭据图还没建回来、
    // 或进程被强杀没清登记）+ 早已过新会话豁免窗 → 同样判死，不靠注入的图。
    backdateLastSeen(SESSION_ID);
    const noReg = new MessageDeliverer(
      makeDeps({ surfaceFor: () => surface, livenessOf: () => new Map() }),
    );
    const stale = await noReg.send({
      toSessionId: SESSION_ID,
      text: '同样送不出去',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(stale).toMatchObject({ ok: true, status: 'failed' });
  });

  it('重发判死的行：offline 的成因与说明一并作废，不跟着重投的行继续显示', async () => {
    const fake = createFakeSpawn();
    const { surface } = relaySurface(() => null);
    let alive: boolean | null = false;
    const deliverer = new MessageDeliverer(
      makeDeps({
        spawnImpl: fake.spawnImpl,
        surfaceFor: () => surface,
        bin: 'fake-relay',
        livenessOf: () => new Map([[SESSION_ID, alive]]),
      }),
    );
    pushEvent(SESSION_ID, 'Stop');

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '先判死再重发',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    if (!result.ok) throw new Error('unreachable');
    expect(result.message).toMatchObject({ status: 'failed', reason: 'offline' });

    // 会话又活过来了（用户先打开会话再点重发）：三层仍无通路 → 入队等冲洗
    alive = true;
    const resent = await deliverer.resend(result.messageId);
    expect(resent).toMatchObject({ ok: true, status: 'pending' });
    const row = deliverer.listVisible(SESSION_ID).find((m) => m.id === result.messageId);
    expect(row).toMatchObject({ status: 'pending' });
    expect(row!.reason).toBeUndefined();
    expect(row!.error ?? null).toBeNull();
  });

  it('判死先于三层：残留的 peer 登记不算通路，中继一个都不起', async () => {
    const fake = createFakeSpawn();
    // peer 注册表是会话进程写的，进程死了文件不会立刻消失——登记还在 ≠ 送得到
    const { surface } = relaySurface(() => ({ name: PEER_NAME }));
    const deliverer = new MessageDeliverer(
      makeDeps({
        spawnImpl: fake.spawnImpl,
        surfaceFor: () => surface,
        bin: 'fake-relay',
        livenessOf: () => new Map([[SESSION_ID, false]]),
      }),
    );
    pushEvent(SESSION_ID, 'Stop');

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '终端早关了',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    // 原先这里会走层① 中继：exit 0 → 记 delivered → 60s 后从待发送消失、气泡永远
    // 不来，120s 后才以 stalled 冒头。判死就该当场落 offline。
    expect(result).toMatchObject({ ok: true, status: 'failed' });
    if (!result.ok) throw new Error('unreachable');
    expect(result.message.reason).toBe('offline');
    expect(fake.calls).toHaveLength(0);
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
  });

  it('判不动 → 照旧入队 pending，绝不误判死', async () => {
    const { surface } = relaySurface(() => null);
    // ① 存活图里没有该会话，但会话刚活动过（claude 登记文件可能还没落盘）→ 不猜
    const unknown = new MessageDeliverer(
      makeDeps({ surfaceFor: () => surface, livenessOf: () => new Map() }),
    );
    pushEvent(SESSION_ID, 'Stop');
    const queued = await unknown.send({
      toSessionId: SESSION_ID,
      text: '留队列',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(queued).toMatchObject({ ok: true, status: 'pending' });
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(1);

    // ② codex：登记表是 claude 自己的东西，codex 会话永远查不到；即便早就过
    // 豁免窗也不判（判活判据只认 claude，别的 harness 落 null）→ 照旧入队
    const noNative: MessagingSurface = {
      harness: 'codex',
      discovery: true,
      prompt: null,
      queuedPrompt: null,
      inject: null,
      headless: null,
      idleSignals: [],
    };
    const codex = new MessageDeliverer(
      makeDeps({
        surfaceFor: () => noNative,
        livenessOf: () => new Map(),
        terminal: {
          available: () => true,
          listPanes: async () => [],
          sendText: vi.fn(),
          sendKeys: vi.fn(),
          closePane: vi.fn(),
        },
      }),
    );
    pushEvent(CODEX_SESSION, 'Stop', 'codex');
    backdateLastSeen(CODEX_SESSION);
    const codexResult = await codex.send({
      toSessionId: CODEX_SESSION,
      text: 'codex 留队列',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(codexResult).toMatchObject({ ok: true, status: 'pending' });
  });

  it('codex 判得动：存活图给出 false（锁宽限窗过后）→ 当场落 offline，不白等 stalled', async () => {
    const { surface } = relaySurface(() => null);
    const noNative: MessagingSurface = {
      harness: 'codex',
      discovery: true,
      prompt: null,
      queuedPrompt: null,
      inject: null,
      headless: null,
      idleSignals: [],
    };
    const deliverer = new MessageDeliverer(
      makeDeps({
        surfaceFor: () => noNative,
        // codex 锁探针缓存给出的死结论（HELD 失去已过宽限窗）
        livenessOf: () => new Map([[CODEX_SESSION, false]]),
        terminal: {
          available: () => true,
          listPanes: async () => [],
          sendText: vi.fn(),
          sendKeys: vi.fn(),
          closePane: vi.fn(),
        },
      }),
    );
    pushEvent(CODEX_SESSION, 'Stop', 'codex');
    backdateLastSeen(CODEX_SESSION);
    const result = await deliverer.send({
      toSessionId: CODEX_SESSION,
      text: 'codex 判死',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(result).toMatchObject({ ok: true, status: 'failed' });
    if (!result.ok) throw new Error('unreachable');
    expect(result.message.reason).toBe('offline');
  });

  it('冲洗判死：队列整批转 offline 并清队（不再每轮白探 pane）', async () => {
    const { surface } = relaySurface(() => null);
    let alive = false;
    const deliverer = new MessageDeliverer(
      makeDeps({
        surfaceFor: () => surface,
        livenessOf: () => (alive ? new Map([[SESSION_ID, false]]) : new Map()),
      }),
    );
    pushEvent(SESSION_ID, 'Stop');
    for (const text of ['第一条', '第二条']) {
      const r = await deliverer.send({
        toSessionId: SESSION_ID,
        text,
        mode: 'prompt',
        fromKind: 'dashboard',
      });
      expect(r).toMatchObject({ status: 'pending' });
    }
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(2);

    alive = true; // 会话死了
    await deliverer.flushSession(SESSION_ID);
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
    expect(deliverer.hasQueued(SESSION_ID)).toBe(false);
    expect(
      busEvents.filter((m) => m.kind === 'message.finished').map((m) => m.status),
    ).toEqual(['failed', 'failed']);
    const rows = deliverer.listVisible(SESSION_ID);
    expect(rows.map((m) => m.reason)).toEqual(['offline', 'offline']);
  });

  it('会话退出（SessionEnd 到达）：凭据出盘、pane 定位清、队列行一并落 offline；会话与对话保留', async () => {
    const { surface } = relaySurface(() => null);
    // 判活图恒空 → 只测 SessionEnd 这一条路径（A 的判死另有测试）
    const deliverer = new MessageDeliverer(
      makeDeps({
        surfaceFor: () => surface,
        livenessOf: () => new Map(),
        terminal: {
          available: () => true,
          listPanes: async () => [], // pane 找不到 → 层② 不接，行留队列
          locateScreens: async (envs) =>
            Object.fromEntries(
              Object.keys(envs).map((sid) => [
                sid,
                { id: 'w1:0', windowId: 1, tabId: 0, tabsInWindow: 1 },
              ]),
            ),
          sendText: vi.fn(),
          sendKeys: vi.fn(),
          closePane: vi.fn(),
        },
      }),
    );
    pushEvent(SESSION_ID, 'Stop');
    deliverer.noteInboxSocket(SESSION_ID, { socket: '\\\\.\\pipe\\local\\gone', token: 't' });
    deliverer.notePaneEnv(SESSION_ID, { WEZTERM_PANE: '3' });
    const targetsFile = join(hooksDir, INBOX_TARGETS_FILE);
    expect(readFileSync(targetsFile, 'utf8')).toContain(SESSION_ID);
    expect(await deliverer.sessionTerminals()).toHaveProperty(SESSION_ID);

    for (const text of ['退出前第一条', '退出前第二条']) {
      const r = await deliverer.send({
        toSessionId: SESSION_ID,
        text,
        mode: 'prompt',
        fromKind: 'dashboard',
      });
      expect(r).toMatchObject({ status: 'pending' });
    }
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(2);

    deliverer.sessionExited(SESSION_ID);
    // 旁路事实随进程作废：凭据出盘（旧 socket 已死，留着只会白试）、定位清
    expect(readFileSync(targetsFile, 'utf8')).not.toContain(SESSION_ID);
    // 撤销的定位显式报 null（拓扑合并契约「缺席 = 保留」，不报旧分块永远留着），
    // 报完即焚：再取一次就是空表
    expect(await deliverer.sessionTerminals()).toEqual({ [SESSION_ID]: null });
    expect(await deliverer.sessionTerminals()).toEqual({});
    // 队列行此刻已成死信 → 一并按 offline 落定并清队
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
    expect(deliverer.hasQueued(SESSION_ID)).toBe(false);
    expect(deliverer.listVisible(SESSION_ID).map((m) => m.reason)).toEqual(['offline', 'offline']);
    // 会话行与对话照常保留（那是历史，不是旁路事实——不走 forgetSession 的删会话级联）
    expect(sessions.getBySessionId(SESSION_ID)).not.toBeNull();
    expect(deliverer.listVisible(SESSION_ID).length).toBeGreaterThan(0);
  });

  it('daemon 重启：pane 定位 env 从盘上恢复（长时间没动静的会话不掉出终端分组）', async () => {
    const terminal = (): PromptTerminal => ({
      available: () => true,
      listPanes: async () => [],
      locateScreens: async (envs) =>
        Object.fromEntries(
          Object.keys(envs).map((sid) => [
            sid,
            { id: 'w1:0', windowId: 1, tabId: 0, tabsInWindow: 1 },
          ]),
        ),
      sendText: vi.fn(),
      sendKeys: vi.fn(),
      closePane: vi.fn(),
    });
    const live = () => new Map<string, boolean>();
    const first = new MessageDeliverer(makeDeps({ terminal: terminal(), livenessOf: live }));
    first.notePaneEnv(SESSION_ID, { WEZTERM_PANE: '3' });

    // 重启后的新一代实例：会话没再发过任何 hook 事件，仍认得出自己的屏
    const second = new MessageDeliverer(makeDeps({ terminal: terminal(), livenessOf: live }));
    expect(await second.sessionTerminals()).toHaveProperty(SESSION_ID);

    // 删会话时清盘：再重启不会把已删的会话拉回分组
    second.forgetSession(SESSION_ID);
    const third = new MessageDeliverer(makeDeps({ terminal: terminal(), livenessOf: live }));
    expect(await third.sessionTerminals()).toEqual({});
  });

  it('盘上恢复的 env 判死的会话不占块头（顺手清盘）', async () => {
    const locateScreens = vi.fn(async (envs: Record<string, Record<string, string>>) =>
      Object.fromEntries(
        Object.keys(envs).map((sid) => [sid, { id: 'w1:0', windowId: 1, tabId: 0, tabsInWindow: 1 }]),
      ),
    );
    const terminal = (): PromptTerminal => ({
      available: () => true,
      listPanes: async () => [],
      locateScreens,
      sendText: vi.fn(),
      sendKeys: vi.fn(),
      closePane: vi.fn(),
    });
    sessions.touch(CODEX_SESSION, projectId);
    const first = new MessageDeliverer(makeDeps({ terminal: terminal(), livenessOf: () => new Map() }));
    first.notePaneEnv(SESSION_ID, { WEZTERM_PANE: '3' });
    first.notePaneEnv(CODEX_SESSION, { CLAUDE_PID: '424242' });

    // 重启 + SESSION_ID 的进程已判死：只把还活着的会话交给后端，判死的从盘上也摘掉
    const second = new MessageDeliverer(
      makeDeps({
        terminal: terminal(),
        livenessOf: () => new Map([[SESSION_ID, false]]),
      }),
    );
    const screens = await second.sessionTerminals();
    // 判死的会话显式回 null（refresher 合并契约：null = 确认不在了，覆盖旧分块）
    expect(screens).toEqual({ [SESSION_ID]: null, [CODEX_SESSION]: { id: 'w1:0', windowId: 1, tabId: 0, tabsInWindow: 1 } });
    const third = new MessageDeliverer(makeDeps({ terminal: terminal(), livenessOf: () => new Map() }));
    expect(Object.keys(await third.sessionTerminals())).toEqual([CODEX_SESSION]);
  });

  it('终端通道注入但 available()=false（settings 换了不支持的后端）→ prompt 409、矩阵不亮', async () => {
    const terminal: PromptTerminal = {
      available: () => false,
      listPanes: vi.fn(),
      sendText: vi.fn(),
      sendKeys: vi.fn(),
      closePane: vi.fn(),
    };
    const noNative: MessagingSurface = {
      harness: 'codex',
      discovery: true,
      prompt: null,
      queuedPrompt: null,
      inject: null,
      headless: null,
      idleSignals: [],
    };
    const deliverer = new MessageDeliverer(makeDeps({ surfaceFor: () => noNative, terminal }));
    pushEvent(SESSION_ID, 'Stop', 'codex');

    expect(deliverer.hasTerminalChannel()).toBe(false);
    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'hi',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(terminal.listPanes).not.toHaveBeenCalled();
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
  });

  it('prompt 层②：无原生面 + 终端通道——pane 标题（剥 spinner）+ cwd 匹配即注入；歧义拒绝', async () => {
    const sessions2 = sessions; // 标题挂在会话行上
    sessions.touch(SESSION_ID, projectId);
    // 会话标题：listWithCounts 之前先确保 title 存在——SessionRepository.touch 不带 title；
    // 直接经 UPDATE 语句落（测试专用窄口）
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('✳ msg-target', SESSION_ID);
    void sessions2;
    const panes = [
      { id: 'pane-1', title: '✳ msg-target', cwd: PROJECT_PATH },
      { id: 'pane-2', title: 'other', cwd: PROJECT_PATH },
    ];
    const sendText = vi.fn().mockResolvedValue(undefined);
    const terminal: PromptTerminal = {
      available: () => true,
      listPanes: vi.fn().mockResolvedValue(panes),
      sendText,
      sendKeys: vi.fn(),
      closePane: vi.fn(),
    };
    const noNative: MessagingSurface = {
      harness: 'codex',
      discovery: true,
      prompt: null,
      queuedPrompt: null,
      inject: null,
      headless: null,
      idleSignals: [],
      unsupportedReasons: { prompt: 'no native channel (test)' },
    };
    const deliverer = new MessageDeliverer(
      makeDeps({ surfaceFor: () => noNative, terminal }),
    );
    pushEvent(SESSION_ID, 'Stop', 'codex');

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'terminal hello',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(result).toMatchObject({ ok: true, status: 'delivering' });
    expect(sendText).toHaveBeenCalledWith('pane-1', 'terminal hello');
    await vi.waitFor(() =>
      expect(deliverer.getMessage((result as { messageId: string }).messageId)!.status).toBe('delivered'),
    );
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);

    // 歧义（两个 pane 同标题同 cwd）→ 拒绝 → 入队
    const ambiguous: PromptTerminal = {
      available: () => true,
      listPanes: vi.fn().mockResolvedValue([
        { id: 'pane-1', title: 'msg-target', cwd: PROJECT_PATH },
        { id: 'pane-3', title: 'msg-target', cwd: PROJECT_PATH },
      ]),
      sendText,
      sendKeys: vi.fn(),
      closePane: vi.fn(),
    };
    const ambDeliverer = new MessageDeliverer(
      makeDeps({ surfaceFor: () => noNative, terminal: ambiguous }),
    );
    const ambResult = await ambDeliverer.send({
      toSessionId: SESSION_ID,
      text: 'ambiguous',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(ambResult).toMatchObject({ ok: true, status: 'pending' });
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(1);
  });

  it('prompt 层② 队列冲洗：pane 出现后 flushSession 经终端注入删行', async () => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    let panes: Array<{ id: string; title: string; cwd: string }> = [];
    const sendText = vi.fn().mockResolvedValue(undefined);
    const terminal: PromptTerminal = {
      available: () => true,
      listPanes: vi.fn().mockImplementation(async () => panes),
      sendText,
      sendKeys: vi.fn(),
      closePane: vi.fn(),
    };
    const noNative: MessagingSurface = {
      harness: 'codex',
      discovery: true,
      prompt: null,
      queuedPrompt: null,
      inject: null,
      headless: null,
      idleSignals: [],
    };
    const deliverer = new MessageDeliverer(
      makeDeps({ surfaceFor: () => noNative, terminal }),
    );
    pushEvent(SESSION_ID, 'Stop', 'codex');

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'wait for pane',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(result).toMatchObject({ ok: true, status: 'pending' });

    panes = [{ id: 'pane-9', title: 'msg-target', cwd: PROJECT_PATH }];
    await deliverer.flushSession(SESSION_ID);
    expect(sendText).toHaveBeenCalledWith('pane-9', 'wait for pane');
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
    await vi.waitFor(() =>
      expect(deliverer.getMessage((result as { messageId: string }).messageId)!.status).toBe('delivered'),
    );
  });

  it('prompt 层② 模态框在场：终端不盲注（文本与回车会被模态框吃掉），留队列等作答', async () => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    let blocked = true;
    const sendText = vi.fn().mockResolvedValue(undefined);
    const terminal: PromptTerminal = {
      available: () => true,
      listPanes: vi
        .fn()
        .mockResolvedValue([{ id: 'pane-9', title: 'msg-target', cwd: PROJECT_PATH }]),
      sendText,
      sendKeys: vi.fn(),
      closePane: vi.fn(),
    };
    const noNative: MessagingSurface = {
      harness: 'codex',
      discovery: true,
      prompt: null,
      queuedPrompt: null,
      inject: null,
      headless: null,
      idleSignals: [],
    };
    const deliverer = new MessageDeliverer(
      makeDeps({ surfaceFor: () => noNative, terminal, blockedByQuestion: () => blocked }),
    );
    pushEvent(SESSION_ID, 'Stop', 'codex');

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'blocked msg',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(result).toMatchObject({ ok: true, status: 'pending' });
    expect(sendText).not.toHaveBeenCalled();
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(1);

    // 作答完（模态框关）：下一拍冲洗即正常注入。
    blocked = false;
    await deliverer.flushSession(SESSION_ID);
    expect(sendText).toHaveBeenCalledWith('pane-9', 'blocked msg');
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
  });

  it('prompt 层② pane 定位：hook 上报的 locator 优先，命中就不列 pane 猜标题', async () => {
    // 标题刻意留空（= 落库旧值已漂移/从未重命名）：locator 仍必须命中，
    // 否则回落到标题+cwd 是 0 命中 → 409。
    db.prepare('UPDATE sessions SET title = NULL WHERE session_id = ?').run(SESSION_ID);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const locatePane = vi.fn().mockResolvedValue('mux-abc:6');
    const terminal: PromptTerminal = {
      available: () => true,
      listPanes: vi.fn().mockResolvedValue([]),
      sendText,
      sendKeys: vi.fn(),
      closePane: vi.fn(),
      locatePane,
    };
    const noNative: MessagingSurface = {
      harness: 'codex',
      discovery: true,
      prompt: null,
      queuedPrompt: null,
      inject: null,
      headless: null,
      idleSignals: [],
    };
    const deliverer = new MessageDeliverer(makeDeps({ surfaceFor: () => noNative, terminal }));
    pushEvent(SESSION_ID, 'Stop', 'codex');
    const env = { WEZTERM_PANE: '6', WEZTERM_UNIX_SOCKET: 'D:/sock/gui-sock-1' };
    deliverer.notePaneEnv(SESSION_ID, env);

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'located hello',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(result).toMatchObject({ ok: true, status: 'delivering' });
    expect(locatePane).toHaveBeenCalledWith(env);
    expect(sendText).toHaveBeenCalledWith('mux-abc:6', 'located hello');
    expect(terminal.listPanes).not.toHaveBeenCalled();

    // locator 定位不到（pane 已关/换 mux）→ 回落标题+cwd，不猜也不误注入
    const fallbackText = vi.fn().mockResolvedValue(undefined);
    const fallback: PromptTerminal = {
      available: () => true,
      listPanes: vi
        .fn()
        .mockResolvedValue([{ id: 'pane-7', title: 'msg-target', cwd: PROJECT_PATH }]),
      sendText: fallbackText,
      sendKeys: vi.fn(),
      closePane: vi.fn(),
      locatePane: vi.fn().mockResolvedValue(null),
    };
    const fbDeliverer = new MessageDeliverer(makeDeps({ surfaceFor: () => noNative, terminal: fallback }));
    pushEvent(SESSION_ID, 'Stop', 'codex');
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    fbDeliverer.notePaneEnv(SESSION_ID, env);

    const fbResult = await fbDeliverer.send({
      toSessionId: SESSION_ID,
      text: 'fallback hello',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(fbResult).toMatchObject({ ok: true, status: 'delivering' });
    expect(fallbackText).toHaveBeenCalledWith('pane-7', 'fallback hello');
  });

  it('级联清理：forgetSession 清内存态 + 队列行；forgetProject 按项目归属清', async () => {
    const { surface } = relaySurface(() => null);
    const deliverer = new MessageDeliverer(makeDeps({ surfaceFor: () => surface }));
    pushEvent(SESSION_ID, 'Stop');
    pushEvent(CODEX_SESSION, 'Stop');
    await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'a',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    await deliverer.send({
      toSessionId: CODEX_SESSION,
      text: 'b',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(2);
    deliverer.noteInboxSocket(SESSION_ID, { socket: '\\\\.\\pipe\\local\\gone', token: 't' });
    const targetsFile = join(hooksDir, INBOX_TARGETS_FILE);
    expect(readFileSync(targetsFile, 'utf8')).toContain(SESSION_ID);

    const removed = deliverer.forgetSession(SESSION_ID);
    expect(removed).toBe(1);
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(1);
    expect(deliverer.hasQueued(SESSION_ID)).toBe(false);
    // 凭据随会话走：内存态与盘上行一起清
    expect(readFileSync(targetsFile, 'utf8')).not.toContain(SESSION_ID);

    const removedProject = deliverer.forgetProject(projectId);
    expect(removedProject).toBe(1);
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
    expect(deliverer.hasQueued(CODEX_SESSION)).toBe(false);
  });

  it('在途视图聚合：promptbox pending ∪ 内存 delivering/running/终态', async () => {
    const { surface } = relaySurface(() => null);
    const deliverer = new MessageDeliverer(makeDeps({ surfaceFor: () => surface }));
    pushEvent(SESSION_ID, 'Stop');
    await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'pending one',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    const visible = deliverer.listVisible(SESSION_ID);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ status: 'pending', channel: 'prompt', text: 'pending one' });
  });

  // ---- 终态驻留（决定①）：delivered 在窗口内展示 via/acked；未回执的跨窗留着 ----

  it('终态驻留：socket 直投 delivered 带 via/settledAt，未回执时跨窗也留着，回执到了才退场', async () => {
    const path = uniqueInboxPath();
    const inbox = await fakeInboxAt(path, () => {});
    const fake = createFakeSpawn();
    const { surface } = relaySurface();
    const deliverer = new MessageDeliverer(
      makeDeps({
        spawnImpl: fake.spawnImpl,
        surfaceFor: () => surface,
        bin: 'fake-relay',
        visibleTtlMs: 80,
      }),
    );
    pushEvent(SESSION_ID, 'Stop');
    deliverer.noteInboxSocket(SESSION_ID, { socket: path, token: 'tok' });

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'ttl visibility body',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    const id = (result as { messageId: string }).messageId;
    expect(deliverer.getMessage(id)).toMatchObject({
      status: 'delivered',
      via: 'socket',
      settledAt: expect.any(String),
    });
    expect(deliverer.listVisible(SESSION_ID).map((m) => m.id)).toContain(id);
    await new Promise((r) => setTimeout(r, 160));
    // 没回执 = 还在飞：跨过窗口也露着（撤掉它这条先消失、闸落定时又冒出来）
    expect(deliverer.listVisible(SESSION_ID).map((m) => m.id)).toContain(id);
    deliverer.onSessionPrompt(SESSION_ID, 'ttl visibility body');
    // 回执到了、驻留窗口又早已过：从在途视图退场（历史在转录里，气泡认领它）
    expect(deliverer.listVisible(SESSION_ID).map((m) => m.id)).not.toContain(id);
    inbox.close();
  });

  // ---- 未回执闸（决定②）：超窗未回执暂停队列；回执命中 / 手动重发解除 ----

  it('未回执闸：送达超窗未回执 → stalled 帧 + 队列暂停；回执命中 → 解闸自续排空', async () => {
    const fake = createFakeSpawn();
    let registered = true;
    const { surface } = relaySurface(() => (registered ? { name: PEER_NAME } : null));
    const deliverer = new MessageDeliverer(
      makeDeps({
        spawnImpl: fake.spawnImpl,
        surfaceFor: () => surface,
        bin: 'fake-relay',
        flushGapMs: 0,
        ackStallMs: 80,
      }),
    );
    pushEvent(SESSION_ID, 'Stop');

    // 第一条：中继投递成功（delivered），但不给回执
    const first = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'no receipt body here',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    const firstId = (first as { messageId: string }).messageId;
    fake.children[0]!.emit('exit', 0, null);

    // 第二条：peer 瞬时消失 → 入队
    registered = false;
    await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'queued behind no-receipt',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(1);

    // 超窗 → 置闸（成因消息常驻在途视图）
    await new Promise((r) => setTimeout(r, 160));
    expect(busEvents).toContainEqual(
      expect.objectContaining({ kind: 'message.stalled', messageId: firstId, reason: 'unacked' }),
    );
    expect(deliverer.getMessage(firstId)!.stalled).toBe(true);
    expect(deliverer.listVisible(SESSION_ID).map((m) => m.id)).toContain(firstId);

    // 闸住：peer 重新登记，flushSession 也不投
    registered = true;
    await deliverer.flushSession(SESSION_ID);
    expect(fake.calls).toHaveLength(1);
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(1);

    // 回执命中 → 解闸 + 自续冲洗把队列行投出去
    deliverer.onSessionPrompt(SESSION_ID, 'no receipt body here');
    expect(deliverer.getMessage(firstId)!.stalled).toBe(false);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
    fake.children[1]!.emit('exit', 0, null);
    expect(deliverer.getMessage(firstId)!.acked).toBe(true);
  });

  it('闸到点自解：回执一直不来 → 成因行直接从队列清除（带倒计时），积压自己续排', async () => {
    const fake = createFakeSpawn();
    let registered = true;
    const { surface } = relaySurface(() => (registered ? { name: PEER_NAME } : null));
    const deliverer = new MessageDeliverer(
      makeDeps({
        spawnImpl: fake.spawnImpl,
        surfaceFor: () => surface,
        bin: 'fake-relay',
        flushGapMs: 0,
        ackStallMs: 40,
        ackStallReleaseMs: 200,
      }),
    );
    pushEvent(SESSION_ID, 'Stop');

    const first = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'lost in the composer body',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    const firstId = (first as { messageId: string }).messageId;
    fake.children[0]!.emit('exit', 0, null);

    registered = false;
    await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'queued behind lost message',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    // 置闸：行上带清除时刻（web 的倒计时读数就是它）
    await vi.waitFor(() => expect(deliverer.getMessage(firstId)!.stalled).toBe(true));
    expect(Date.parse(deliverer.getMessage(firstId)!.releaseAt!)).toBeGreaterThan(Date.now());

    // 到点：这一行整个消失（正文随之丢——窗口期就是给人看清与重发），闸解、积压续排
    registered = true;
    await vi.waitFor(() => expect(deliverer.getMessage(firstId)).toBeNull());
    expect(busEvents).toContainEqual(
      expect.objectContaining({ kind: 'message.dismissed', messageId: firstId }),
    );
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
    fake.children[1]!.emit('exit', 0, null);
  });

  it('投递失败置闸：中继非 0 退出后不再自动续冲洗；手动重发解闸并恢复队列', async () => {
    const fake = createFakeSpawn();
    let registered = true;
    const { surface } = relaySurface(() => (registered ? { name: PEER_NAME } : null));
    const deliverer = new MessageDeliverer(
      makeDeps({
        spawnImpl: fake.spawnImpl,
        surfaceFor: () => surface,
        bin: 'fake-relay',
        flushGapMs: 0,
      }),
    );
    pushEvent(SESSION_ID, 'Stop');

    const first = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'failing relay body',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    const firstId = (first as { messageId: string }).messageId;
    fake.children[0]!.emit('exit', 1, null);
    expect(deliverer.getMessage(firstId)).toMatchObject({ status: 'failed', stalled: true });
    expect(busEvents).toContainEqual(
      expect.objectContaining({ kind: 'message.stalled', messageId: firstId, reason: 'failed' }),
    );

    // 队列积压被闸挡住（peer 在场也不投）
    registered = false;
    const second = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'queued after failure',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    expect(second).toMatchObject({ ok: true, status: 'pending' });
    registered = true;
    await deliverer.flushSession(SESSION_ID);
    expect(fake.calls).toHaveLength(1); // 没有新中继
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(1);

    // 手动重发：failed 消息重走投递（中继闸已释放 → 再起一个中继）
    const resend = await deliverer.resend(firstId);
    expect(resend).toMatchObject({ ok: true, status: 'delivering' });
    expect(fake.calls).toHaveLength(2);
    fake.children[1]!.emit('exit', 0, null);
    expect(deliverer.getMessage(firstId)!.status).toBe('delivered');

    // 一条在手：积压行要等这条的回执（不是中继退 0 就接着发）
    await deliverer.flushSession(SESSION_ID);
    expect(fake.calls).toHaveLength(2);

    // 回执到 → 自续冲洗投出积压行
    deliverer.onSessionPrompt(SESSION_ID, 'failing relay body');
    await vi.waitFor(() => expect(fake.calls).toHaveLength(3));
    fake.children[2]!.emit('exit', 0, null);
    await vi.waitFor(() => expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0));
  });

  it('重发只对 failed / delivered-未回执 开放：未知 404、已回执 409', async () => {
    const path = uniqueInboxPath();
    const inbox = await fakeInboxAt(path, () => {});
    const { surface } = relaySurface();
    const deliverer = new MessageDeliverer(
      makeDeps({ surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    pushEvent(SESSION_ID, 'Stop');
    deliverer.noteInboxSocket(SESSION_ID, { socket: path, token: 'tok' });

    await expect(deliverer.resend('no-such-message')).resolves.toMatchObject({
      ok: false,
      status: 404,
    });
    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'acked then resend rejected',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    const id = (result as { messageId: string }).messageId;
    deliverer.onSessionPrompt(SESSION_ID, 'acked then resend rejected');
    await expect(deliverer.resend(id)).resolves.toMatchObject({ ok: false, status: 409 });
    inbox.close();
  });

  it('重发回落入队：通道全缺时旧内存态清干净（同 id 不双行），peer 回来后正常冲洗', async () => {
    const fake = createFakeSpawn();
    let registered = true;
    const { surface } = relaySurface(() => (registered ? { name: PEER_NAME } : null));
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    pushEvent(SESSION_ID, 'Stop');

    const first = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'resend queue fallback body',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    const id = (first as { messageId: string }).messageId;
    fake.children[0]!.emit('exit', 1, null); // failed + 置闸

    // 通道全缺（peer 消失、无终端）→ 重发回落入队；旧内存态必须清干净
    registered = false;
    const resend = await deliverer.resend(id);
    expect(resend).toMatchObject({ ok: true, status: 'pending' });
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(1);
    expect(deliverer.getMessage(id)).toBeNull();
    expect(deliverer.listVisible(SESSION_ID).filter((m) => m.id === id)).toHaveLength(1);

    // peer 回来 → 冲洗正常投出（中继指令带 oneWay 标记）
    registered = true;
    await deliverer.flushSession(SESSION_ID);
    expect(fake.calls).toHaveLength(2);
    expect(fake.children[1]!.stdin.writes[0]).toContain('[one-way]');
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
  });

  describe('起点候选（paneEnvSource=launch 的 harness：spawn 回执 → 会话）', () => {
    it('note → claim 命中：FIFO 最早匹配条目落成 pane 定位，其余留存', () => {
      const deliverer = new MessageDeliverer(makeDeps());
      deliverer.notePendingOrigin({ harness: 'codex', projectId, env: { WEZTERM_PANE: '1' } });
      deliverer.notePendingOrigin({ harness: 'codex', projectId, env: { WEZTERM_PANE: '2' } });
      deliverer.claimPendingOrigin(SESSION_ID, 'codex', projectId);
      expect(deliverer.diagnose(SESSION_ID).paneEnvReported).toBe(true);
      // 第二条还在队里：换个 sessionId 再认领拿到它（FIFO）
      deliverer.claimPendingOrigin('other-session', 'codex', projectId);
      expect(deliverer.diagnose('other-session').paneEnvReported).toBe(true);
    });

    it('不匹配 no-op：条目留存、会话不误挂', () => {
      const deliverer = new MessageDeliverer(makeDeps());
      deliverer.notePendingOrigin({ harness: 'codex', projectId, env: { WEZTERM_PANE: '1' } });
      deliverer.claimPendingOrigin(SESSION_ID, 'claude', projectId);
      expect(deliverer.diagnose(SESSION_ID).paneEnvReported).toBe(false);
      deliverer.claimPendingOrigin(SESSION_ID, 'codex', projectId + 999);
      expect(deliverer.diagnose(SESSION_ID).paneEnvReported).toBe(false);
      // 原条目仍可被正确认领
      deliverer.claimPendingOrigin(SESSION_ID, 'codex', projectId);
      expect(deliverer.diagnose(SESSION_ID).paneEnvReported).toBe(true);
    });

    it('daemon 重启：未认领的候选从盘上恢复；过期条目被剪', async () => {
      const deliverer = new MessageDeliverer(makeDeps());
      deliverer.notePendingOrigin({ harness: 'codex', projectId, env: { WEZTERM_PANE: '1' } });
      // 手工把盘上唯一条目改成过期时刻，再起一代实例
      const file = join(hooksDir, 'pending-origins.json');
      const stale = JSON.parse(readFileSync(file, 'utf8')) as Array<{ at: string }>;
      stale[0]!.at = new Date(Date.now() - 16 * 60_000).toISOString();
      writeFileSync(file, JSON.stringify(stale));
      const second = new MessageDeliverer(makeDeps());
      second.claimPendingOrigin(SESSION_ID, 'codex', projectId);
      expect(second.diagnose(SESSION_ID).paneEnvReported).toBe(false);
    });

    it('项目归档级联：该项目的候选一并出队', () => {
      const deliverer = new MessageDeliverer(makeDeps());
      deliverer.notePendingOrigin({ harness: 'codex', projectId, env: { WEZTERM_PANE: '1' } });
      deliverer.forgetProject(projectId);
      deliverer.claimPendingOrigin(SESSION_ID, 'codex', projectId);
      expect(deliverer.diagnose(SESSION_ID).paneEnvReported).toBe(false);
    });
  });

  describe('dismiss（删掉在途视图里的一行）', () => {
    it('删成因行：视图里不再有它、解闸并续排空积压；未知 id 404', async () => {
      const fake = createFakeSpawn();
      let registered = true;
      const { surface } = relaySurface(() => (registered ? { name: PEER_NAME } : null));
      const deliverer = new MessageDeliverer(
        makeDeps({
          spawnImpl: fake.spawnImpl,
          surfaceFor: () => surface,
          bin: 'fake-relay',
          flushGapMs: 0,
        }),
      );
      pushEvent(SESSION_ID, 'Stop');

      const first = await deliverer.send({
        toSessionId: SESSION_ID,
        text: 'dismissed failing body',
        mode: 'prompt',
        fromKind: 'dashboard',
        oneWay: true,
      });
      const firstId = (first as { messageId: string }).messageId;
      fake.children[0]!.emit('exit', 1, null); // failed + 置闸
      expect(deliverer.getMessage(firstId)).toMatchObject({ status: 'failed', stalled: true });

      // 积压行被闸挡着（peer 在场也不投）
      registered = false;
      await deliverer.send({
        toSessionId: SESSION_ID,
        text: 'queued behind dismissed',
        mode: 'prompt',
        fromKind: 'dashboard',
        oneWay: true,
      });
      expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(1);
      registered = true;
      await deliverer.flushSession(SESSION_ID);
      expect(fake.calls).toHaveLength(1);

      expect(deliverer.dismiss(SESSION_ID, 'no-such-message')).toMatchObject({
        ok: false,
        status: 404,
      });

      // 删掉成因行：行没了、闸解了、积压经自续冲洗投出
      expect(deliverer.dismiss(SESSION_ID, firstId)).toMatchObject({ ok: true });
      expect(deliverer.getMessage(firstId)).toBeNull();
      expect(deliverer.listVisible(SESSION_ID).map((m) => m.id)).not.toContain(firstId);
      expect(busEvents).toContainEqual(
        expect.objectContaining({ kind: 'message.dismissed', messageId: firstId }),
      );
      await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
      expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
      fake.children[1]!.emit('exit', 0, null);
    });

    it('在飞的投递行也能强制移除：行当场消失、迟到的落定不写回，积压续排', async () => {
      const fake = createFakeSpawn();
      let registered = true;
      const { surface } = relaySurface(() => (registered ? { name: PEER_NAME } : null));
      const deliverer = new MessageDeliverer(
        makeDeps({
          spawnImpl: fake.spawnImpl,
          surfaceFor: () => surface,
          bin: 'fake-relay',
          flushGapMs: 0,
        }),
      );
      pushEvent(SESSION_ID, 'Stop');

      const sent = await deliverer.send({
        toSessionId: SESSION_ID,
        text: 'in-flight force removal',
        mode: 'prompt',
        fromKind: 'dashboard',
        oneWay: true,
      });
      const id = (sent as { messageId: string }).messageId;
      expect(deliverer.getMessage(id)!.status).toBe('delivering');

      // 投递还悬着（子进程没退）+ 后面压着一条：队头就是它，闸也在它身上
      registered = false;
      await deliverer.send({
        toSessionId: SESSION_ID,
        text: 'queued behind stuck head',
        mode: 'prompt',
        fromKind: 'dashboard',
        oneWay: true,
      });
      expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(1);

      expect(deliverer.dismiss(SESSION_ID, id)).toMatchObject({ ok: true });
      expect(deliverer.getMessage(id)).toBeNull();
      expect(busEvents).toContainEqual(
        expect.objectContaining({ kind: 'message.dismissed', messageId: id }),
      );

      // 迟到的落定：行不被写回来、也不再置闸
      fake.children[0]!.emit('exit', 0, null);
      expect(deliverer.getMessage(id)).toBeNull();
      expect(deliverer.listVisible(SESSION_ID).map((m) => m.id)).not.toContain(id);

      // 积压续排（下一条各自重新布防回执闸）
      registered = true;
      await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
      fake.children[1]!.emit('exit', 0, null);
      expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
    });

    it('投递卡死时强制移除队头：泵闸一并解除，后面那条接着发', async () => {
      const fake = createFakeSpawn();
      const { surface } = relaySurface(() => null); // 无 peer → 走层② 终端
      let available = false;
      const sendText = vi.fn().mockImplementation((_pane: string, text: string) =>
        text.includes('stuck head') ? new Promise<void>(() => {}) : Promise.resolve(),
      );
      const terminal: PromptTerminal = {
        available: () => available,
        listPanes: vi.fn().mockResolvedValue([{ id: '7', title: null, cwd: null }]),
        locatePane: vi.fn(async () => '7'),
        sendText,
        sendKeys: vi.fn(),
        closePane: vi.fn(),
      };
      const deliverer = new MessageDeliverer(
        makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, terminal, flushGapMs: 0 }),
      );
      pushEvent(SESSION_ID, 'Stop');

      const ids: string[] = [];
      for (const text of ['stuck head body', 'tail body']) {
        const sent = await deliverer.send({
          toSessionId: SESSION_ID,
          text,
          mode: 'prompt',
          fromKind: 'dashboard',
          oneWay: true,
        });
        ids.push((sent as { messageId: string }).messageId);
      }
      expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(2);

      // 通道恢复 → 冲洗：首行贴进框后后端不回，这一拍就挂在 await 上
      available = true;
      deliverer.notePaneEnv(SESSION_ID, { WEZTERM_PANE: '7' });
      void deliverer.flushSession(SESSION_ID);
      await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
      expect(deliverer.getMessage(ids[0]!)!.status).toBe('delivering');

      // 强制移除卡住的队头：行没了、泵闸解除，余下的续排
      expect(deliverer.dismiss(SESSION_ID, ids[0]!)).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(2));
      expect(sendText.mock.calls[1]![1]).toContain('tail body');
      expect(deliverer.getMessage(ids[0]!)).toBeNull();
      expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
    });

    it('删队列待递送行 = 取消发送：行从队列与视图消失、索引清干净（再冲洗也不投）', async () => {
      const fake = createFakeSpawn();
      let registered = false; // peer 未登记 → 入队 pending
      const { surface } = relaySurface(() => (registered ? { name: PEER_NAME } : null));
      const deliverer = new MessageDeliverer(
        makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
      );
      pushEvent(SESSION_ID, 'Stop');

      const sent = await deliverer.send({
        toSessionId: SESSION_ID,
        text: 'queued then cancelled',
        mode: 'prompt',
        fromKind: 'dashboard',
        oneWay: true,
      });
      const id = (sent as { messageId: string }).messageId;
      expect(sent).toMatchObject({ ok: true, status: 'pending' });
      expect(deliverer.getMessage(id)).toBeNull(); // pending 只活在 promptbox 文件里
      expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(1);

      expect(deliverer.dismiss(SESSION_ID, id)).toMatchObject({ ok: true });
      expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
      expect(deliverer.listVisible(SESSION_ID).map((m) => m.id)).not.toContain(id);
      expect(deliverer.hasQueued(SESSION_ID)).toBe(false);
      expect(busEvents).toContainEqual(
        expect.objectContaining({ kind: 'message.dismissed', messageId: id, sessionId: SESSION_ID }),
      );

      // 通道回来了也不投（行已不在队列）
      registered = true;
      await deliverer.flushSession(SESSION_ID);
      expect(fake.calls).toHaveLength(0);
    });

    it('冲洗读到之后被删的行不投出（删除是取消发送，不是「读到时还在」）', async () => {
      const fake = createFakeSpawn();
      const { surface } = relaySurface(() => null); // 无 peer → 走层② 终端
      let available = false;
      let release!: () => void;
      const blocked = new Promise<void>((r) => {
        release = r;
      });
      const sendText = vi.fn().mockResolvedValue(undefined);
      const terminal: PromptTerminal = {
        available: () => available,
        listPanes: vi.fn().mockResolvedValue([{ id: '7', title: null, cwd: null }]),
        locatePane: vi.fn(async () => {
          await blocked;
          return '7';
        }),
        sendText,
        sendKeys: vi.fn(),
        closePane: vi.fn(),
      };
      const deliverer = new MessageDeliverer(
        makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, terminal, flushGapMs: 0 }),
      );
      pushEvent(SESSION_ID, 'Stop');

      const ids: string[] = [];
      for (const text of ['flush first', 'flush second']) {
        const sent = await deliverer.send({
          toSessionId: SESSION_ID,
          text,
          mode: 'prompt',
          fromKind: 'dashboard',
          oneWay: true,
        });
        ids.push((sent as { messageId: string }).messageId);
      }
      expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(2);

      // 通道恢复 → 冲洗（本轮把两行都读进手里），首行定位被卡住
      available = true;
      deliverer.notePaneEnv(SESSION_ID, { WEZTERM_PANE: '7' });
      const flushing = deliverer.flushSession(SESSION_ID);
      expect(deliverer.dismiss(SESSION_ID, ids[1]!)).toMatchObject({ ok: true });
      release();
      await flushing;

      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText.mock.calls[0]![1]).toContain('flush first');
      expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
    });
  });

  describe('answer（阻塞问答作答）', () => {
    const paneFixture = (panes: Array<{ id: string; title: string | null; cwd: string | null }>) => {
      const sendKeys = vi.fn().mockResolvedValue(undefined);
      const terminal: PromptTerminal = {
        available: () => true,
        listPanes: vi.fn().mockResolvedValue(panes),
        sendText: vi.fn(),
        sendKeys,
        closePane: vi.fn(),
      };
      return { terminal, sendKeys };
    };

    it('选项键序逐个原子打进 pane（spinner 前缀含 ◐ 输入等待态也能匹配）', async () => {
      db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run(
        '◐ msg-target',
        SESSION_ID,
      );
      const { terminal, sendKeys } = paneFixture([
        { id: 'pane-1', title: '◐ msg-target', cwd: PROJECT_PATH },
      ]);
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));
      pushEvent(SESSION_ID, 'Stop');

      await expect(deliverer.answer(SESSION_ID, ['1'])).resolves.toEqual({ ok: true });
      expect(sendKeys).toHaveBeenCalledWith('pane-1', '1');
      // 多问一次提交：数字 / Tab / 下移 / 提交数字各自成一次击键写（宿主把同一批
      // 多个文本字符当一次粘贴，拼在一起会被当筛选字串）
      sendKeys.mockClear();
      await expect(
        deliverer.answer(SESSION_ID, ['2', '\t', '\x1b[B', '\x1b[B', '自定', '\t', '\r', '\t', '1']),
      ).resolves.toEqual({ ok: true });
      expect(sendKeys.mock.calls.map((c) => c[1])).toEqual([
        '2',
        '\t',
        '\x1b[B',
        '\x1b[B',
        '自定',
        '\t',
        '\r',
        '\t',
        '1',
      ]);
    });

    it('原子白名单：非「宿主键 / 无控制字符文本」一律 400（作答面不是键序注入通道）', async () => {
      const { terminal, sendKeys } = paneFixture([]);
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));
      for (const atoms of [[], ['12'], ['abc'], ['\r\r'], ['1\n'], ['\x1b[D'], ['1', 'a\rb']]) {
        // 注：'12' / 'abc' 本身是无控制字符文本、合法作**文本原子**，但落在键位
        // （首个原子）就是往会话打任意文本 → 400。
        const result = await deliverer.answer(SESSION_ID, atoms);
        expect(result, JSON.stringify(atoms)).toMatchObject({ ok: false, status: 400 });
      }
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it('文本原子：中文/数字文本放行；内嵌控制字符仍 400', async () => {
      db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
      const { terminal, sendKeys } = paneFixture([
        { id: 'pane-1', title: '◐ msg-target', cwd: PROJECT_PATH },
      ]);
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));

      await expect(deliverer.answer(SESSION_ID, ['4', '自己写一个', '\r'])).resolves.toEqual({
        ok: true,
      });
      expect(sendKeys.mock.calls.map((c) => c[1])).toEqual(['4', '自己写一个', '\r']);
      for (const atoms of [['4', 'a\rb', '\r'], ['4', '\u001b[D', '\r']]) {
        await expect(deliverer.answer(SESSION_ID, atoms)).resolves.toMatchObject({
          ok: false,
          status: 400,
        });
      }
    });

    it('会话不存在 404；pane 找不到 409（窗口没开/歧义）', async () => {
      const { terminal } = paneFixture([]);
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));
      await expect(deliverer.answer('sess-ghost', ['1'])).resolves.toMatchObject({
        ok: false,
        status: 404,
      });
      db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
      await expect(deliverer.answer(SESSION_ID, ['1'])).resolves.toMatchObject({
        ok: false,
        status: 409,
      });
    });

    it('无终端通道 409（层② 是作答的唯一通道）', async () => {
      const deliverer = new MessageDeliverer(makeDeps());
      await expect(deliverer.answer(SESSION_ID, ['1'])).resolves.toMatchObject({
        ok: false,
        status: 409,
      });
    });
  });

  describe('pane env 认领冲突（fork 继承同一份 env）', () => {
    const ENV = { WEZTERM_PANE: '0', WEZTERM_UNIX_SOCKET: '/tmp/gui-sock-1' };

    it('同一份 env 只归先到者：后到者记冲突，击键如实 409，绝不打进别人的终端', async () => {
      const sendKeys = vi.fn().mockResolvedValue(undefined);
      const terminal: PromptTerminal = {
        available: () => true,
        listPanes: vi.fn().mockResolvedValue([{ id: 'pane-0', title: null, cwd: null }]),
        sendText: vi.fn(),
        sendKeys,
        locatePane: vi.fn().mockResolvedValue('pane-0'),
        closePane: vi.fn(),
      };
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));
      pushEvent(SESSION_ID, 'Stop');
      pushEvent(CODEX_SESSION, 'Stop'); // 只是让两行都有事件（lastSeenAt 新鲜）

      deliverer.notePaneEnv(SESSION_ID, ENV);
      deliverer.notePaneEnv(CODEX_SESSION, ENV);

      expect(deliverer.paneEnvConflictOf(SESSION_ID)).toBeNull();
      expect(deliverer.paneEnvConflictOf(CODEX_SESSION)).toBe(SESSION_ID);

      await expect(deliverer.interrupt(CODEX_SESSION)).resolves.toMatchObject({
        ok: false,
        status: 409,
      });
      expect(sendKeys).not.toHaveBeenCalled();

      // 先到者照常
      await expect(deliverer.interrupt(SESSION_ID)).resolves.toMatchObject({ ok: true });
      expect(sendKeys).toHaveBeenCalledTimes(1);
    });

    it('前持有者静默超过让位窗口 → 后到者接管（旧会话确实退出了）', async () => {
      const sendKeys = vi.fn().mockResolvedValue(undefined);
      const terminal: PromptTerminal = {
        available: () => true,
        listPanes: vi.fn().mockResolvedValue([{ id: 'pane-0', title: null, cwd: null }]),
        sendText: vi.fn(),
        sendKeys,
        locatePane: vi.fn().mockResolvedValue('pane-0'),
        closePane: vi.fn(),
      };
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));
      pushEvent(SESSION_ID, 'Stop');
      pushEvent(CODEX_SESSION, 'Stop');
      deliverer.notePaneEnv(SESSION_ID, ENV);

      // 把先到者的 lastSeenAt 推回让位窗口之外
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE session_id = ?').run(
        new Date(Date.now() - 10 * 60_000).toISOString(),
        SESSION_ID,
      );
      deliverer.notePaneEnv(CODEX_SESSION, ENV);

      expect(deliverer.paneEnvConflictOf(CODEX_SESSION)).toBeNull();
      await expect(deliverer.interrupt(CODEX_SESSION)).resolves.toMatchObject({ ok: true });
    });
  });

  describe('interrupt（停止按钮 → 一记 ESC）', () => {
    const paneFixture = (panes: Array<{ id: string; title: string | null; cwd: string | null }>) => {
      const sendKeys = vi.fn().mockResolvedValue(undefined);
      const terminal: PromptTerminal = {
        available: () => true,
        listPanes: vi.fn().mockResolvedValue(panes),
        sendText: vi.fn(),
        sendKeys,
        closePane: vi.fn(),
      };
      return { terminal, sendKeys };
    };

    it('屏上已显示中断 → 只打一记 ESC（连打两次在 claude 里是历史回退菜单）', async () => {
      db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
      const { terminal, sendKeys } = paneFixture([
        { id: 'pane-1', title: '✻ msg-target', cwd: PROJECT_PATH },
      ]);
      const deliverer = new MessageDeliverer(
        makeDeps({
          terminal: { ...terminal, getPaneText: vi.fn(async () => 'Interrupted · What should Claude do instead?') },
          interruptVerifyMs: 0,
        }),
      );

      await expect(deliverer.interrupt(SESSION_ID)).resolves.toEqual({
        ok: true,
        paneId: 'pane-1',
        sent: true,
        confirmed: true,
      });
      expect(sendKeys.mock.calls).toEqual([['pane-1', '\x1b']]);
    });

    it('宿主吞掉 ESC（屏上没出现中断）→ 换键补一记 Ctrl+C，不再发第二记 ESC', async () => {
      db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
      const { terminal, sendKeys } = paneFixture([
        { id: 'pane-1', title: '✻ msg-target', cwd: PROJECT_PATH },
      ]);
      const deliverer = new MessageDeliverer(
        makeDeps({
          terminal: {
            ...terminal,
            getPaneText: vi.fn(async () => '✻ Discombobulating… (29m 15s) · esc to interrupt'),
          },
          interruptVerifyMs: 0,
        }),
      );

      // 补完键屏上仍挂着 `esc to interrupt`：键被吞了，如实答没停
      await expect(deliverer.interrupt(SESSION_ID)).resolves.toMatchObject({
        ok: true,
        sent: true,
        confirmed: false,
      });
      expect(sendKeys.mock.calls).toEqual([
        ['pane-1', '\x1b'],
        ['pane-1', '\x03'],
      ]);
    });

    it('补完 Ctrl+C 屏上落到中断态 → confirmed:true（不因第一拍没停就报没停）', async () => {
      db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
      const { terminal, sendKeys } = paneFixture([
        { id: 'pane-1', title: '✻ msg-target', cwd: PROJECT_PATH },
      ]);
      const screens = ['✻ Discombobulating… (esc to interrupt)', 'Interrupted · What should Claude do instead?'];
      const getPaneText = vi.fn(async () => screens.shift() ?? '');
      const deliverer = new MessageDeliverer(
        makeDeps({ terminal: { ...terminal, getPaneText }, interruptVerifyMs: 0 }),
      );

      await expect(deliverer.interrupt(SESSION_ID)).resolves.toMatchObject({ ok: true, confirmed: true });
      expect(sendKeys.mock.calls).toEqual([
        ['pane-1', '\x1b'],
        ['pane-1', '\x03'],
      ]);
    });

    it('补完键屏上既无 esc to interrupt 也无 · done（工具间隙）→ 仍答没停', async () => {
      // 2026-10-30 实测 c2271f5b 的漏判：工具间隙那一拍屏上没有 esc 提示，
      // 「没挂提示」被当成了已停，实际工具又继续跑了 90 秒——只认正面证据。
      db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
      const { terminal, sendKeys } = paneFixture([
        { id: 'pane-1', title: '✻ msg-target', cwd: PROJECT_PATH },
      ]);
      const getPaneText = vi.fn(async () => '✻ Thinking…');
      const deliverer = new MessageDeliverer(
        makeDeps({ terminal: { ...terminal, getPaneText }, interruptVerifyMs: 0 }),
      );

      await expect(deliverer.interrupt(SESSION_ID)).resolves.toMatchObject({ ok: true, confirmed: false });
      expect(sendKeys.mock.calls).toEqual([
        ['pane-1', '\x1b'],
        ['pane-1', '\x03'],
      ]);
    });

    it('补完键状态行落到 · done（回合收尾）→ confirmed:true', async () => {
      db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
      const { terminal, sendKeys } = paneFixture([
        { id: 'pane-1', title: '✻ msg-target', cwd: PROJECT_PATH },
      ]);
      const screens = ['✻ Discombobulating… (esc to interrupt)', '✻ Cooked for 3m 10s · done 0:39'];
      const getPaneText = vi.fn(async () => screens.shift() ?? '');
      const deliverer = new MessageDeliverer(
        makeDeps({ terminal: { ...terminal, getPaneText }, interruptVerifyMs: 0 }),
      );

      await expect(deliverer.interrupt(SESSION_ID)).resolves.toMatchObject({ ok: true, confirmed: true });
    });

    it('读不到屏幕（后端无读屏能力）→ 不补打，不凭猜打第二记', async () => {
      db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
      const { terminal, sendKeys } = paneFixture([
        { id: 'pane-1', title: '✻ msg-target', cwd: PROJECT_PATH },
      ]);
      const deliverer = new MessageDeliverer(makeDeps({ terminal, interruptVerifyMs: 0 }));

      // 判不了就往好处答：不凭猜报「没停」
      await expect(deliverer.interrupt(SESSION_ID)).resolves.toMatchObject({
        ok: true,
        sent: true,
        confirmed: true,
      });
      expect(sendKeys.mock.calls).toEqual([['pane-1', '\x1b']]);
    });

    it('补打参数已退役：interrupt 只收 sessionId，env 命中即用（locator 优先、标题+cwd 回落）', async () => {
      db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
      const { terminal, sendKeys } = paneFixture([
        { id: 'pane-1', title: '✻ msg-target', cwd: PROJECT_PATH },
      ]);
      const locatePane = vi.fn(async () => 'stale-pane');
      const deliverer = new MessageDeliverer(
        makeDeps({
          terminal: {
            ...terminal,
            locatePane,
            getPaneText: vi.fn(async () => 'Interrupted'),
          },
          interruptVerifyMs: 0,
        }),
      );
      deliverer.notePaneEnv(SESSION_ID, { WEZTERM_PANE: '3' });

      await expect(deliverer.interrupt(SESSION_ID)).resolves.toMatchObject({ paneId: 'stale-pane' });
      expect(locatePane).toHaveBeenCalledTimes(1);
      expect(sendKeys).toHaveBeenCalledTimes(1);
    });

    it('与作答同一套落点判定：会话没有 404 / 无终端通道 409 / pane 找不到 409', async () => {
      const { terminal, sendKeys } = paneFixture([]);
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));
      await expect(deliverer.interrupt('sess-ghost')).resolves.toMatchObject({
        ok: false,
        status: 404,
      });
      await expect(deliverer.interrupt(SESSION_ID)).resolves.toMatchObject({
        ok: false,
        status: 409,
        error: '找不到会话所在的终端窗口——这个会话所在终端没有可用的远程击键通道',
      });
      await expect(new MessageDeliverer(makeDeps()).interrupt(SESSION_ID)).resolves.toMatchObject({
        ok: false,
        status: 409,
        error: '终端通道未装配，无法远程击键',
      });
      expect(sendKeys).not.toHaveBeenCalled();
    });
  });

  describe('closePane（关 pane = 会话生命周期收尾）', () => {
    const paneFixture = (panes: Array<{ id: string; title: string | null; cwd: string | null }>) => {
      const closePane = vi.fn().mockResolvedValue(undefined);
      const terminal: PromptTerminal = {
        available: () => true,
        listPanes: vi.fn().mockResolvedValue(panes),
        sendText: vi.fn(),
        sendKeys: vi.fn(),
        closePane,
      };
      return { terminal, closePane };
    };

    it('按落点关掉那一个 pane（会话行与对话照常保留，不碰库）', async () => {
      db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
      const { terminal, closePane } = paneFixture([
        { id: 'pane-1', title: '✻ msg-target', cwd: PROJECT_PATH },
      ]);
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));

      await expect(deliverer.closePane(SESSION_ID)).resolves.toEqual({ ok: true });
      expect(closePane.mock.calls).toEqual([['pane-1']]);
      // 会话行与它的对话照常保留（那是历史）——关 pane 只把它从「活着」里摘出去
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?').get(SESSION_ID),
      ).toMatchObject({ n: 1 });
    });

    it('与中断同一套落点判定：会话没有 404 / 无终端通道 409 / pane 找不到 409', async () => {
      const { terminal, closePane } = paneFixture([]);
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));
      await expect(deliverer.closePane('sess-ghost')).resolves.toMatchObject({
        ok: false,
        status: 404,
      });
      await expect(deliverer.closePane(SESSION_ID)).resolves.toMatchObject({
        ok: false,
        status: 409,
        error: '找不到会话所在的终端窗口——这个会话所在终端没有可用的远程关闭通道',
      });
      await expect(new MessageDeliverer(makeDeps()).closePane(SESSION_ID)).resolves.toMatchObject({
        ok: false,
        status: 409,
        error: '终端通道未装配，无法远程关闭',
      });
      expect(closePane).not.toHaveBeenCalled();
    });

    it('关不掉（后端没这个通道）如实 409，不假装关掉了', async () => {
      db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
      const terminal: PromptTerminal = {
        available: () => true,
        listPanes: vi.fn().mockResolvedValue([
          { id: 'pane-1', title: '✻ msg-target', cwd: PROJECT_PATH },
        ]),
        sendText: vi.fn(),
        sendKeys: vi.fn(),
        closePane: vi
          .fn()
          .mockRejectedValue(new Error('Terminal preset "wt" cannot close an open pane — pick wezterm in settings')),
      };
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));
      await expect(deliverer.closePane(SESSION_ID)).resolves.toMatchObject({
        ok: false,
        status: 409,
        error: 'Terminal preset "wt" cannot close an open pane — pick wezterm in settings',
      });
    });
  });

  describe('cycleMode / setModel（会话控制面）', () => {
    const paneFixture = () => {
      const sendKeys = vi.fn().mockResolvedValue(undefined);
      const sendText = vi.fn().mockResolvedValue(undefined);
      const terminal: PromptTerminal = {
        available: () => true,
        listPanes: vi.fn().mockResolvedValue([{ id: 'pane-1', title: '✻ msg-target', cwd: PROJECT_PATH }]),
        sendText,
        sendKeys,
        closePane: vi.fn(),
      };
      return { terminal, sendKeys, sendText };
    };

    beforeEach(() => {
      db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    });

    it('cycleMode 恒打一记 Shift+Tab——键序固定死在服务端，不当参数收', async () => {
      const { terminal, sendKeys } = paneFixture();
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));

      await expect(deliverer.cycleMode(SESSION_ID)).resolves.toEqual({ ok: true });
      expect(sendKeys.mock.calls).toEqual([['pane-1', '\x1b[Z']]);
    });

    it('setModel 走 sendText（整行粘贴 + 提交）而不是裸键——`/` 会唤起斜杠菜单吃掉参数', async () => {
      const { terminal, sendText, sendKeys } = paneFixture();
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));

      await expect(deliverer.setModel(SESSION_ID, 'sonnet')).resolves.toEqual({ ok: true });
      expect(sendText.mock.calls).toEqual([['pane-1', '/model sonnet']]);
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it('模型名形态不合法当场 400，键一个都不打（名字进命令行，必须堵住注入面）', async () => {
      const { terminal, sendText, sendKeys } = paneFixture();
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));

      // 首尾空白先剥掉（那是输入噪音，进命令行的只有剥完的那个词）
      await expect(deliverer.setModel(SESSION_ID, '  sonnet  ')).resolves.toEqual({ ok: true });
      expect(sendText.mock.calls).toEqual([['pane-1', '/model sonnet']]);

      // 含空白的词 / 控制字符（ESC 不是空白，只用 \S 会漏）/ 空 / 超长
      for (const bad of [
        'a\r\nb',
        'x\ry',
        'a\x1bb',
        'a\x00b',
        'a\x7fb',
        '',
        '   ',
        'foo bar',
        'x'.repeat(129),
      ]) {
        await expect(deliverer.setModel(SESSION_ID, bad)).resolves.toMatchObject({ ok: false, status: 400 });
      }
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it('与中断同一套落点判定：会话没有 404 / pane 找不到 409', async () => {
      const { terminal } = paneFixture();
      vi.mocked(terminal.listPanes).mockResolvedValue([]);
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));

      await expect(deliverer.cycleMode('sess-ghost')).resolves.toMatchObject({ ok: false, status: 404 });
      await expect(deliverer.setModel('sess-ghost', 'sonnet')).resolves.toMatchObject({
        ok: false,
        status: 404,
      });
      await expect(deliverer.cycleMode(SESSION_ID)).resolves.toMatchObject({ ok: false, status: 409 });
      await expect(deliverer.setModel(SESSION_ID, 'sonnet')).resolves.toMatchObject({
        ok: false,
        status: 409,
      });
    });

    it('setEffort 走 sendText（`/effort <档位>`），档位过词表白名单', async () => {
      const { terminal, sendText, sendKeys } = paneFixture();
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));
      pushEvent(SESSION_ID, 'Stop'); // harness 归属 = 最新事件 source

      await expect(deliverer.setEffort(SESSION_ID, 'high')).resolves.toEqual({ ok: true });
      expect(sendText.mock.calls).toEqual([['pane-1', '/effort high']]);
      expect(sendKeys).not.toHaveBeenCalled();

      // 首尾空白剥掉（输入噪音）
      await expect(deliverer.setEffort(SESSION_ID, '  low  ')).resolves.toEqual({ ok: true });
      expect(sendText.mock.calls[1]).toEqual(['pane-1', '/effort low']);
    });

    it('setEffort 档位不在词表（或会话无 harness 归属）→ 400，键一个都不打', async () => {
      const { terminal, sendText, sendKeys } = paneFixture();
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));

      // 没有任何事件 = harness 归属判不出，词表为空
      for (const bad of ['ultra', 'auto', '', 'a\r\nb', 'x\x1by', 'high low']) {
        await expect(deliverer.setEffort(SESSION_ID, bad)).resolves.toMatchObject({ ok: false, status: 400 });
      }
      expect(sendText).not.toHaveBeenCalled();
      expect(sendKeys).not.toHaveBeenCalled();

      // 有 harness 归属后，表外档位照样 400
      pushEvent(SESSION_ID, 'Stop');
      await expect(deliverer.setEffort(SESSION_ID, 'ultra')).resolves.toMatchObject({ ok: false, status: 400 });
      expect(sendText).not.toHaveBeenCalled();
    });

    it('setEffort 与中断同一套落点判定：会话没有 404 / pane 找不到 409', async () => {
      const { terminal } = paneFixture();
      vi.mocked(terminal.listPanes).mockResolvedValue([]);
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));
      pushEvent(SESSION_ID, 'Stop');

      await expect(deliverer.setEffort('sess-ghost', 'high')).resolves.toMatchObject({ ok: false, status: 404 });
      await expect(deliverer.setEffort(SESSION_ID, 'high')).resolves.toMatchObject({ ok: false, status: 409 });
    });
  });

  // ---- 附件随 prompt（harness `attach` 对齐面）：投递文本现合成、回执放宽 ----

  /** 与 claude 同形态：附件引用 = 裸绝对路径，每个一行，落在用户原文之后。 */
  const CLAUDE_ATTACH = {
    kinds: ['image', 'file'] as const,
    composePrompt: (text: string, files: readonly { path: string }[]) =>
      text ? `${text}\n\n${files.map((i) => i.path).join('\n')}` : files.map((i) => i.path).join('\n'),
  };

  const oneImage = (path = 'D:/up/aa.png') => [
    { id: 'a'.repeat(64), name: 'aa.png', mediaType: 'image/png', path },
  ];

  const surfaceWithImages = (resolve: (sessionId: string) => { name: string } | null = () => ({ name: PEER_NAME })) => {
    const base = relaySurface(resolve);
    return { ...base, surface: { ...base.surface, attach: CLAUDE_ATTACH } };
  };

  it('带图投递：harness 的 attach 为 null → 409，不发号不投递', async () => {
    const fake = createFakeSpawn();
    const { surface } = relaySurface(); // 没有 attach 面
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    pushEvent(SESSION_ID, 'Stop');
    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'hi',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
      attachments: oneImage(),
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(fake.calls).toHaveLength(0);
  });

  const oneFile = (path = 'D:/up/notes.md') => [
    { id: 'b'.repeat(64), name: 'notes.md', mediaType: 'text/markdown', path },
  ];

  it('附件类型按 harness 的 kinds 判：只收图的 harness 带文件 → 409', async () => {
    const { surface } = relaySurface();
    const deliverer = new MessageDeliverer(
      makeDeps({ surfaceFor: () => ({ ...surface, attach: { ...CLAUDE_ATTACH, kinds: ['image'] } }) }),
    );
    pushEvent(SESSION_ID, 'Stop');
    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '读一下',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
      attachments: oneFile(),
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as { error: string }).error).toContain('file');
  });

  it('普通文件不逼层②：只有图才终端优先（文件路径走 socket 也由模型自己读）', async () => {
    const path = uniqueInboxPath();
    let got = '';
    const inbox = await fakeInboxAt(path, (t) => {
      got = t;
    });
    const { surface } = surfaceWithImages();
    const deliverer = new MessageDeliverer(
      makeDeps({
        surfaceFor: () => ({ ...surface, attach: { ...CLAUDE_ATTACH, kinds: ['file'] } }),
        terminal: {
          available: () => true,
          listPanes: async () => [{ id: 'pane-1', title: 'msg-target', cwd: PROJECT_PATH }],
          sendText: vi.fn(),
          sendKeys: vi.fn(),
          closePane: vi.fn(),
        },
      }),
    );
    pushEvent(SESSION_ID, 'Stop');
    deliverer.noteInboxSocket(SESSION_ID, { socket: path, token: 'tok-1' });
    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '读一下',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
      attachments: oneFile(),
    });
    expect(result).toMatchObject({ ok: true, status: 'delivered' });
    expect(deliverer.getMessage((result as { messageId: string }).messageId)).toMatchObject({ via: 'socket' });
    expect(got).toContain('D:/up/notes.md');
    inbox.close();
  });

  it('带图投递：投递文本 = 原文 + 路径引用，msg.text 仍是用户原文', async () => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const { surface } = surfaceWithImages();
    const deliverer = new MessageDeliverer(
      makeDeps({
        surfaceFor: () => surface,
        terminal: {
          available: () => true,
          listPanes: async () => [{ id: 'pane-1', title: 'msg-target', cwd: PROJECT_PATH }],
          sendText,
          sendKeys: vi.fn(),
          closePane: vi.fn(),
        },
      }),
    );
    pushEvent(SESSION_ID, 'Stop');
    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '看看这个',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
      attachments: oneImage(),
    });
    expect(sendText).toHaveBeenCalledWith('pane-1', '看看这个\n\nD:/up/aa.png');
    const id = (result as { messageId: string }).messageId;
    expect(deliverer.getMessage(id)).toMatchObject({ text: '看看这个' });
    expect(deliverer.getMessage(id)?.attachments?.[0]?.path).toBe('D:/up/aa.png');
  });

  it('带图层② 优先：socket 在场也走终端粘贴（只有它能把路径转成 image block）', async () => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    const path = uniqueInboxPath();
    let got = '';
    const inbox = await fakeInboxAt(path, (t) => {
      got = t;
    });
    const sendText = vi.fn().mockResolvedValue(undefined);
    const { surface } = surfaceWithImages();
    const deliverer = new MessageDeliverer(
      makeDeps({
        surfaceFor: () => surface,
        terminal: {
          available: () => true,
          listPanes: async () => [{ id: 'pane-1', title: 'msg-target', cwd: PROJECT_PATH }],
          sendText,
          sendKeys: vi.fn(),
          closePane: vi.fn(),
        },
      }),
    );
    pushEvent(SESSION_ID, 'Stop');
    deliverer.noteInboxSocket(SESSION_ID, { socket: path, token: 'tok-1' });

    const withImage = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '看图',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
      attachments: oneImage(),
    });
    expect(sendText).toHaveBeenCalledWith('pane-1', '看图\n\nD:/up/aa.png');
    expect(deliverer.getMessage((withImage as { messageId: string }).messageId)).toMatchObject({ via: 'terminal' });

    const textOnly = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '纯文本仍走 socket',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    // 带图那条还压着队头（终端层要等它的回执）：纯文本这条排到队尾，
    // 不许越过它先直投——到达顺序必须与发送顺序一致
    expect(textOnly).toMatchObject({ ok: true, status: 'pending' });
    const textId = (textOnly as { messageId: string }).messageId;
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toBe('');
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(1);

    // 回执到 → 撤防 → 队尾这条按原层序投（有 socket 就走 socket）
    deliverer.onSessionPrompt(SESSION_ID, '看图');
    await deliverer.flushSession(SESSION_ID);
    expect(deliverer.getMessage(textId)).toMatchObject({ via: 'socket' });
    expect(got).toContain('纯文本仍走 socket');
    expect(got).not.toContain('D:/up/aa.png');
    inbox.close();
  });

  it('队列行随附图落盘：重启后冲洗仍按现 harness 面重合成', async () => {
    const { surface } = surfaceWithImages(() => null); // 无终端、无 peer → 只能入队
    const deliverer = new MessageDeliverer(makeDeps({ surfaceFor: () => surface }));
    pushEvent(SESSION_ID, 'Stop');
    await deliverer.send({
      toSessionId: SESSION_ID,
      text: '排队这条',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
      attachments: oneImage(),
    });
    const queued = readPromptbox(hooksDir, TOKEN).filter((e) => e.sessionId === SESSION_ID);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.attachments?.[0]).toMatchObject({ path: 'D:/up/aa.png', name: 'aa.png' });
    expect(queued[0]?.text).toBe('排队这条');
  });

  it('纯图发送：UPS 的 prompt 是空的也算回执，且把图 id 交出来挂事件', async () => {
    const fake = createFakeSpawn();
    const { surface } = surfaceWithImages();
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    pushEvent(SESSION_ID, 'Stop');
    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
      attachments: oneImage(),
    });
    const id = (result as { messageId: string }).messageId;
    expect(deliverer.onSessionPrompt(SESSION_ID, '')).toEqual(['a'.repeat(64)]);
    expect(deliverer.getMessage(id)?.acked).toBe(true);
  });

  it('带图的消息比对放宽一档：粘贴处理把多行 chunk 连成一行也能认领', async () => {
    const fake = createFakeSpawn();
    const { surface } = surfaceWithImages();
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    pushEvent(SESSION_ID, 'Stop');
    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '第一行正文\n第二行正文（够长）',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
      attachments: oneImage(),
    });
    const id = (result as { messageId: string }).messageId;
    // claude 粘贴处理会把多行 chunk 用空串连起来——回执原文与 msg.text 差在空白上
    deliverer.onSessionPrompt(SESSION_ID, '第一行正文第二行正文（够长）');
    expect(deliverer.getMessage(id)?.acked).toBe(true);
  });

  it('占位内联的图片路径被宿主剥掉换 [Image #N]：剥路径后仍能认领（web 胶囊原地展开）', async () => {
    const fake = createFakeSpawn();
    const { surface } = surfaceWithImages();
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    pushEvent(SESSION_ID, 'Stop');
    const imgPath = 'D:/up/aa.png';
    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: `看看这张\n${imgPath}\n后续说明（够长）`,
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
      attachments: oneImage(imgPath),
    });
    const id = (result as { messageId: string }).messageId;
    // 宿主粘贴处理器把独立成行的图片路径剥掉换成记号（且恒提到消息开头）：
    // UPS 原文里路径没了，只剩 [Image #N] + 剩余文本——不剥路径就永远比不中
    deliverer.onSessionPrompt(SESSION_ID, '[Image #1]看看这张 后续说明（够长）');
    expect(deliverer.getMessage(id)?.acked).toBe(true);
  });

  it('纯图发送不会被无关的非空 UPS 认领（认领条件 = 空 prompt）', async () => {
    const fake = createFakeSpawn();
    const { surface } = surfaceWithImages();
    const deliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
    );
    pushEvent(SESSION_ID, 'Stop');
    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: '',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
      attachments: oneImage(),
    });
    const id = (result as { messageId: string }).messageId;
    expect(deliverer.onSessionPrompt(SESSION_ID, '我自己另敲的一句话')).toEqual([]);
    expect(deliverer.getMessage(id)?.acked).toBeUndefined();
  });
});

describe('MessageDeliverer.askSideQuestion 读屏通道（codex = /side）', () => {
  let db: ReturnType<typeof openDatabase>;
  let sessions: SessionRepository;
  let events: HookEventRepository;
  let bus: HookEventBus;
  let busEvents: HookBusMessage[];
  let projectId: number;
  let hooksDir: string;

  const pushEvent = (sessionId: string, eventType: string, source: 'claude' | 'codex' = 'codex') =>
    events.insert({ projectId, source, eventType, sessionId, payload: '{}' });

  const makeDeps = (extra: Partial<MessageDelivererDeps> = {}): MessageDelivererDeps => ({
    sessions,
    projects: new ProjectRepository(db),
    hookEvents: events,
    bus,
    hooksDir,
    ...extra,
  });

  /** codex 面的读屏侧问规格（与 CODEX_SIDE_QUESTION 同形的测试替身）。 */
  const screenSurface = () => {
    const surface = {
      harness: 'codex',
      discovery: false,
      prompt: null,
      promptInbox: null,
      queuedPrompt: null,
      inject: null,
      headless: null,
      idleSignals: ['Stop'],
      paneEnvSource: 'launch',
      attach: null,
      pathRefs: null,
      sideQuestion: {
        command: (q: string) => q,
        validate: (q: string) => (q.trim() ? { ok: true, text: q.trim() } : { ok: false, error: '空' }),
        answerOf: () => null,
        prerequisite: '主线程至少发过一条消息后才能开侧边会话（宿主限制）',
        screen: {
          openKeys: '/side',
          submitKey: '\r',
          closeKey: '\x03',
          panelOpen: (s: string) => s.includes('Side from main thread'),
          extractAnswer: (question: string, _before: string, now: string) =>
            now.includes('• Working')
              ? { answer: null, done: false }
              : {
                  answer: now.includes(`› ${question}`) ? '42' : null,
                  done: true,
                },
        },
      },
    } as unknown as MessagingSurface;
    return { surface };
  };

  /** 给测试会话登记 pane env（sessionKeysTarget 的 locator 命中前提）。 */
  const notePane = (deliverer: MessageDeliverer) =>
    deliverer.notePaneEnv(CODEX_SESSION, { WEZTERM_PANE: '5', WEZTERM_UNIX_SOCKET: 'D:/sock/gui-sock-1' });

  /** 假终端：键序/文本记账，屏幕按脚本逐拍返回。 */
  const fakeTerminal = (screens: string[]) => {
    const keys: string[] = [];
    const texts: string[] = [];
    let tick = 0;
    const terminal: PromptTerminal = {
      available: () => true,
      listPanes: async () => [],
      locatePane: async (env: Record<string, string>) => env['WEZTERM_PANE'] ?? null,
      sendText: async (_paneId: string, text: string) => {
        texts.push(text);
      },
      sendKeys: async (_paneId: string, sent: string) => {
        keys.push(sent);
      },
      getPaneText: async () => screens[Math.min(tick++, screens.length - 1)] ?? '',
      closePane: async () => {},
    };
    return { terminal, keys, texts };
  };

  beforeEach(() => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projectId = projects.register({ path: PROJECT_PATH, name: 'msg', token: TOKEN, source: 'init' }).id;
    sessions = new SessionRepository(db);
    events = new HookEventRepository(db);
    bus = new HookEventBus();
    busEvents = [];
    bus.subscribe((m) => busEvents.push(m));
    sessions.touch(CODEX_SESSION, projectId);
    hooksDir = mkdtempSync(join(tmpdir(), 'weave-msg-side-'));
  });

  afterEach(() => {
    db.close();
    rmSync(hooksDir, { recursive: true, force: true });
  });

  it('正路：开面板 → 问句 → 轮询取到回答 → 落库 + 帧 → 关面板', async () => {
    pushEvent(CODEX_SESSION, 'Stop');
    const { surface } = screenSurface();
    const answered: Array<[string, string, string]> = [];
    const { terminal, keys, texts } = fakeTerminal([
      '› Ask Codex to do anything', // before 快照
      '› Ask Codex to do anything', // 开面板后（还没开成）
      '› Ask Codex to do anything\n  Side from main thread · ctrl+c to close', // 补 CR 后开成
      '› q?\n• Working (2s)\n  Side from main thread', // 轮询 1：还在跑
      '› q?\n• 42\n  Worked for 3s\n  Side from main thread', // 轮询 2：回答落定
      '› q?\n• 42\n  Worked for 3s\n  Side from main thread', // 收尾前验屏
    ]);
    const deliverer = new MessageDeliverer(
      makeDeps({
        surfaceFor: () => surface,
        terminal,
        sideAnswerStore: { answerById: (sid, q, a) => answered.push([sid, q, a]) },
      }),
    );
    notePane(deliverer);
    const result = await deliverer.askSideQuestion(CODEX_SESSION, 'q?');
    expect(result).toEqual({ ok: true, question: 'q?' });
    // 轮询是 fire-and-forget：等它跑完（7 拍 × 间隔 + 余量）
    await new Promise((r) => setTimeout(r, 6500));
    expect(texts).toEqual(['q?']);
    expect(keys).toEqual(['/side', '\r', '\r', '\r', '\x03']); // 开面板、补 CR、提交、关面板
    expect(answered).toEqual([[CODEX_SESSION, 'q?', '42']]);
    expect(busEvents.some((m) => m.kind === 'sideQuestion.answered')).toBe(true);
  }, 15_000);

  it('前置闸：主线程没跑过（hasRun=false）→ 409 + prerequisite 文案', async () => {
    pushEvent(CODEX_SESSION, 'SessionStart'); // 有 source 但不算 hasRun
    const { surface } = screenSurface();
    const { terminal } = fakeTerminal([]);
    const deliverer = new MessageDeliverer(makeDeps({ surfaceFor: () => surface, terminal }));
    notePane(deliverer);
    const result = await deliverer.askSideQuestion(CODEX_SESSION, 'q?');
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as { error: string }).error).toContain('主线程');
  });

  it('面板开不成（两次验屏都无指纹）→ 放弃，不发问句、不关面板', async () => {
    pushEvent(CODEX_SESSION, 'Stop');
    const { surface } = screenSurface();
    const { terminal, keys, texts } = fakeTerminal([
      '› Ask Codex to do anything',
      '› Ask Codex to do anything',
      '› Ask Codex to do anything',
      '› Ask Codex to do anything',
    ]);
    const deliverer = new MessageDeliverer(makeDeps({ surfaceFor: () => surface, terminal }));
    notePane(deliverer);
    expect(await deliverer.askSideQuestion(CODEX_SESSION, 'q?')).toEqual({ ok: true, question: 'q?' });
    await new Promise((r) => setTimeout(r, 4500));
    expect(texts).toEqual([]); // 问句没发（防落主线程）
    expect(keys).toEqual(['/side', '\r', '\r']); // 只重试了一次开面板
  });

  it('用户中途关面板 → 落库跳过、零收尾键序（不盲打 ctrl+c）', async () => {
    pushEvent(CODEX_SESSION, 'Stop');
    const { surface } = screenSurface();
    const answered: Array<[string, string, string]> = [];
    const { terminal, keys } = fakeTerminal([
      '› Ask Codex to do anything',
      '› Ask Codex to do anything\n  Side from main thread', // 开成
      '› q?\n• 42\n  Worked for 3s', // 轮询：回答在，但面板已被用户关掉（无指纹）
      '› q?\n• 42\n  Worked for 3s', // 收尾前验屏：仍无指纹
    ]);
    const deliverer = new MessageDeliverer(
      makeDeps({
        surfaceFor: () => surface,
        terminal,
        sideAnswerStore: { answerById: (sid, q, a) => answered.push([sid, q, a]) },
      }),
    );
    notePane(deliverer);
    await deliverer.askSideQuestion(CODEX_SESSION, 'q?');
    await new Promise((r) => setTimeout(r, 6000));
    expect(answered).toEqual([[CODEX_SESSION, 'q?', '42']]); // 回答照取
    expect(keys).toEqual(['/side', '\r', '\r']); // 无 closeKey
  }, 15_000);
});
