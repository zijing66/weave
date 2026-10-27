import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CODEX_LOG_SOURCE, CodexLogSource } from '../rollout.js';
import { installUserCapture } from '../capture.js';

const CWD = 'C:/work/proj';

let home: string;
let stateDir: string;
let sessionFile: string;

const line = (o: unknown): string => JSON.stringify(o) + '\n';

const metaLine = (sessionId: string, cwd = CWD): string =>
  line({ timestamp: '2026-11-01T00:00:00.000Z', ordinal: 1, type: 'session_meta', payload: { session_id: sessionId, cwd } });

const poll = (source = CODEX_LOG_SOURCE as CodexLogSource, whitelist = [CWD]) =>
  source.poll({ stateDir, cwdWhitelist: whitelist });

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'weave-codex-home-'));
  const day = path.join(home, 'sessions', '2026', '11', '01');
  await mkdir(day, { recursive: true });
  sessionFile = path.join(day, 'rollout-2026-11-01T00-00-00-th-1.jsonl');
  stateDir = await mkdtemp(path.join(tmpdir(), 'weave-codex-state-'));
  process.env.CODEX_HOME = home;
});

afterEach(async () => {
  delete process.env.CODEX_HOME;
  await rm(home, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

describe('CodexLogSource', () => {
  it('刚开的会话从头读：SessionStart → UserPromptSubmit → Stop 一条不漏', async () => {
    await writeFile(
      sessionFile,
      metaLine('th-1') +
        line({ timestamp: '2026-11-01T00:00:10.000Z', ordinal: 2, type: 'event_msg', payload: { type: 'user_message', message: '跑测试' } }) +
        line({ timestamp: '2026-11-01T00:00:20.000Z', ordinal: 3, type: 'event_msg', payload: { type: 'agent_message', message: '好' } }) +
        line({ timestamp: '2026-11-01T00:00:30.000Z', ordinal: 4, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: null } }),
    );
    const out = await poll();
    expect(out.map((r) => r.report.eventType)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
    expect(out[0].report.sessionId).toBe('th-1');
    expect(out[0].report.cwd).toBe(CWD);
    // 行自带时间戳优先（回填历史不能印成插入时刻）
    expect(out[2].at).toBe('2026-11-01T00:00:30.000Z');
    // last_agent_message 缺省由本轮的 agent_message 补位
    expect((out[2].report.payload as { lastAgentMessage: string }).lastAgentMessage).toBe('好');
  });

  it('游标推进：新追加的行只读一次，不重复上报', async () => {
    await writeFile(sessionFile, metaLine('th-1'));
    expect((await poll()).length).toBe(1);
    expect((await poll()).length).toBe(0);
    await appendFile(sessionFile, line({
      timestamp: '2026-11-01T00:01:00.000Z', ordinal: 2, type: 'event_msg',
      payload: { type: 'user_message', message: '第二条' },
    }));
    const out = await poll();
    expect(out.map((r) => r.report.eventType)).toEqual(['UserPromptSubmit']);
    expect((await poll()).length).toBe(0);
  });

  it('半行不消费：下次补齐后仍只上报一次', async () => {
    await writeFile(sessionFile, metaLine('th-1'));
    await poll();
    const full = line({
      timestamp: '2026-11-01T00:02:00.000Z', ordinal: 2, type: 'event_msg',
      payload: { type: 'user_message', message: '写了一半' },
    });
    await appendFile(sessionFile, full.slice(0, 20));
    expect((await poll()).length).toBe(0);
    await appendFile(sessionFile, full.slice(20));
    expect((await poll()).map((r) => r.report.eventType)).toEqual(['UserPromptSubmit']);
  });

  it('白名单外的 cwd 不采，但仍登记游标（项目后加入白名单从此刻起采）', async () => {
    await writeFile(sessionFile, metaLine('th-1', 'C:/work/other'));
    expect((await poll()).length).toBe(0);
    await appendFile(sessionFile, line({ timestamp: '2026-11-01T00:03:00.000Z', ordinal: 2, type: 'event_msg', payload: { type: 'user_message', message: 'x' } }));
    expect((await poll()).length).toBe(0);
  });

  it('同一个 session_id 出现在两个文件里（子线程 / 归档另起文件）→ 都采、归同一个会话', async () => {
    await writeFile(sessionFile, metaLine('th-1') + line({
      timestamp: '2026-11-01T00:00:10.000Z', ordinal: 2, type: 'event_msg',
      payload: { type: 'user_message', message: '第一段' },
    }));
    const resumed = path.join(path.dirname(sessionFile), 'rollout-2026-11-01T01-00-00-th-1.jsonl');
    await writeFile(resumed, metaLine('th-1') + line({
      timestamp: '2026-11-01T01:00:10.000Z', ordinal: 5, type: 'event_msg',
      payload: { type: 'user_message', message: '第二段' },
    }));
    const out = await poll();
    const prompts = out.filter((r) => r.report.eventType === 'UserPromptSubmit');
    expect(prompts.map((r) => r.report.sessionId)).toEqual(['th-1', 'th-1']);
  });

  it('文件被截断：从头再读，不卡在旧偏移', async () => {
    const big = metaLine('th-1') + line({ timestamp: '2026-11-01T00:00:10.000Z', ordinal: 2, type: 'event_msg', payload: { type: 'user_message', message: '很长的一段'.repeat(50) } });
    await writeFile(sessionFile, big);
    expect((await poll()).length).toBe(2);
    await writeFile(sessionFile, metaLine('th-1'));
    expect((await poll()).map((r) => r.report.eventType)).toEqual(['SessionStart']);
  });

  it('读不到身份的文件（头行超窗 / 空文件）登记但不每拍重试', async () => {
    const junk = path.join(path.dirname(sessionFile), 'rollout-2026-11-01T02-00-00-th-2.jsonl');
    await writeFile(junk, 'not json\n');
    expect((await poll()).length).toBe(0);
    expect((await poll()).length).toBe(0);
  });

  it('文件删掉后游标条目一并清（游标文件不随时间胀大）', async () => {
    await writeFile(sessionFile, metaLine('th-1'));
    await poll();
    await rm(sessionFile);
    await poll();
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(path.join(stateDir, 'cursors.json'), 'utf8'));
    expect(JSON.parse(raw).files).toEqual({});
  });

  it('单拍预算到顶就返回，下一拍接着读', async () => {
    const rows = [metaLine('th-1')];
    for (let i = 0; i < 10; i++) {
      rows.push(line({ timestamp: '2026-11-01T00:00:10.000Z', ordinal: i + 2, type: 'event_msg', payload: { type: 'user_message', message: `第 ${i} 条` } }));
    }
    await writeFile(sessionFile, rows.join(''));
    const source = new CodexLogSource();
    const first = await source.poll({ stateDir, cwdWhitelist: [CWD], maxRecords: 4 });
    expect(first.length).toBe(4);
    const rest = await source.poll({ stateDir, cwdWhitelist: [CWD], maxRecords: 100 });
    expect(rest.length).toBe(7);
  });

  it('health 报根与已登记文件数，凭据与正文一概不出', async () => {
    await writeFile(sessionFile, metaLine('th-1'));
    await poll();
    const health = await (CODEX_LOG_SOURCE as CodexLogSource).health({ stateDir });
    expect(health.root).toBe(path.resolve(home));
    expect(health.files).toBe(1);
    expect(health.lastPollAt).not.toBeNull();
  });
});

describe('CodexLogSource 部分让位给 hooks', () => {
  it('采集装上后只采 session_meta（hooks 懒触发漏掉的启动信号），其余行型让位', async () => {
    await installUserCapture({ version: '1.2.3' });
    await writeFile(
      sessionFile,
      metaLine('th-1') +
        line({ timestamp: '2026-11-01T00:00:10.000Z', ordinal: 2, type: 'event_msg', payload: { type: 'user_message', message: '跑测试' } }),
    );
    // 装着 capture：session_meta 照常产出（TUI 开了就要有行），user_message 让位给 hooks
    const source = new CodexLogSource();
    const out = await poll(source);
    expect(out.map((r) => r.report.eventType)).toEqual(['SessionStart']);
    expect(out[0]!.report.sessionId).toBe('th-1');
    expect((await poll(source)).length).toBe(0);

    // 游标已推进到 session_meta 行尾：后续追加的行型（hooks 的领地）不再产出
    await appendFile(
      sessionFile,
      line({ timestamp: '2026-11-01T00:00:20.000Z', ordinal: 3, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: null } }),
    );
    expect(await poll(source)).toEqual([]);

    // 卸载 capture：回到全采兜底，刚才让位的行型（已过游标的不补）之后的新行照采
    const { uninstallUserCapture } = await import('../capture.js');
    await uninstallUserCapture();
    const bare = new CodexLogSource();
    await appendFile(
      sessionFile,
      line({ timestamp: '2026-11-01T00:00:30.000Z', ordinal: 4, type: 'event_msg', payload: { type: 'user_message', message: '第二条' } }),
    );
    expect((await poll(bare)).map((r) => r.report.eventType)).toEqual(['UserPromptSubmit']);
  });

  it('capture 装上前已消费过的文件：装上后新文件的 session_meta 照常产出', async () => {
    await writeFile(sessionFile, metaLine('th-1'));
    const source = new CodexLogSource();
    expect((await poll(source)).length).toBe(1);
    await installUserCapture({ version: '1.2.3' });
    const after = new CodexLogSource();
    // 同一文件不会再有 session_meta（resume 续写不重发）——空拍
    expect(await poll(after)).toEqual([]);
    // 新文件（新 TUI 会话）的 session_meta 照常产出
    const second = path.join(path.dirname(sessionFile), 'rollout-2026-11-01T00-05-00-th-2.jsonl');
    await writeFile(second, metaLine('th-2'));
    const out = await poll(after);
    expect(out.map((r) => r.report.eventType)).toEqual(['SessionStart']);
    expect(out[0]!.report.sessionId).toBe('th-2');
  });
});
