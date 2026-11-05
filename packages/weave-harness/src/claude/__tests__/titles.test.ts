import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeSessionTitleOf } from '../titles.js';

/**
 * 集成式测法：临时 HOME 摆真 `~/.claude/sessions/<pid>.json` 注册表
 * （一个 pid 一个文件，name + nameSource 由宿主持续改写）。
 */

describe('claudeSessionTitleOf（sessions 注册表）', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'weave-claude-titles-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const dir = () => join(home, '.claude', 'sessions');
  let tick = 0;
  const writeReg = (pid: number, body: Record<string, unknown>) => {
    mkdirSync(dir(), { recursive: true });
    const file = join(dir(), `${pid}.json`);
    writeFileSync(file, JSON.stringify(body));
    tick += 1;
    const t = new Date(Date.now() + tick * 1000);
    utimesSync(file, t, t);
  };

  it('目录不存在 → null', () => {
    expect(claudeSessionTitleOf('s1', home)).toBeNull();
  });

  it('按 sessionId 命中 name（derived 派生默认名也认）', () => {
    writeReg(100, { pid: 100, sessionId: 's1', name: 'vxspace-a0', nameSource: 'derived' });
    writeReg(200, { pid: 200, sessionId: 's2', name: '别人', nameSource: 'user' });
    expect(claudeSessionTitleOf('s1', home)).toBe('vxspace-a0');
    expect(claudeSessionTitleOf('s2', home)).toBe('别人');
  });

  it('查无登记 / 无名 → null', () => {
    writeReg(100, { pid: 100, sessionId: 's1', name: '有名' });
    writeReg(200, { pid: 200, sessionId: 's2' });
    writeReg(300, { pid: 300, sessionId: 's3', name: '   ' });
    expect(claudeSessionTitleOf('s2', home)).toBeNull();
    expect(claudeSessionTitleOf('s3', home)).toBeNull();
    expect(claudeSessionTitleOf('nope', home)).toBeNull();
  });

  it('同一会话多份登记 → 取 mtime 最新那份（改名后生效）', () => {
    writeReg(100, { pid: 100, sessionId: 's1', name: '旧名' });
    writeReg(200, { pid: 200, sessionId: 's1', name: '新名' });
    expect(claudeSessionTitleOf('s1', home)).toBe('新名');
  });

  it('文件内容更新后重读（mtime+size 缓存不串味）', () => {
    writeReg(100, { pid: 100, sessionId: 's1', name: 'vxspace-a0' });
    expect(claudeSessionTitleOf('s1', home)).toBe('vxspace-a0');
    writeReg(100, { pid: 100, sessionId: 's1', name: '桌宠优化' });
    expect(claudeSessionTitleOf('s1', home)).toBe('桌宠优化');
  });

  it('坏 JSON 与无关文件跳过，不影响其它登记', () => {
    writeReg(100, { pid: 100, sessionId: 's1', name: '好名' });
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), 'bad.json'), 'not-json');
    writeFileSync(join(dir(), '100.json.key'), 'x');
    expect(claudeSessionTitleOf('s1', home)).toBe('好名');
  });
});
