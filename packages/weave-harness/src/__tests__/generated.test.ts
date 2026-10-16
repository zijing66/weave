import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_COMPONENTS,
  DEFAULT_HOOKS,
  DEFAULT_MCP,
  type InitComponents,
  type MCPConfig,
  type PlatformInfo,
  resolveComponents,
} from '@weavecode/core';
import { generateHookHandler } from '../claude/capture.js';
import { generateAutoMemoryHook } from '../claude/helpers-gen.js';
import {
  WEAVE_CONTENT_MARKER,
  generateInitFiles,
  type InitFileContext,
  type InitGeneratedFile,
} from '../init/generated.js';

let home: string;
let projectPath: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'weave-gen-home-'));
  projectPath = mkdtempSync(path.join(tmpdir(), 'weave-gen-proj-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(projectPath, { recursive: true, force: true });
});

function platform(): PlatformInfo {
  return {
    os: 'linux',
    arch: 'x64',
    nodeVersion: 'v20.0.0',
    shell: 'bash',
    homeDir: home,
    configDir: path.join(home, '.config'),
  };
}

function ctx(overrides?: {
  components?: Partial<InitComponents>;
  mcp?: Partial<MCPConfig>;
}): InitFileContext {
  return {
    projectPath,
    version: '9.9.9',
    platform: platform(),
    components: resolveComponents('default', overrides?.components),
    hooks: { ...DEFAULT_HOOKS },
    mcp: { ...DEFAULT_MCP, ...overrides?.mcp },
  };
}

function entry(files: InitGeneratedFile[], relPath: string): InitGeneratedFile {
  const found = files.find((f) => f.relPath === relPath);
  if (!found) throw new Error(`no entry for ${relPath}`);
  return found;
}

describe('generateInitFiles（daemon 与 init 同一期望态）', () => {
  it('claude：helpers 整文件类带 weave 覆写判据，内容 = 同一套生成器', async () => {
    const files = await generateInitFiles('claude', ctx());
    const handler = entry(files, '.claude/helpers/hook-handler.cjs');
    expect(handler.weaveMarker).toBe(WEAVE_CONTENT_MARKER);
    expect(handler.content).toBe(generateHookHandler('9.9.9'));

    const memory = entry(files, '.claude/helpers/auto-memory-hook.mjs');
    expect(memory.weaveMarker).toBe(WEAVE_CONTENT_MARKER);
    expect(memory.content).toBe(generateAutoMemoryHook('9.9.9'));
  });

  it('settings.json 为 merge 类：期望态 = 并进盘上原文，幂等', async () => {
    const files = await generateInitFiles('claude', ctx());
    const settings = entry(files, '.claude/settings.json');
    expect(settings.weaveMarker).toBeUndefined();

    const userFile = JSON.stringify({ theme: 'dark', hooks: {} }, null, 2) + '\n';
    const merged = settings.merge!(userFile, settings.content);
    expect(merged).not.toBeNull();
    expect(merged).toContain('"theme": "dark"');
    // 幂等：再并一次不改变结果
    expect(settings.merge!(merged!, settings.content)).toBe(merged);
  });

  it('merge 类遇不可解析的盘上原文返回 null（保持不动）', async () => {
    const files = await generateInitFiles('claude', ctx());
    const settings = entry(files, '.claude/settings.json');
    expect(settings.merge!('{ not json', settings.content)).toBeNull();
    expect(settings.merge!(settings.content, '{ not json')).toBeNull();
  });

  it('.mcp.json 只在 weave server 开启时入清单（init 同口径：没得写就不写）', async () => {
    const off = await generateInitFiles('claude', ctx());
    expect(off.some((f) => f.relPath === '.mcp.json')).toBe(false);

    const on = await generateInitFiles('claude', ctx({ mcp: { weave: true } }));
    const mcp = entry(on, '.mcp.json');
    expect(mcp.content).toContain('"weave"');
  });

  it('components 关掉的面不入清单', async () => {
    const noSettings = await generateInitFiles('claude', ctx({ components: { settings: false } }));
    expect(noSettings.some((f) => f.relPath === '.claude/settings.json')).toBe(false);
    expect(noSettings.some((f) => f.relPath === '.claude/helpers/hook-handler.cjs')).toBe(true);

    const noHelpers = await generateInitFiles('claude', ctx({ components: { helpers: false } }));
    expect(noHelpers.some((f) => f.relPath.startsWith('.claude/helpers/'))).toBe(false);
  });

  it('codex：无可漂移的生成文件', async () => {
    const files = await generateInitFiles('codex', ctx());
    expect(files).toEqual([]);
  });
});

describe('默认组件面', () => {
  it('default preset 的 helpers 面开 → 两份 helper 脚本都在清单里', async () => {
    const files = await generateInitFiles('claude', ctx());
    expect(DEFAULT_COMPONENTS.helpers).toBe(true);
    expect(files.map((f) => f.relPath)).toEqual([
      '.claude/helpers/hook-handler.cjs',
      '.claude/helpers/auto-memory-hook.mjs',
      '.claude/settings.json',
    ]);
  });
});
