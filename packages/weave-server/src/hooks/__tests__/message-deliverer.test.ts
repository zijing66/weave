import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
    expect(got).toContain('[weave] 重启后直投');
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

  it('层序随面变：编排域（非 oneWay）有终端通道仍先走中继', async () => {
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
        },
      }),
    );
    pushEvent(SESSION_ID, 'Stop');

    const result = await deliverer.send({
      toSessionId: SESSION_ID,
      text: 'orchestration',
      mode: 'prompt',
      fromKind: 'sequence',
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

    // 短文本（< ACK_MIN_TEXT）只认**整条相等**：包含不算，本体相等才算。
    // 另起一个实例：上面那条中继还在飞，同一会话再发会直接落队列（没有内存行可比）。
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
    // 直投带来源标记：剥掉后本体相等 → 回执（否则短正文永远认不出自己，必被未回执闸误杀）
    shortDeliverer.onSessionPrompt(SESSION_ID, '[weave] ok');
    expect(shortDeliverer.getMessage(tinyId)?.acked).toBe(true);
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
    expect(await deliverer.sessionTerminals()).toEqual({});
    // 队列行此刻已成死信 → 一并按 offline 落定并清队
    expect(readPromptbox(hooksDir, TOKEN)).toHaveLength(0);
    expect(deliverer.hasQueued(SESSION_ID)).toBe(false);
    expect(deliverer.listVisible(SESSION_ID).map((m) => m.reason)).toEqual(['offline', 'offline']);
    // 会话行与对话照常保留（那是历史，不是旁路事实——不走 forgetSession 的删会话级联）
    expect(sessions.getBySessionId(SESSION_ID)).not.toBeNull();
    expect(deliverer.listVisible(SESSION_ID).length).toBeGreaterThan(0);
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

    it('在飞的行不删：delivering 期间 409（落定回调会把行写回来）', async () => {
      const fake = createFakeSpawn();
      const { surface } = relaySurface();
      const deliverer = new MessageDeliverer(
        makeDeps({ spawnImpl: fake.spawnImpl, surfaceFor: () => surface, bin: 'fake-relay' }),
      );
      pushEvent(SESSION_ID, 'Stop');

      const sent = await deliverer.send({
        toSessionId: SESSION_ID,
        text: 'in-flight dismiss rejected',
        mode: 'prompt',
        fromKind: 'dashboard',
        oneWay: true,
      });
      const id = (sent as { messageId: string }).messageId;
      expect(deliverer.getMessage(id)!.status).toBe('delivering');
      expect(deliverer.dismiss(SESSION_ID, id)).toMatchObject({ ok: false, status: 409 });
      fake.children[0]!.emit('exit', 0, null);
      expect(deliverer.getMessage(id)!.status).toBe('delivered');
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

  describe('interrupt（停止按钮 → 一记 ESC）', () => {
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

    it('往 pane 打恰好一记 ESC（连打两次在 claude 里是历史回退菜单）', async () => {
      db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run('msg-target', SESSION_ID);
      const { terminal, sendKeys } = paneFixture([
        { id: 'pane-1', title: '✻ msg-target', cwd: PROJECT_PATH },
      ]);
      const deliverer = new MessageDeliverer(makeDeps({ terminal }));

      await expect(deliverer.interrupt(SESSION_ID)).resolves.toEqual({ ok: true });
      expect(sendKeys.mock.calls).toEqual([['pane-1', '\x1b']]);
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

  describe('cycleMode / setModel（会话控制面）', () => {
    const paneFixture = () => {
      const sendKeys = vi.fn().mockResolvedValue(undefined);
      const sendText = vi.fn().mockResolvedValue(undefined);
      const terminal: PromptTerminal = {
        available: () => true,
        listPanes: vi.fn().mockResolvedValue([{ id: 'pane-1', title: '✻ msg-target', cwd: PROJECT_PATH }]),
        sendText,
        sendKeys,
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
  });

  // ---- 图片随 prompt（harness `imageAttach` 对齐面）：投递文本现合成、回执放宽 ----

  /** 与 claude 同形态：图引用 = 裸绝对路径，每张一行，落在用户原文之后。 */
  const CLAUDE_ATTACH = {
    composePrompt: (text: string, images: readonly { path: string }[]) =>
      text ? `${text}\n\n${images.map((i) => i.path).join('\n')}` : images.map((i) => i.path).join('\n'),
  };

  const oneImage = (path = 'D:/up/aa.png') => [
    { id: 'a'.repeat(64), name: 'aa.png', mediaType: 'image/png', path },
  ];

  const surfaceWithImages = (resolve: (sessionId: string) => { name: string } | null = () => ({ name: PEER_NAME })) => {
    const base = relaySurface(resolve);
    return { ...base, surface: { ...base.surface, imageAttach: CLAUDE_ATTACH } };
  };

  it('带图投递：harness 的 imageAttach 为 null → 409，不发号不投递', async () => {
    const fake = createFakeSpawn();
    const { surface } = relaySurface(); // 没有 imageAttach
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
      images: oneImage(),
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(fake.calls).toHaveLength(0);
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
      images: oneImage(),
    });
    expect(sendText).toHaveBeenCalledWith('pane-1', '看看这个\n\nD:/up/aa.png');
    const id = (result as { messageId: string }).messageId;
    expect(deliverer.getMessage(id)).toMatchObject({ text: '看看这个' });
    expect(deliverer.getMessage(id)?.images?.[0]?.path).toBe('D:/up/aa.png');
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
      images: oneImage(),
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
    await new Promise((r) => setTimeout(r, 50));
    expect(deliverer.getMessage((textOnly as { messageId: string }).messageId)).toMatchObject({ via: 'socket' });
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
      images: oneImage(),
    });
    const queued = readPromptbox(hooksDir, TOKEN).filter((e) => e.sessionId === SESSION_ID);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.images?.[0]).toMatchObject({ path: 'D:/up/aa.png', name: 'aa.png' });
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
      images: oneImage(),
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
      images: oneImage(),
    });
    const id = (result as { messageId: string }).messageId;
    // claude 粘贴处理会把多行 chunk 用空串连起来——回执原文与 msg.text 差在空白上
    deliverer.onSessionPrompt(SESSION_ID, '第一行正文第二行正文（够长）');
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
      images: oneImage(),
    });
    const id = (result as { messageId: string }).messageId;
    expect(deliverer.onSessionPrompt(SESSION_ID, '我自己另敲的一句话')).toEqual([]);
    expect(deliverer.getMessage(id)?.acked).toBeUndefined();
  });
});
