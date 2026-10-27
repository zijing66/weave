import { describe, it, expect } from 'vitest';
import { HARNESS_LIFECYCLE, INJECTABLE_EVENTS } from '@weavecode/core';
import { CLAUDE_MESSAGING } from '../claude/messaging.js';
import { CLAUDE_PROMPT_INBOX } from '../claude/prompt-inbox.js';
import { CLAUDE_PROMPT_RELAY } from '../claude/prompt.js';
import { CLAUDE_RESUME } from '../claude/resume.js';
import { CODEX_MESSAGING } from '../codex/messaging.js';
import { CLAUDE_DRIVER, CODEX_DRIVER } from '../index.js';

/**
 * MessagingSurface 契约（session-orchestration 批 1）：claude 是完整参考实现，
 * codex 是显式不支持面。锁死三条单源约束——headless 对象引用 resume 槽、
 * rideEvents 取值 INJECTABLE_EVENTS、idleSignals 取值 HARNESS_LIFECYCLE。
 */
describe('MessagingSurface 契约', () => {
  it('claude：槽挂载 + capabilities 含 messaging', () => {
    expect(CLAUDE_DRIVER.capabilities).toContain('messaging');
    expect(CLAUDE_DRIVER.messaging).toBe(CLAUDE_MESSAGING);
  });

  it('codex：槽挂载（不支持也是面，不是槽位缺席）', () => {
    expect(CODEX_DRIVER.capabilities).toContain('messaging');
    expect(CODEX_DRIVER.messaging).toBe(CODEX_MESSAGING);
  });

  it('claude：三通道全开，headless = CLAUDE_RESUME 对象引用（单源不复制）', () => {
    expect(CLAUDE_MESSAGING.harness).toBe('claude');
    expect(CLAUDE_MESSAGING.discovery).toBe(true);
    expect(CLAUDE_MESSAGING.inject).toEqual({ rideEvents: INJECTABLE_EVENTS.claude });
    expect(CLAUDE_MESSAGING.headless).toBe(CLAUDE_RESUME);
  });

  it('claude：prompt = CLAUDE_PROMPT_RELAY 对象引用（单源不复制）', () => {
    expect(CLAUDE_MESSAGING.prompt).toBe(CLAUDE_PROMPT_RELAY);
    // 命令行固定参数、无用户内容；stdin 投递指令由 server 拼。
    expect(CLAUDE_PROMPT_RELAY.args.every((a) => !a.includes('\n'))).toBe(true);
    expect(CLAUDE_PROMPT_RELAY.args).toContain('--no-session-persistence');
    expect(CLAUDE_PROMPT_RELAY.args).toContain('--tools');
    // 中继启动减肥：不拉 MCP、不解析 skills；--bare 不可用（破坏 --tools 白名单）
    expect(CLAUDE_PROMPT_RELAY.args).toContain('--strict-mcp-config');
    expect(CLAUDE_PROMPT_RELAY.args).toContain('--disable-slash-commands');
    expect(CLAUDE_PROMPT_RELAY.args).not.toContain('--bare');
    expect(CLAUDE_PROMPT_RELAY.senderName).toBe('weave');
    expect(typeof CLAUDE_PROMPT_RELAY.resolve).toBe('function');
  });

  it('claude：中继指令——手动面（oneWay）载荷头部带单向注记、原文其后', () => {
    const instruction = CLAUDE_PROMPT_RELAY.instruction('peer-a', 'go check the build', {
      oneWay: true,
    });
    expect(instruction).toContain('"peer-a"');
    expect(instruction).toContain('SendMessage');
    expect(instruction).toContain('go check the build');
    expect(instruction.indexOf('one-way')).toBeLessThan(
      instruction.indexOf('go check the build'),
    );
  });

  it('claude：中继指令——编排域（非 oneWay）原样投递，双向对话不加注记', () => {
    const instruction = CLAUDE_PROMPT_RELAY.instruction('peer-a', 'go check the build', {
      oneWay: false,
    });
    expect(instruction).toContain('go check the build');
    expect(instruction).not.toContain('one-way');
    expect(instruction).not.toContain('no reply');
  });

  it('claude：idleSignals 取值生命周期表（close + 会话级终点），不手抄', () => {
    expect(CLAUDE_MESSAGING.idleSignals).toEqual([
      ...HARNESS_LIFECYCLE.claude.close,
      'SessionEnd',
    ]);
    expect(CLAUDE_MESSAGING.idleSignals).toContain('Stop');
  });

  it('claude：paneEnvSource = hook（hook 生在会话自己 pane，env 精确可信）', () => {
    expect(CLAUDE_MESSAGING.paneEnvSource).toBe('hook');
  });

  it('claude：headless 规格 promptStdin——args 不含 prompt（命令行无用户内容）', () => {
    expect(CLAUDE_RESUME.promptStdin).toBe(true);
    expect(CLAUDE_RESUME.args('sid-1', '任意 prompt')).toEqual(['--resume', 'sid-1', '-p']);
  });

  it('claude：fork 提取参数——resume+fork+不落盘+指定 fork 会话 id；codex 无此能力', () => {
    expect(CLAUDE_RESUME.extractArgs?.('sid-1', 'sx-1')).toEqual([
      '--resume',
      'sid-1',
      '--fork-session',
      '--no-session-persistence',
      '--session-id',
      'sx-1',
    ]);
    expect(CODEX_MESSAGING.headless?.extractArgs).toBeUndefined();
  });

  it('claude：promptInbox = CLAUDE_PROMPT_INBOX 对象引用（inbox socket 是 claude 专属机制）', () => {
    expect(CLAUDE_MESSAGING.promptInbox).toBe(CLAUDE_PROMPT_INBOX);
    // 平台差异：native Windows 必须带 auth 行；POSIX 可选
    expect(CLAUDE_PROMPT_INBOX.requiresAuthOn('win32')).toBe(true);
    expect(CLAUDE_PROMPT_INBOX.requiresAuthOn('darwin')).toBe(false);
    // 组帧归 harness：auth 行 + user 行（换行分隔），token 缺省即省掉 auth 行
    const frame = CLAUDE_PROMPT_INBOX.frame({ token: 't1', text: 'hi' });
    expect(frame.split('\n').filter(Boolean)).toHaveLength(2);
    expect(frame).toContain('"type":"auth"');
    expect(frame).toContain('"content":"hi"');
    expect(CLAUDE_PROMPT_INBOX.frame({ token: null, text: 'hi' }).split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('claude：路径文法——整文件 / 单行 / 区间 / 目录尾斜杠（宿主里手敲的四种形状）', () => {
    const spec = CLAUDE_MESSAGING.pathRefs!;
    expect(spec.kinds).toEqual(['file', 'dir']);
    expect(spec.lines).toBe(true);
    expect(spec.expression({ path: 'src/a.ts', kind: 'file' })).toBe('@src/a.ts');
    expect(spec.expression({ path: 'src/a.ts', kind: 'file', lines: { start: 7, end: 7 } })).toBe('@src/a.ts#L7');
    expect(spec.expression({ path: 'src/a.ts', kind: 'file', lines: { start: 12, end: 34 } })).toBe(
      '@src/a.ts#L12-34',
    );
    expect(spec.expression({ path: 'src', kind: 'dir' })).toBe('@src/');
  });

  it('claude：带空格路径 = 双引号形状（2026-10-26 实测宿主认；转义/单引号/裸空格都不认）', () => {
    const spec = CLAUDE_MESSAGING.pathRefs!;
    // expression：含空格才加引号；引号 + #L 组合同样被实测背书
    expect(spec.expression({ path: 'my file.md', kind: 'file' })).toBe('@"my file.md"');
    expect(spec.expression({ path: 'my dir', kind: 'dir' })).toBe('@"my dir"/');
    expect(
      spec.expression({ path: 'my file.md', kind: 'file', lines: { start: 3, end: 3 } }),
    ).toBe('@"my file.md"#L3');
    // recognize：双引号形式整段认回（含空格），闭引号后同样要求空白
    const text = '看 @"my file.md" 和 @src/a.ts 两处';
    const hits = spec.recognize(text);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ path: 'my file.md', kind: 'file', ref: '@"my file.md"' });
    expect(text.slice(hits[0]!.start, hits[0]!.end)).toBe('@"my file.md"');
    expect(hits[1]).toMatchObject({ path: 'src/a.ts', kind: 'file' });
    // 行区间在引号形式里也认（用户手敲的形状，解析不设限）
    const lined = spec.recognize('看 @"my file.md"#L3-5');
    expect(lined).toHaveLength(1);
    expect(lined[0]).toMatchObject({ path: 'my file.md', lines: { start: 3, end: 5 } });
    // 闭引号后粘着字不算（与裸形式同一判据）
    expect(spec.recognize('看 @"my file.md"，还有')).toEqual([]);
  });

  it('claude：recognize 是 expression 的逆运算（粘贴回填：句子里的引用要被原样认出来）', () => {
    const spec = CLAUDE_MESSAGING.pathRefs!;
    const text = '看下 @src/a.ts 和 @src/b.ts#L12-34 两处，目录 @docs/plan/ 也看一眼，别碰 foo@bar.com';
    expect(spec.recognize(text).map((r) => ({ ...r, start: undefined, end: undefined }))).toEqual([
      { ref: '@src/a.ts', path: 'src/a.ts', kind: 'file', start: undefined, end: undefined },
      { ref: '@src/b.ts#L12-34', path: 'src/b.ts', kind: 'file', lines: { start: 12, end: 34 }, start: undefined, end: undefined },
      { ref: '@docs/plan/', path: 'docs/plan', kind: 'dir', start: undefined, end: undefined },
    ]);
    // 区间覆盖的正是原文那一段（前端按它切文本）
    for (const hit of spec.recognize(text)) expect(text.slice(hit.start, hit.end)).toBe(hit.ref);
  });

  it('claude：recognize 的边界——前后必须是空白，转义 \\@、词中 @、盘符/绝对路径', () => {
    const spec = CLAUDE_MESSAGING.pathRefs!;
    expect(spec.recognize('\\@src/a.ts')).toEqual([]);
    expect(spec.recognize('mail foo@src/a.ts')).toEqual([]);
    expect(spec.recognize('@/etc/passwd @C:/x.ts @a#b')).toEqual([]);
    // 前后只要有一边粘着别的字就不算引用（中文、全角标点同样算「粘着」）
    expect(spec.recognize('参考@src/a.ts')).toEqual([]);
    expect(spec.recognize('@src/a.ts，还有')).toEqual([]);
    expect(spec.recognize('看 @src/a.ts 和 @src/b.ts 两处')).toHaveLength(2);
    // 行首/行尾本身就是边界
    expect(spec.recognize('@src/a.ts')).toHaveLength(1);
    expect(spec.recognize('看这个\n@src/a.ts')).toHaveLength(1);
  });

  it('codex：无通道 null/空 + reasons 齐全（可渲染「为什么置灰」）；pathRefs = 裸相对路径文法', () => {
    expect(CODEX_MESSAGING.harness).toBe('codex');
    expect(CODEX_MESSAGING.discovery).toBe(false);
    expect(CODEX_MESSAGING.prompt).toBeNull();
    expect(CODEX_MESSAGING.promptInbox).toBeNull();
    expect(CODEX_MESSAGING.inject).toBeNull();
    expect(CODEX_MESSAGING.headless).toBeNull();
    expect(CODEX_MESSAGING.idleSignals).toEqual([...HARNESS_LIFECYCLE.codex.close, 'SessionEnd']);
    expect(CODEX_MESSAGING.paneEnvSource).toBe('launch');
    expect(CODEX_MESSAGING.pathRefs).not.toBeNull();
    expect(CODEX_MESSAGING.pathRefs!.lines).toBe(false);
    expect(CODEX_MESSAGING.pathRefs!.expression({ path: 'src/a.ts', kind: 'file' })).toBe('src/a.ts');
    for (const channel of ['discovery', 'prompt', 'inject', 'headless', 'watch'] as const) {
      expect(CODEX_MESSAGING.unsupportedReasons?.[channel]).toBeTruthy();
    }
  });

  it('codex：queuedPrompt = codex queue，正文进 argv、命令行无 shell 元字符风险', () => {
    const spec = CODEX_MESSAGING.queuedPrompt!;
    const { bin, args } = spec.command('0197aaaa-bbbb-7ccc-8ddd-eeeeffff0000', '正文 with spaces & quotes');
    // win32 探得到 npm 包时前面多一段 node 入口（bin = node、args[0] = codex.js）；
    // 探不到就是裸名 codex。两种形态的 queue 参数都一样。
    const queueArgs = args[0]!.endsWith('codex.js') ? args.slice(1) : args;
    expect(queueArgs).toEqual([
      'queue',
      '--thread',
      '0197aaaa-bbbb-7ccc-8ddd-eeeeffff0000',
      '--message',
      '正文 with spaces & quotes',
    ]);
    expect(queueArgs.slice(0, -1).every((a) => !a.includes('&'))).toBe(true);
    expect(typeof bin).toBe('string');
    expect(bin.length).toBeGreaterThan(0);
  });
});
