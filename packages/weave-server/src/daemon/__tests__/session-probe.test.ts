import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dbTranscriptPathResolver, readTail, SessionProbe } from '../session-probe';

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
});
