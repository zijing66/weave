import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dbModelFactResolver, dbTranscriptPathResolver, readTail, SessionProbe } from '../session-probe';

const dirs: string[] = [];
const tmpFile = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'weave-probe-'));
  dirs.push(dir);
  return path.join(dir, 'session.jsonl');
};

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const markerLine = (at: string, text = '[Request interrupted by user]'): string =>
  JSON.stringify({
    type: 'user',
    timestamp: at,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });

describe('readTail', () => {
  it('读文件尾部指定字节；读不到（不存在/是目录）返 null', () => {
    const file = tmpFile();
    writeFileSync(file, 'a'.repeat(100) + 'TAIL');
    expect(readTail(file, 4)).toBe('TAIL');
    // 全读（请求超过文件长度）
    expect(readTail(file, 1000)).toBe('a'.repeat(100) + 'TAIL');
    expect(readTail(path.join(file, 'nope'))).toBeNull();
  });
});

describe('SessionProbe', () => {
  it('重启后内存路径丢了：从库里最近一条事件的旁路字段补回，模型/模式不掉「未知」', () => {
    const file = tmpFile();
    writeFileSync(
      file,
      JSON.stringify({ type: 'assistant', permissionMode: 'plan', message: { model: 'opus' } }) + '\n',
    );
    const probe = new SessionProbe(
      dbTranscriptPathResolver({
        listBySession: (_id, limit) => (limit === 1 ? [{ payload: JSON.stringify({ transcriptPath: file }) }] : []),
      }),
    );
    // 没有 noteTranscript（= daemon 刚重启、这个会话还没有新事件）
    expect(probe.currentModel('s1')).toBe('opus');
    expect(probe.currentMode('s1')).toBe('plan');
  });

  it('标记晚于最后一条事件才算中断（自愈：之后任何事件都盖过它）', () => {
    const file = tmpFile();
    const at = '2026-01-02T03:00:00.000Z';
    writeFileSync(file, markerLine(at) + '\n');
    const probe = new SessionProbe();
    probe.noteTranscript('s1', file);

    const marker = Date.parse(at);
    expect(probe.interruptedAt('s1', new Date(marker - 1000).toISOString())).toBe(marker);
    // 更新的事件（用户又发了一条）→ 不再算中断
    expect(probe.interruptedAt('s1', new Date(marker + 1000).toISOString())).toBeNull();
    // 同一时刻不算「晚于」
    expect(probe.interruptedAt('s1', at)).toBeNull();
  });

  it('未知路径 / 没登记 / 无标记 / 坏时间一律 null（不猜）', () => {
    const file = tmpFile();
    writeFileSync(file, '{"type":"user","message":{"content":"hi"}}\n');
    const probe = new SessionProbe();
    expect(probe.interruptedAt('s1', '2026-01-01T00:00:00.000Z')).toBeNull();
    probe.noteTranscript('s1', file);
    expect(probe.interruptedAt('s1', '2020-01-01T00:00:00.000Z')).toBeNull();
    expect(probe.interruptedAt('s1', 'not-a-date')).toBeNull();
    // noteTranscript 传 null（事件不带路径）不覆盖已有的
    probe.noteTranscript('s1', null);
    expect(probe.interruptedAt('s1', '2020-01-01T00:00:00.000Z')).toBeNull();
  });

  it('转录还在不在：内存/库兜底都认路，有内容 true、删掉或空文件 false、不知路径 null', () => {
    const file = tmpFile();
    const probe = new SessionProbe(
      dbTranscriptPathResolver({
        listBySession: (id, limit) =>
          id === 's1' && limit === 1 ? [{ payload: JSON.stringify({ transcriptPath: file }) }] : [],
      }),
    );
    expect(probe.transcriptPresent('nope')).toBeNull();

    writeFileSync(file, '{"type":"user","message":{"content":"hi"}}\n');
    // 内存里没登记过（= daemon 刚重启）：路径从库里补回，同 currentModel 的口径
    expect(probe.transcriptPresent('s1')).toBe(true);

    // 转录被清理/删掉：会话行还在，但接不回来了
    rmSync(file);
    expect(probe.transcriptPresent('s1')).toBe(false);

    // 空文件同样没有可接的对话
    writeFileSync(file, '');
    expect(probe.transcriptPresent('s1')).toBe(false);
  });

  it('forget 后不再认；文件长过之后按新内容重读（大小缓存不是墓碑）', () => {
    const file = tmpFile();
    writeFileSync(file, '{"type":"user","message":{"content":"hi"}}\n');
    const probe = new SessionProbe();
    probe.noteTranscript('s1', file);
    const past = '2020-01-01T00:00:00.000Z';
    expect(probe.interruptedAt('s1', past)).toBeNull();

    // 转录追加了中断标记 → 同一实例要认出来（大小变了就重读）
    const at = '2026-01-02T03:00:00.000Z';
    appendFileSync(file, markerLine(at, '[Request interrupted by user for tool use]') + '\n');
    expect(probe.interruptedAt('s1', past)).toBe(Date.parse(at));

    probe.forget('s1');
    expect(probe.interruptedAt('s1', past)).toBeNull();
  });

  it('currentModel / currentMode 同走一份尾读缓存；未知一律 null（不猜）', () => {
    const probe = new SessionProbe();
    expect(probe.currentModel('s1')).toBeNull();
    expect(probe.currentMode('s1')).toBeNull();

    const file = tmpFile();
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'assistant', permissionMode: 'plan', message: { model: 'opus' } }),
        JSON.stringify({ type: 'user', permissionMode: 'bypassPermissions' }),
      ].join('\n') + '\n',
    );
    probe.noteTranscript('s1', file);
    expect(probe.currentModel('s1')).toBe('opus');
    expect(probe.currentMode('s1')).toBe('bypassPermissions');

    // 文件没长 = 缓存命中；长了就按新内容重读
    expect(probe.currentModel('s1')).toBe('opus');
    appendFileSync(
      file,
      JSON.stringify({ type: 'assistant', permissionMode: 'plan', message: { model: 'ftm' } }) + '\n',
    );
    expect(probe.currentModel('s1')).toBe('ftm');
    expect(probe.currentMode('s1')).toBe('plan');
  });

  it('执行模式事件优先：切完还没写转录条目也答得出新值；没事件才回落转录', () => {
    const probe = new SessionProbe();
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ type: 'user', permissionMode: 'default' }) + '\n');
    probe.noteTranscript('s1', file);
    expect(probe.currentMode('s1')).toBe('default');

    // Shift+Tab 切到 plan：笔迹只在事件里，转录还是切之前那条
    probe.noteMode('s1', 'plan');
    expect(probe.currentMode('s1')).toBe('plan');
    // 转录后来照会的仍是旧值，也不许把事件的答案盖回去
    expect(probe.currentMode('s1')).toBe('plan');

    probe.forget('s1');
    expect(probe.currentMode('s1')).toBeNull();
  });

  it('换模型落定即生效：转录还没照会新值时标签也跟着变，转录跟上后交还给它', () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ type: 'assistant', message: { model: 'ftm' } }) + '\n');
    const probe = new SessionProbe();
    probe.noteTranscript('s1', file);
    expect(probe.currentModel('s1')).toBe('ftm');

    // 宿主说换到 deepseek-flash 了，但这一轮还没跑出 assistant 条目
    probe.noteModel('s1', 'deepseek-flash');
    expect(probe.currentModel('s1')).toBe('deepseek-flash');

    // 真跑了一轮：转录照会新值，两边一致
    appendFileSync(file, JSON.stringify({ type: 'assistant', message: { model: 'deepseek-flash' } }) + '\n');
    expect(probe.currentModel('s1')).toBe('deepseek-flash');

    // 又切回 ftm 且还没跑：事件说的算（转录照会的仍是切换前那个）
    probe.noteModel('s1', 'ftm');
    expect(probe.currentModel('s1')).toBe('ftm');
  });

  it('重开会话（SessionStart）作废旧答案：切换闩不许把标签钉死在关会话之前那个模型', () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ type: 'assistant', message: { model: 'ftm' } }) + '\n');
    const probe = new SessionProbe();
    probe.noteTranscript('s1', file);
    probe.noteModel('s1', 'deepseek-flash');
    expect(probe.currentModel('s1')).toBe('deepseek-flash');

    // 重开后宿主落回默认 ftm：新照会恰好等于切换闩的 stale，旧实现会永远答 deepseek-flash
    appendFileSync(file, JSON.stringify({ type: 'assistant', message: { model: 'ftm' } }) + '\n');
    expect(probe.currentModel('s1')).toBe('deepseek-flash');
    probe.sessionStarted('s1', null);
    expect(probe.currentModel('s1')).toBe('ftm');

    // 事件带了真名（startup / compact）就以它为准
    probe.sessionStarted('s1', 'opus');
    expect(probe.currentModel('s1')).toBe('opus');
  });

  it('没有转录路径时换模型也答得出来；forget 之后照旧 null', () => {
    const probe = new SessionProbe();
    probe.noteModel('s1', 'deepseek-flash');
    expect(probe.currentModel('s1')).toBe('deepseek-flash');
    probe.forget('s1');
    expect(probe.currentModel('s1')).toBeNull();
  });

  it('尾窗读空不擦掉最后已知——会话完成后文件不再增长，那口 null 会钉死成「未知」', () => {
    const file = tmpFile();
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'assistant', permissionMode: 'plan', message: { model: 'opus' } }),
        JSON.stringify({ type: 'user', permissionMode: 'bypassPermissions' }),
      ].join('\n') + '\n',
    );
    const probe = new SessionProbe();
    probe.noteTranscript('s1', file);
    expect(probe.currentModel('s1')).toBe('opus');
    expect(probe.currentMode('s1')).toBe('bypassPermissions');

    // 一轮的大记录（> 64KB 单行）把上面两条挤出尾窗：读空，但不能掉回未知
    appendFileSync(
      file,
      JSON.stringify({ type: 'user', toolUseResult: 'x'.repeat(70 * 1024) }) + '\n',
    );
    expect(probe.currentModel('s1')).toBe('opus');
    expect(probe.currentMode('s1')).toBe('bypassPermissions');

    // 闩随会话走：forget 之后照旧 null（不猜）
    probe.forget('s1');
    expect(probe.currentModel('s1')).toBeNull();
    expect(probe.currentMode('s1')).toBeNull();
  });

  it('重启后闩没了：回读库里那条落定事件补回来（换完就放着也跟得上）', () => {
    const file = tmpFile();
    writeFileSync(
      file,
      JSON.stringify({ type: 'assistant', message: { model: 'custom_openai/ftm' } }) + '\n',
    );
    // daemon 刚重启：内存里既没路径也没闩，路径与落定事件都从库里补
    const probe = new SessionProbe(
      () => file,
      () => ({ from: 'ftm', to: 'deepseek-flash' }),
    );
    expect(probe.currentModel('s1')).toBe('deepseek-flash');

    // 宿主跑了一轮、转录照会新值（转录原样带网关前缀）：交还给它
    appendFileSync(
      file,
      JSON.stringify({ type: 'assistant', message: { model: 'custom_openai/deepseek-flash' } }) + '\n',
    );
    expect(probe.currentModel('s1')).toBe('custom_openai/deepseek-flash');
  });

  it('转录已照会别的值就不补（事件早于转录），且每个会话只问库一次', () => {
    const file = tmpFile();
    writeFileSync(
      file,
      JSON.stringify({ type: 'assistant', message: { model: 'custom_openai/deepseek-flash' } }) + '\n',
    );
    let asked = 0;
    const probe = new SessionProbe(undefined, () => {
      asked += 1;
      return { from: 'ftm', to: 'opus' };
    });
    probe.noteTranscript('s1', file);
    expect(probe.currentModel('s1')).toBe('custom_openai/deepseek-flash');
    expect(probe.currentModel('s1')).toBe('custom_openai/deepseek-flash');
    expect(asked).toBe(1);

    // 重开会话（模型交还宿主重定）后重新问：此后新切换照样补
    probe.sessionStarted('s1', null);
    expect(probe.currentModel('s1')).toBe('custom_openai/deepseek-flash');
    expect(asked).toBe(2);
  });
});

describe('dbModelFactResolver', () => {
  const row = (eventType: string, raw: unknown): { eventType: string; payload: string } => ({
    eventType,
    payload: JSON.stringify({ raw }),
  });

  it('取「模型落定」事件（换模型 / 重开）里最新的一条：换模型答得出新值', () => {
    const calls: Array<readonly string[] | undefined> = [];
    const resolve = dbModelFactResolver(
      {
        listBySession: (_id, _limit, _before, types) => {
          calls.push(types);
          return [row('PostModelSwitch', { from_model: 'ftm', to_model: 'deepseek-flash' })];
        },
      },
      () => 'claude',
    );
    expect(resolve('s1')).toEqual({ from: 'ftm', to: 'deepseek-flash' });
    expect(calls[0]).toEqual(['PostModelSwitch', 'SessionStart']);
  });

  it('最新是重开会话 → 什么都不补（宿主把模型交还重定了，旧答案作废）', () => {
    const resolve = dbModelFactResolver(
      {
        listBySession: () => [
          row('PostModelSwitch', { from_model: 'ftm', to_model: 'deepseek-flash' }),
          row('SessionStart', { source: 'resume' }),
        ],
      },
      () => 'claude',
    );
    expect(resolve('s1')).toBeNull();
  });

  it('harness 没登记 / 该 harness 没有落定事件 → null，不必查库', () => {
    let queried = false;
    const events = { listBySession: () => { queried = true; return []; } };
    expect(dbModelFactResolver(events, () => null)('s1')).toBeNull();
    expect(dbModelFactResolver(events, () => 'codex')('s1')).toBeNull();
    expect(dbModelFactResolver(events, () => 'nope')('s1')).toBeNull();
    expect(queried).toBe(false);
  });
});
