import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WEAVE_VERSION } from '@weavecode/server';
import { generateHookHandler } from '@weavecode/harness';
import { generateAutoMemoryHook } from '../init/helpers-gen';

describe('generateHookHandler（脚本形态）', () => {
  it('emits a CJS shebang script', () => {
    const out = generateHookHandler(WEAVE_VERSION);
    expect(out.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('reads stdin and exits 0 on every path', () => {
    const out = generateHookHandler(WEAVE_VERSION);
    expect(out).toContain("process.stdin.on('data'");
    // success / no-token / non-injectable / catch-all —— 每个路径都退出 0
    const exitCount = (out.match(/process\.exit\(0\)/g) ?? []).length;
    expect(exitCount).toBeGreaterThanOrEqual(4);
  });

  it('includes a weave version stamp', () => {
    expect(generateHookHandler(WEAVE_VERSION)).toContain(`weave@${WEAVE_VERSION}`);
  });

  it('不再有远程调用：无 http/daemon.json/spool/flusher', () => {
    const out = generateHookHandler(WEAVE_VERSION);
    expect(out).not.toContain("require('http')");
    expect(out).not.toContain('daemon.json');
    expect(out).not.toContain('spool');
    expect(out).not.toContain('WEAVE_FLUSH');
    expect(out).not.toContain('postBatch');
  });

  it('落盘全局数据目录：inbox/mirror/outbox + shard 契约', () => {
    const out = generateHookHandler(WEAVE_VERSION);
    expect(out).toContain("require('crypto')");
    expect(out).toContain("sha256");
    expect(out).toContain("'hooks'");
    expect(out).toContain("'inbox'");
    expect(out).toContain("'mirror'");
    expect(out).toContain("'outbox'");
    expect(out).toContain('MIRROR_VERSION = 1');
    // 行形契约：{v, token, report, messaging, terminal}
    // （messaging = 层① 收件箱凭据旁路；terminal = 层② pane 定位键旁路）
    expect(out).toContain(
      '{ v: 1, token: token, report: report, messaging: messagingEnv(), terminal: terminalEnv() }',
    );
  });

  it('本地渲染注入 + 顺延 outbox + 标题，并带 60s 去重', () => {
    const out = generateHookHandler(WEAVE_VERSION);
    expect(out).toContain('hookSpecificOutput');
    expect(out).toContain('hookEventName');
    expect(out).toContain('additionalContext');
    expect(out).toContain('sessionTitle');
    expect(out).toContain('deliveredTitle');
    expect(out).toContain("const TITLE_EVENTS = ['SessionStart', 'UserPromptSubmit']");
    expect(out).toContain('DISPATCH_MARKER');
    expect(out).toContain('consumeOutbox');
    expect(out).toContain('DEDUPE_WINDOW_MS = 60000');
    expect(out).toContain('dispatch-state.json');
  });

  it('reads the project token from .weave/token', () => {
    const out = generateHookHandler(WEAVE_VERSION);
    expect(out).toContain("'.weave'");
    expect(out).toContain("'token'");
  });
});

describe('generateAutoMemoryHook', () => {
  it('emits a Node shebang script', () => {
    expect(generateAutoMemoryHook().startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('exits 0', () => {
    expect(generateAutoMemoryHook()).toContain('process.exit(0)');
  });
});

/**
 * 端到端：真跑生成的脚本（daemon 缺席 = 只有文件系统参与），验证
 * ① server 没启动也照常采集进 inbox；② mirror 里静态规则本地渲染注入；
 * ③ 60s 去重挡住重复注入；④ outbox 顺延消费；⑤ pendingTitle 下发。
 */
describe('hook-handler.cjs 端到端（零 daemon）', () => {
  let root: string;
  let projectDir: string;
  let scriptPath: string;
  const token = 'tok-e2e';

  /** 与脚本内 configDir() 同源的解析（脚本读环境变量，测试为各平台设好）。 */
  const configEnv = (): Record<string, string> => {
    if (process.platform === 'win32') return { APPDATA: root };
    if (process.platform === 'darwin') return { HOME: root };
    return { XDG_CONFIG_HOME: root };
  };

  const configDirOf = (): string => {
    if (process.platform === 'darwin') return path.join(root, 'Library', 'Application Support');
    return root;
  };

  const shard = (t: string): string => createHash('sha256').update(t).digest('hex').slice(0, 16);
  const hooksRoot = () => path.join(configDirOf(), 'weave', 'cache', 'hooks');
  const mirrorPath = () => path.join(hooksRoot(), 'mirror', `${shard(token)}.json`);
  const inboxPath = () => path.join(hooksRoot(), 'inbox', `${shard(token)}.jsonl`);
  const outboxPath = () => path.join(hooksRoot(), 'outbox', `${shard(token)}.jsonl`);

  const writeMirror = (doc: unknown) => {
    mkdirSync(path.dirname(mirrorPath()), { recursive: true });
    writeFileSync(mirrorPath(), JSON.stringify(doc));
  };

  const runHook = (event: Record<string, unknown>): Promise<{ stdout: string; status: number }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath], {
        env: { ...process.env, ...configEnv(), CLAUDE_PROJECT_DIR: projectDir },
      });
      let stdout = '';
      child.stdout.on('data', (c) => (stdout += String(c)));
      child.on('error', reject);
      child.on('close', (status) => resolve({ stdout, status }));
      child.stdin.write(JSON.stringify(event));
      child.stdin.end();
    });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'weave-hook-e2e-'));
    projectDir = path.join(root, 'proj');
    mkdirSync(path.join(projectDir, '.weave'), { recursive: true });
    writeFileSync(path.join(projectDir, '.weave', 'token'), token);
    scriptPath = path.join(root, 'hook-handler.cjs');
    writeFileSync(scriptPath, generateHookHandler(WEAVE_VERSION));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('daemon 没启动也照常采集：事件进 inbox，无 mirror 则无注入', async () => {
    const { stdout, status } = await runHook({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(projectDir, 'a.md') },
    });
    expect(status).toBe(0);
    expect(stdout).toBe(''); // 无镜像规则 = 无注入，但采集照常
    const lines = readFileSync(inboxPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ v: 1, token });
    expect(JSON.parse(lines[0]!).report.eventType).toBe('PostToolUse');
  });

  it('mirror 静态规则本地渲染注入（含 marker）；非白名单事件只采集', async () => {
    writeMirror({
      version: 1,
      project: 'proj',
      pendingTitles: {},
      rules: [
        {
          id: 'r1',
          name: '文档规则',
          events: ['PostToolUse'],
          tools: null,
          globs: ['**/*.md'],
          template: '更新文档 {file}（{rule}/{project}）',
        },
      ],
    });

    const hit = await runHook({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(projectDir, 'docs', 'a.md') },
    });
    const payload = JSON.parse(hit.stdout) as {
      hookSpecificOutput: { additionalContext: string; hookEventName: string };
    };
    expect(payload.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(payload.hookSpecificOutput.additionalContext).toContain('更新文档');
    expect(payload.hookSpecificOutput.additionalContext).toContain('文档规则');
    expect(payload.hookSpecificOutput.additionalContext).toContain('proj');
    expect(payload.hookSpecificOutput.additionalContext).toContain('<!--weave-dispatch-->');

    // glob 不命中
    const miss = await runHook({
      hook_event_name: 'PostToolUse',
      session_id: 's2',
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(projectDir, 'a.ts') },
    });
    expect(miss.stdout).toBe('');

    // 不可注入事件：不渲染注入
    const pre = await runHook({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: projectDir });
    expect(pre.stdout).toBe('');
    expect(readFileSync(inboxPath(), 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('同 rule×session 60s 去重：第二次不注入，但事件照采', async () => {
    writeMirror({
      version: 1,
      project: 'proj',
      pendingTitles: {},
      rules: [{ id: 'r1', name: 'r', events: ['UserPromptSubmit'], tools: null, globs: null, template: '注入' }],
    });
    const event = { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: projectDir };
    const first = await runHook(event);
    expect(first.stdout).toContain('注入');
    const second = await runHook(event);
    expect(second.stdout).toBe('');
    expect(readFileSync(inboxPath(), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('outbox 顺延注入被消费并删行；pendingTitle 经 hookSpecificOutput 下发', async () => {
    writeMirror({
      version: 1,
      project: 'proj',
      pendingTitles: { s1: '新会话名' },
      rules: [],
    });
    mkdirSync(path.dirname(outboxPath()), { recursive: true });
    writeFileSync(
      outboxPath(),
      JSON.stringify({ sessionId: 's1', text: '插件注入内容', at: new Date().toISOString() }) +
        '\n' +
        JSON.stringify({ sessionId: 'other', text: '别人的', at: new Date().toISOString() }) +
        '\n',
    );

    const { stdout } = await runHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: 's1',
      cwd: projectDir,
    });
    const payload = JSON.parse(stdout) as {
      hookSpecificOutput: { additionalContext: string; sessionTitle: string };
    };
    expect(payload.hookSpecificOutput.additionalContext).toContain('插件注入内容');
    expect(payload.hookSpecificOutput.additionalContext).not.toContain('别人的');
    expect(payload.hookSpecificOutput.sessionTitle).toBe('新会话名');
    // 交付回执随采集行带回——daemon 据此落定 pending（「改名待生效」徽标即刻清除）
    const ackLine = JSON.parse(readFileSync(inboxPath(), 'utf8').trim().split('\n')[0]!);
    expect(ackLine.report.deliveredTitle).toBe('新会话名');
    // 消费即删：只剩别会话那条
    const kept = readFileSync(outboxPath(), 'utf8').trim().split('\n');
    expect(kept).toHaveLength(1);
    expect(JSON.parse(kept[0]!)).toMatchObject({ sessionId: 'other' });
    expect(existsSync(inboxPath())).toBe(true);
  });

  it('pendingTitle 只在标题生效事件下发：工具事件下发即弃（Claude 2.1.296 实测）', async () => {
    // Claude Code 只在 SessionStart/UserPromptSubmit 应用 hookSpecificOutput.
    // sessionTitle——工具事件 hook_success 落档但 custom-title 不变。工具事件若
    // 也带回执，daemon 会把 pending 误落定，改名从此永不再投递（待生效假清）。
    writeMirror({ version: 1, project: 'proj', pendingTitles: { s1: '新会话名' }, rules: [] });

    const tool = await runHook({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {},
    });
    expect(tool.stdout).toBe(''); // 不下发标题，也不带回执
    const acks = () =>
      readFileSync(inboxPath(), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { report: { deliveredTitle: string | null } });
    expect(acks().map((l) => l.report.deliveredTitle)).toEqual([null]);

    const ups = await runHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: 's1',
      cwd: projectDir,
    });
    expect(JSON.parse(ups.stdout).hookSpecificOutput.sessionTitle).toBe('新会话名');
    expect(acks().map((l) => l.report.deliveredTitle)).toEqual([null, '新会话名']);
  });

  it('stop_hook_active=true 时闭嘴：宿主已让 agent 继续过，再输出就是让它空转', async () => {
    // 用 outbox 顺延注入作载体（无 60s 去重、title 又不在 Stop 事件下发）：
    // 守卫若失效，第二枪会照常输出新写的顺延内容。
    writeMirror({ version: 1, project: 'proj', pendingTitles: {}, rules: [] });
    const writeOutbox = (text: string) => {
      mkdirSync(path.dirname(outboxPath()), { recursive: true });
      writeFileSync(
        outboxPath(),
        JSON.stringify({ sessionId: 's9', text, at: new Date().toISOString() }) + '\n',
      );
    };

    // 第一枪（stop_hook_active 缺省 = 未继续过）：照常顺延注入
    writeOutbox('第一段顺延');
    const ask = await runHook({ hook_event_name: 'Stop', session_id: 's9', cwd: projectDir });
    expect(JSON.parse(ask.stdout).hookSpecificOutput.additionalContext).toContain('第一段顺延');

    // 第二枪：宿主带 stop_hook_active=true 问回来 → 必须静默（连 outbox 都不消费）
    writeOutbox('第二段顺延');
    const again = await runHook({
      hook_event_name: 'Stop',
      session_id: 's9',
      cwd: projectDir,
      stop_hook_active: true,
    });
    expect(again.status).toBe(0);
    expect(again.stdout).toBe('');
    // 采集不受守卫影响：两枪都进了 inbox；第二段顺延原样留在盘上
    expect(readFileSync(inboxPath(), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(readFileSync(outboxPath(), 'utf8')).toContain('第二段顺延');
  });

  it('stop_hook_active=true 只对 Stop/SubagentStop 生效，别的注入事件不受影响', async () => {
    writeMirror({
      version: 1,
      project: 'proj',
      pendingTitles: {},
      rules: [
        {
          id: 'r-scope',
          name: '范围规则',
          events: ['UserPromptSubmit'],
          tools: null,
          globs: null,
          template: '照常注入',
        },
      ],
    });

    const { stdout } = await runHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: 's10',
      cwd: projectDir,
      stop_hook_active: true, // 该字段本不该出现在这里；守卫也不能因此误伤
    });
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain('照常注入');
  });

  it('项目未注册（无 token）：静默退出、不写 inbox', async () => {
    await rm(path.join(projectDir, '.weave', 'token'), { force: true });
    const { status, stdout } = await runHook({ hook_event_name: 'Stop', session_id: 's1', cwd: projectDir });
    expect(status).toBe(0);
    expect(stdout).toBe('');
    expect(existsSync(inboxPath())).toBe(false);
  });
});
