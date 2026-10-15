import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { hookShardId } from '../mirror.js';
import { readPromptbox } from '../promptbox.js';

const PROJECT_PATH = '/msg-proj';
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

  it('codex 面：inject / headless / auto / prompt（无终端通道）均 409 + 面内原因', async () => {
    const deliverer = new MessageDeliverer(makeDeps());
    pushEvent(CODEX_SESSION, 'Stop', 'codex');
    for (const mode of ['inject', 'headless', 'auto', 'prompt'] as const) {
      const result = await deliverer.send({
        toSessionId: CODEX_SESSION,
        text: 'hi',
        mode,
        fromKind: 'dashboard',
      });
      expect(result, mode).toMatchObject({ ok: false, status: 409 });
    }
    const prompt = await deliverer.send({
      toSessionId: CODEX_SESSION,
      text: 'hi',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect((prompt as Extract<SendResult, { ok: false }>).error).toContain('Codex');
    expect(deliverer.listVisible(CODEX_SESSION)).toHaveLength(0);
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
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

  it('冲洗节流：一轮最多 5 条（防发送侧突发拒收），余下留队列', async () => {
    db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
    const sent: string[] = [];
    const sendText = vi.fn().mockImplementation(async (paneId: string, text: string) => {
      sent.push(`${paneId}:${text}`);
    });
    const noNative: MessagingSurface = {
      harness: 'codex',
      discovery: true,
      prompt: null,
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
    expect(sent).toHaveLength(5); // 一轮上限
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(2); // 余下留队列

    await deliverer.flushSession(SESSION_ID); // 下一轮继续
    expect(sent).toHaveLength(7);
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
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
    await deliverer.flushSession(SESSION_ID); // 只调一次：自续把剩下 2 条也发完
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
    // 载荷带来源标注（socket 路径是裸 user 文本，标一句供日后审计）
    expect(got).toContain('[weave] socket 直投正文');
    expect(got).toContain('"type":"auth"');
    expect(deliverer.getMessage((result as { messageId: string }).messageId)).toMatchObject({
      status: 'delivered',
      via: 'socket',
    });
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

  it('编排域（非 oneWay）即使有 inbox 目标也先走中继——保留 @weave 身份', async () => {
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
      text: 'sequence step',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    expect(fake.calls).toHaveLength(1);
    expect(deliverer.getMessage((result as { messageId: string }).messageId)).toMatchObject({
      via: 'relay',
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toBe('');
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
    );
    expect(deliverer.getMessage(id)?.acked).toBe(true);
    expect(busEvents).toContainEqual(
      expect.objectContaining({ kind: 'message.acknowledged', messageId: id }),
    );

    // 短文本（< ACK_MIN_TEXT）不参与匹配：防误配
    const tiny = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'ok',
      mode: 'prompt',
      fromKind: 'dashboard',
      oneWay: true,
    });
    deliverer.onSessionPrompt(SESSION_ID, 'ok');
    expect(deliverer.getMessage((tiny as { messageId: string }).messageId)?.acked).toBeUndefined();
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

    // 层① 闪现（登记了一瞬）→ 中继非 0 退出 → failed 留内存可见、不回队
    const flaky = relaySurface((sessionId) => ({ name: PEER_NAME }));
    const flakyDeliverer = new MessageDeliverer(
      makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => flaky.surface, bin: 'fake-relay' }),
    );
    const queued = readPromptbox(hooksDir, TOKEN);
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
    void queued;
  });

  it('终端通道注入但 available()=false（settings 换了不支持的后端）→ prompt 409、矩阵不亮', async () => {
    const terminal: PromptTerminal = {
      available: () => false,
      listPanes: vi.fn(),
      sendText: vi.fn(),
      sendKeys: vi.fn(),
    };
    const noNative: MessagingSurface = {
      harness: 'codex',
      discovery: true,
      prompt: null,
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
    };
    const noNative: MessagingSurface = {
      harness: 'codex',
      discovery: true,
      prompt: null,
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
    };
    const noNative: MessagingSurface = {
      harness: 'codex',
      discovery: true,
      prompt: null,
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
      locatePane,
    };
    const noNative: MessagingSurface = {
      harness: 'codex',
      discovery: true,
      prompt: null,
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

    const removed = deliverer.forgetSession(SESSION_ID);
    expect(removed).toBe(1);
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(1);
    expect(deliverer.hasQueued(SESSION_ID)).toBe(false);

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

  // ---- 终态驻留（决定①）：delivered 在窗口内展示 via/acked，窗口过后消失 ----

  it('终态驻留：socket 直投 delivered 带 via/settledAt 短时可见，窗口过后消失', async () => {
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

    // 解闸后：积压行经自续冲洗投出
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

  describe('answer（阻塞问答作答）', () => {
    const paneFixture = (panes: Array<{ id: string; title: string | null; cwd: string | null }>) => {
      const sendKeys = vi.fn().mockResolvedValue(undefined);
      const terminal: PromptTerminal = {
        available: () => true,
        listPanes: vi.fn().mockResolvedValue(panes),
        sendText: vi.fn(),
        sendKeys,
      };
      return { terminal, sendKeys };
    };

    it('选项键序打进 pane（spinner 前缀含 ◐ 输入等待态也能匹配）', async () => {
      db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run(
        '◐ msg-target',
        SESSION_ID,
      );
      const { terminal, sendKeys } = paneFixture([
        { id: 'pane-1', title: '◐ msg-target', cwd: PROJECT_PATH },
      ]);
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));
      pushEvent(SESSION_ID, 'Stop');

      await expect(deliverer.answer(SESSION_ID, '1')).resolves.toEqual({ ok: true });
      expect(sendKeys).toHaveBeenCalledWith('pane-1', '1');
      // 多选形态（数字 + CR）同过白名单
      await expect(deliverer.answer(SESSION_ID, '2\r')).resolves.toEqual({ ok: true });
      expect(sendKeys).toHaveBeenCalledWith('pane-1', '2\r');
    });

    it('键序白名单：非「数字 + 可选 CR」一律 400（作答面不是键序注入通道）', async () => {
      const { terminal, sendKeys } = paneFixture([]);
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));
      for (const keys of ['abc', '1\r2', '12', '\r', '1\n', '']) {
        const result = await deliverer.answer(SESSION_ID, keys);
        expect(result, JSON.stringify(keys)).toMatchObject({ ok: false, status: 400 });
      }
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it('自定义输入键序：数字 + 文本 + CR 放行；内嵌控制字符仍 400', async () => {
      db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
      const { terminal, sendKeys } = paneFixture([
        { id: 'pane-1', title: '◐ msg-target', cwd: PROJECT_PATH },
      ]);
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));

      await expect(deliverer.answer(SESSION_ID, '4自己写一个\r')).resolves.toEqual({ ok: true });
      expect(sendKeys).toHaveBeenCalledWith('pane-1', '4自己写一个\r');
      for (const keys of ['4a\rb\r', '4\u001b[D\r', '4a\nb\r']) {
        await expect(deliverer.answer(SESSION_ID, keys)).resolves.toMatchObject({
          ok: false,
          status: 400,
        });
      }
    });

    it('会话不存在 404；pane 找不到 409（窗口没开/歧义）', async () => {
      const { terminal } = paneFixture([]);
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));
      await expect(deliverer.answer('sess-ghost', '1')).resolves.toMatchObject({
        ok: false,
        status: 404,
      });
      db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
      await expect(deliverer.answer(SESSION_ID, '1')).resolves.toMatchObject({
        ok: false,
        status: 409,
      });
    });

    it('无终端通道 409（层② 是作答的唯一通道）', async () => {
      const deliverer = new MessageDeliverer(makeDeps());
      await expect(deliverer.answer(SESSION_ID, '1')).resolves.toMatchObject({
        ok: false,
        status: 409,
      });
    });
  });
});
