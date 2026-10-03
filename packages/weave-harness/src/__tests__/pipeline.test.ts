import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InitPipeline, type InitContext } from '../init/pipeline';

const CTX: InitContext = {
  targetDir: '/tmp/weave-harness-test',
  force: false,
  interactive: true,
  preset: 'default',
  components: {},
  hooks: {},
  skills: {},
  commands: {},
  agents: {},
  mcp: {},
  platform: {
    os: 'linux',
    arch: 'x64',
    nodeVersion: 'v20.0.0',
    shell: 'bash',
    homeDir: '/home/test',
    configDir: '/home/test/.config',
  },
};

/** 覆写全部 7 个 abstract 钩子 + virtual，记录调用顺序。 */
class FakePipeline extends InitPipeline {
  readonly calls: string[] = [];
  protected ensureDirs(): void {
    this.calls.push('ensureDirs');
  }
  protected writeSettings(): void {
    this.calls.push('writeSettings');
  }
  protected writeMcp(): void {
    this.calls.push('writeMcp');
  }
  protected copySkills(): void {
    this.calls.push('copySkills');
  }
  protected copyCommands(): void {
    this.calls.push('copyCommands');
  }
  protected copyAgents(): void {
    this.calls.push('copyAgents');
  }
  protected writeHelpers(): void {
    this.calls.push('writeHelpers');
  }
  protected injectPluginTemplates(): void {
    this.calls.push('injectPluginTemplates');
  }
}

/** 只覆写 7 个 abstract 钩子——injectPluginTemplates 走继承的默认 no-op。 */
class NoVirtualPipeline extends InitPipeline {
  readonly calls: string[] = [];
  protected ensureDirs(): void {
    this.calls.push('ensureDirs');
  }
  protected writeSettings(): void {
    this.calls.push('writeSettings');
  }
  protected writeMcp(): void {
    this.calls.push('writeMcp');
  }
  protected copySkills(): void {
    this.calls.push('copySkills');
  }
  protected copyCommands(): void {
    this.calls.push('copyCommands');
  }
  protected copyAgents(): void {
    this.calls.push('copyAgents');
  }
  protected writeHelpers(): void {
    this.calls.push('writeHelpers');
  }
}

describe('InitPipeline.runSurface', () => {
  it('按 1→2→3→4→5→6→6b→7 顺序调用（injectPluginTemplates 在 6b 位）', async () => {
    const pipeline = new FakePipeline(CTX);
    // await 对 void 也合法：批 3 若把 runSurface 改 async，本断言无需改。
    await pipeline.runSurface();

    expect(pipeline.calls).toEqual([
      'ensureDirs', // 1
      'writeSettings', // 2
      'writeMcp', // 3
      'copySkills', // 4
      'copyCommands', // 5
      'copyAgents', // 6
      'injectPluginTemplates', // 6b
      'writeHelpers', // 7
    ]);
  });

  it('virtual injectPluginTemplates 默认 no-op（未覆写不报错、不入序列）', async () => {
    const pipeline = new NoVirtualPipeline(CTX);
    await pipeline.runSurface();

    expect(pipeline.calls).toEqual([
      'ensureDirs',
      'writeSettings',
      'writeMcp',
      'copySkills',
      'copyCommands',
      'copyAgents',
      'writeHelpers',
    ]);
  });
});

describe('InitPipeline.skip', () => {
  it('记录步骤名入 skipped、原因入 skipReasons，且不写 ctx', async () => {
    class SkipMcpPipeline extends FakePipeline {
      protected writeMcp(): void {
        this.skip('writeMcp', 'Codex 无 MCP 对等面');
      }
    }
    const pipeline = new SkipMcpPipeline(CTX);
    await pipeline.runSurface();

    expect(pipeline.skipped).toEqual(['writeMcp']);
    expect(pipeline.skipReasons.get('writeMcp')).toBe('Codex 无 MCP 对等面');
    expect(pipeline.calls).not.toContain('writeMcp');
    expect(CTX.mcp).toEqual({});
  });
});

describe('InitPipeline 工具方法', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'weave-harness-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** 暴露 protected 工具供断言。 */
  class ToolPipeline extends FakePipeline {
    mergeJson(filePath: string, data: Record<string, unknown>, force: boolean) {
      return this.writeOrMergeJson(filePath, data, force);
    }
    copyDir(srcDir: string, destDir: string, force = false) {
      return this.copyDirIfAbsent(srcDir, destDir, force);
    }
    sweep(target: string, keep: readonly string[], marker: string) {
      return this.sweepMarked(target, keep, marker);
    }
  }

  it('writeOrMergeJson 深合并写盘（保留已有叶子，data 覆盖同名）', async () => {
    const tools = new ToolPipeline(CTX);
    const file = path.join(dir, 'settings.json');

    expect(await tools.mergeJson(file, { a: { x: 1 }, b: 2 }, false)).toBe(true);
    expect(await tools.mergeJson(file, { a: { y: 2 }, c: 3 }, false)).toBe(true);

    const merged = JSON.parse(await readFile(file, 'utf-8'));
    expect(merged).toEqual({ a: { x: 1, y: 2 }, b: 2, c: 3 });

    expect(await tools.mergeJson(file, { a: { y: 2 } }, true)).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual({ a: { y: 2 } });
  });

  it('writeOrMergeJson 对存在但不可解析的文件跳过不覆写', async () => {
    const tools = new ToolPipeline(CTX);
    const file = path.join(dir, 'broken.json');
    await writeFile(file, 'not-json{', 'utf-8');

    expect(await tools.mergeJson(file, { a: 1 }, false)).toBe(false);
    expect(await readFile(file, 'utf-8')).toBe('not-json{');
  });

  it('copyDirIfAbsent 递归复制，已存在的目标文件默认跳过', async () => {
    const tools = new ToolPipeline(CTX);
    const src = path.join(dir, 'src');
    const dest = path.join(dir, 'dest');
    await mkdir(path.join(src, 'nested'), { recursive: true });
    await writeFile(path.join(src, 'a.txt'), 'new-a', 'utf-8');
    await writeFile(path.join(src, 'nested', 'b.txt'), 'src-b', 'utf-8');
    await mkdir(dest, { recursive: true });
    await writeFile(path.join(dest, 'a.txt'), 'user-a', 'utf-8');

    await tools.copyDir(src, dest);

    expect(await readFile(path.join(dest, 'a.txt'), 'utf-8')).toBe('user-a');
    expect(await readFile(path.join(dest, 'nested', 'b.txt'), 'utf-8')).toBe('src-b');
  });

  it('sweepMarked 删除带 marker 且不在 keep 清单的文件', async () => {
    const tools = new ToolPipeline(CTX);
    const target = path.join(dir, 'helpers');
    const marker = '@version weave@';
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'keep.cjs'), `// ${marker}`, 'utf-8');
    await writeFile(path.join(target, 'legacy.cjs'), `// ${marker}`, 'utf-8');
    await writeFile(path.join(target, 'user.cjs'), '// user file', 'utf-8');

    const removed = await tools.sweep(target, ['keep.cjs'], marker);

    expect(removed).toEqual([path.join(target, 'legacy.cjs')]);
    expect((await readdir(target)).sort()).toEqual(['keep.cjs', 'user.cjs']);
  });
});
