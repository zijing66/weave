import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createClaudePluginSurface, type PluginExecutor } from '@weave/harness';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository, type ProjectRow } from '../../repositories/projects.js';
import { PluginStateRepository } from '../../repositories/plugin-states.js';
import { hashFile } from '../../install/fingerprint.js';
import {
  ToolkitService,
  ToolkitError,
  detectClaudeVersion,
  evaluateModHostGate,
  isVersionAtLeast,
  MIN_MOD_HOST_VERSION,
} from '../toolkit.js';
import { addToolkitDir, readSourcesFile } from '../plugin-installer.js';

/**
 * 批 10 硬闸（5.6）逐条，批 3 修订 ①②④⑤ 与附带 CC 用例：
 * 闸① enable = 全局安装 + 项目启用（项目零副本、toolkit 记录仍写），
 *    disable = 关项目启用、全局安装保留；
 * 闸② 改写分支——改写的表面文件保留，其余按 checksum 还原、全局安装保留；
 * 闸③ 重复 enable 幂等（快照零变化）；
 * 闸④ 非 targets 表面零写入 + 项目零 CC 副本；
 * 闸⑤ 内置 vs add-dir 外置同包 enable 结果一致 + 两项目共享全局位、
 *    enabledPlugins 各自独立；
 * 另：mod 宿主版本闸、meta 索引同步、remove-dir 级联、weave 成分按项目开关。
 * CC CLI 走可注入假 executor（createClaudePluginSurface），home 用临时目录 mock。
 */

const BUILTIN_ROOT = fileURLToPath(new URL('../presets/harness-tools/', import.meta.url));

/** 文件树快照（rel posix → sha256）：闸①③ 的逐字节比较口径。 */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    const abs = path.join(dir, ...rel.split('/').filter(Boolean));
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(childRel);
      else out[childRel] = await hashFile(path.join(dir, ...childRel.split('/')));
    }
  };
  await walk('');
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

describe('toolkit 启用/禁用（硬闸）', () => {
  let db: DatabaseSync;
  let projects: ProjectRepository;
  let states: PluginStateRepository;
  let project: ProjectRow;
  let project2: ProjectRow;
  let base: string;
  let projectDir: string;
  let sourcesRoot: string;
  let extRoot: string;
  let service: ToolkitService;
  let loaderState: Map<string, boolean>;
  let execCalls: string[][];
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  /** 假 CLI：记录参数数组；install 时模拟 CC 写 installed_plugins.json。 */
  const fakeExec: PluginExecutor = async (args) => {
    execCalls.push(args);
    if (args[1] === 'install') {
      const key = args[2]!;
      const file = path.join(base, '.claude', 'plugins', 'installed_plugins.json');
      let json: { version: number; plugins: Record<string, unknown[]> } = {
        version: 2,
        plugins: {},
      };
      try {
        json = JSON.parse(await readFile(file, 'utf8'));
      } catch {
        // 首装：从空注册源开始
      }
      json.plugins[key] = [
        { scope: 'user', installPath: path.join(base, '.claude', 'plugins', 'cache', key), version: '0.1.0' },
      ];
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(json, null, 2));
    }
    return { stdout: '', stderr: '' };
  };

  /** 项目 settings 的 enabledPlugins（无文件/无键 → {}）。 */
  const enabledPluginsOf = async (dir: string): Promise<Record<string, boolean>> => {
    try {
      const json = JSON.parse(await readFile(path.join(dir, '.claude', 'settings.json'), 'utf8')) as {
        enabledPlugins?: Record<string, boolean>;
      };
      return json.enabledPlugins ?? {};
    } catch {
      return {};
    }
  };

  const installedKeys = async (): Promise<string[]> => {
    try {
      const json = JSON.parse(
        await readFile(path.join(base, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'),
      ) as { plugins?: Record<string, unknown> };
      return Object.keys(json.plugins ?? {});
    } catch {
      return [];
    }
  };

  const makeService = (claudeVersion?: () => Promise<string | null>): ToolkitService =>
    new ToolkitService({
      projects,
      states,
      builtinRoot: BUILTIN_ROOT,
      sourcesRoot,
      claudeVersion: claudeVersion ?? (async () => '2.1.288'),
      pluginSurface: createClaudePluginSurface({ exec: fakeExec }),
      plugins: {
        list: () => [],
        setPluginEnabled: (id, enabled) => {
          loaderState.set(id, enabled);
          states.setEnabled(id, enabled);
          return true;
        },
      },
    });

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'weave-tk-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = base;
    process.env.USERPROFILE = base;
    projectDir = path.join(base, 'proj');
    sourcesRoot = path.join(base, 'cfg');
    extRoot = path.join(base, 'ext-tools');
    await mkdir(projectDir, { recursive: true });
    await mkdir(sourcesRoot, { recursive: true });
    // 用户既有文件：settings.json / hooks 形态内容 + 指令文件（须逐字节还原）
    await mkdir(path.join(projectDir, '.claude'), { recursive: true });
    await writeFile(
      path.join(projectDir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] }] } }, null, 2),
    );
    await writeFile(path.join(projectDir, 'CLAUDE.md'), '# user project\n');

    db = openDatabase(':memory:');
    projects = new ProjectRepository(db);
    states = new PluginStateRepository(db);
    project = projects.register({ path: projectDir, name: 'p1', token: 't1', source: 'init' });
    project2 = projects.register({
      path: path.join(base, 'proj2'),
      name: 'p2',
      token: 't2',
      source: 'init',
    });
    await mkdir(project2.path, { recursive: true });
    loaderState = new Map();
    execCalls = [];
    service = makeService();
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    db.close();
    await rm(base, { recursive: true, force: true });
  });

  it('闸①：enable 全局安装+项目启用（项目零副本、CC-only 不写 toolkit 账本）；disable 关项目启用、全局保留', async () => {
    const before = await snapshot(projectDir);
    const { pack } = await service.enable(project.id, 'docs-reminder');
    expect(pack.enabled).toBe(true);
    const landed = await snapshot(projectDir);
    // 项目零 CC 副本（宿主不扫描项目插件位）
    expect(Object.keys(landed).some((f) => f.startsWith('.claude/plugins/'))).toBe(false);
    // CC-only 包不写 `.weave/toolkit/` 账本——生效链只在 installed_plugins +
    // 项目 enabledPlugins（用户边界：mod 启用与 weave 装配账本无关）
    expect(landed['.weave/toolkit/docs-reminder.json']).toBeUndefined();
    // 全局位落盘：weave marketplace 拷贝 + installed_plugins 登记
    const mktCopy = JSON.parse(
      await readFile(
        path.join(
          base,
          '.claude',
          'weave-marketplace',
          'plugins',
          'docs-reminder',
          '.claude-plugin',
          'plugin.json',
        ),
        'utf8',
      ),
    ) as { name?: string };
    expect(mktCopy.name).toBe('docs-reminder');
    expect(await installedKeys()).toContain('docs-reminder@weave');
    // 项目 enabledPlugins 开
    expect(await enabledPluginsOf(projectDir)).toEqual({ 'docs-reminder@weave': true });

    await service.disable(project.id, 'docs-reminder');
    const after = await snapshot(projectDir);
    const { '.claude/settings.json': _beforeSettings, ...beforeRest } = before;
    const { '.claude/settings.json': _afterSettings, ...afterRest } = after;
    expect(afterRest).toEqual(beforeRest);
    // settings.json 用户键原样、启用键关为 false（须覆盖用户层 true）
    const settings = JSON.parse(
      await readFile(path.join(projectDir, '.claude', 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(settings.hooks).toHaveProperty('Stop');
    expect(settings.enabledPlugins).toEqual({ 'docs-reminder@weave': false });
    // 全局安装保留；记录按既有语义删除
    expect(await installedKeys()).toContain('docs-reminder@weave');
    expect(after['.weave/toolkit/docs-reminder.json']).toBeUndefined();
  });

  it('闸②：改写分支——改写文件保留，其余按 checksum 还原；全局安装保留', async () => {
    await service.enable(project.id, 'code-review');
    const rewritten = '.codex/skills/code-review/SKILL.md';
    await writeFile(path.join(projectDir, ...rewritten.split('/')), '// user rewrote this\n');

    await service.disable(project.id, 'code-review');
    const after = await snapshot(projectDir);
    expect(after[rewritten]).toBe(await hashFile(path.join(projectDir, ...rewritten.split('/'))));
    // 项目零 CC 副本；记录删除
    expect(Object.keys(after).some((f) => f.startsWith('.claude/plugins/'))).toBe(false);
    expect(after['.weave/toolkit/code-review.json']).toBeUndefined();
    // 用户原文件仍在
    expect(after['.claude/settings.json']).toBeTruthy();
    // 全局安装保留（disable 只关项目启用）
    expect(await installedKeys()).toContain('code-review@weave');
    expect(await enabledPluginsOf(projectDir)).toEqual({ 'code-review@weave': false });
  });

  it('闸③：重复 enable 幂等——第二次无任何写入（快照零变化）', async () => {
    await service.enable(project.id, 'docs-reminder');
    const first = await snapshot(projectDir);
    const again = await service.enable(project.id, 'docs-reminder');
    expect(again.pack.enabled).toBe(true);
    expect(await snapshot(projectDir)).toEqual(first);
  });

  it('闸④：非 targets 表面零写入（项目零 CC 副本；双目标双落）', async () => {
    await service.enable(project.id, 'docs-reminder');
    const files = Object.keys(await snapshot(projectDir));
    expect(files.some((f) => f.startsWith('.codex/'))).toBe(false);
    expect(files.some((f) => f.startsWith('.claude/plugins/'))).toBe(false);

    await service.enable(project.id, 'code-review');
    const all = await snapshot(projectDir);
    // claude：全局安装，项目零副本
    expect(all['.claude/plugins/code-review/.claude-plugin/plugin.json']).toBeUndefined();
    expect(await installedKeys()).toContain('code-review@weave');
    // codex：表面解包 skills（cc 包不重复解 claude skills）
    expect(all['.codex/skills/code-review/SKILL.md']).toBeTruthy();
    expect(all['.claude/skills/code-review/SKILL.md']).toBeUndefined();
  });

  it('闸⑤：内置与外置同包 enable 结果一致；两项目共享全局位、enabledPlugins 各自独立', async () => {
    // 镜像内置结构到外置目录（scope 字段也要一致）
    await cp(BUILTIN_ROOT, extRoot, { recursive: true });
    await addToolkitDir(extRoot, sourcesRoot);

    const a = await service.enable(project.id, 'code-review', BUILTIN_ROOT);
    const b = await service.enable(project2.id, 'code-review', extRoot);

    const strip = (p: typeof a.pack) => {
      const { provenance: _p, sourceRoot: _s, dir: _d, ...rest } = p;
      return rest;
    };
    expect(strip(b.pack)).toEqual(strip(a.pack));
    expect(a.pack.provenance).toBe('builtin');
    expect(b.pack.provenance).toBe('external-dir');
    // 实际落盘（表面解包部分）逐文件一致；项目零 CC 副本
    const landed = async (dir: string): Promise<Record<string, string>> => {
      const snap = await snapshot(dir);
      return Object.fromEntries(Object.entries(snap).filter(([f]) => f.startsWith('.codex/')));
    };
    expect(await landed(project2.path)).toEqual(await landed(projectDir));
    expect(Object.keys(await snapshot(projectDir)).some((f) => f.startsWith('.claude/plugins/'))).toBe(
      false,
    );
    // 全局位只装一次（两项目共享同一全局安装）
    expect(execCalls.filter((args) => args[1] === 'install')).toHaveLength(1);
    expect(await installedKeys()).toContain('code-review@weave');

    // enabledPlugins 各自独立：各项目自己的 settings
    expect(await enabledPluginsOf(projectDir)).toEqual({ 'code-review@weave': true });
    expect(await enabledPluginsOf(project2.path)).toEqual({ 'code-review@weave': true });

    // 关 project2 不影响 project1
    await service.disable(project2.id, 'code-review', extRoot);
    expect(await enabledPluginsOf(project2.path)).toEqual({ 'code-review@weave': false });
    expect(await enabledPluginsOf(projectDir)).toEqual({ 'code-review@weave': true });
    expect((await service.list(project.id)).packs.find((p) => p.id === 'code-review')?.enabled).toBe(
      true,
    );
    expect(
      (await service.list(project2.id)).packs.find((p) => p.id === 'code-review')?.enabled,
    ).toBe(false);
  });

  it('存量项目副本读时自愈：record 前缀条目按 checksum 删副本重写 record；孤儿副本报 legacyCopies 并可清理', async () => {
    // 伪造旧管线状态：CC 包整体复制进项目插件位 + 记录文件
    const rel = '.claude/plugins/docs-reminder/hooks/reminder.cjs';
    const abs = path.join(projectDir, ...rel.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, '// copied by legacy pipeline\n');
    const recPath = path.join(projectDir, '.weave', 'toolkit', 'docs-reminder.json');
    await mkdir(path.dirname(recPath), { recursive: true });
    await writeFile(
      recPath,
      JSON.stringify(
        {
          packId: 'docs-reminder',
          provenance: 'builtin',
          sourceRoot: BUILTIN_ROOT,
          sourceDir: path.join(BUILTIN_ROOT, 'doc-hooks', 'docs-reminder'),
          enabledAt: new Date().toISOString(),
          files: { [rel]: await hashFile(abs) },
        },
        null,
        2,
      ),
    );

    const first = await service.list(project.id);
    // 记录条目读时自愈：副本删除、record 重写为无 legacy 条目
    expect((await snapshot(projectDir))[rel]).toBeUndefined();
    expect((JSON.parse(await readFile(recPath, 'utf8')) as { files: object }).files).toEqual({});
    expect(first.legacyCopies).toEqual([]);

    // 未被 record 覆盖的孤儿副本保留并报出（显式清理才删）
    const orphan = path.join(projectDir, '.claude', 'plugins', 'orphan', 'x.txt');
    await mkdir(path.dirname(orphan), { recursive: true });
    await writeFile(orphan, 'x');
    expect((await service.list(project.id)).legacyCopies).toEqual(['.claude/plugins/orphan']);

    const cleaned = await service.cleanupLegacyCopies(project.id);
    expect(cleaned.removed).toEqual(['.claude/plugins/orphan']);
    expect((await service.list(project.id)).legacyCopies).toEqual([]);
    // 幂等：再清一次为空
    expect((await service.cleanupLegacyCopies(project.id)).removed).toEqual([]);
    // 用户原文件不受影响
    expect((await snapshot(projectDir))['.claude/settings.json']).toBeTruthy();
  });

  it('mod 宿主版本闸：低版本明确拒绝不落盘；未知版本降级 warning；高版本放行', async () => {
    const low = makeService(async () => '2.1.100');
    await expect(low.enable(project.id, 'mission-control')).rejects.toMatchObject({
      name: 'ToolkitError',
      code: 'host-version',
    });
    // 不落盘：无任何 mission-control 文件、无记录
    expect(Object.keys(await snapshot(projectDir)).some((f) => f.includes('mission-control'))).toBe(
      false,
    );

    const unknown = makeService(async () => null);
    const res = await unknown.enable(project.id, 'mission-control');
    expect(res.pack.enabled).toBe(true);
    expect(res.warnings).toHaveLength(1);

    const ok = makeService(async () => '2.1.288');
    const res2 = await ok.enable(project2.id, 'mission-control');
    expect(res2.pack.enabled).toBe(true);
    expect(res2.warnings).toEqual([]);
  });

  it('mod 版本闸纯函数：semver 比较 / 降级 / 环境跳过', () => {
    expect(isVersionAtLeast('2.1.287', MIN_MOD_HOST_VERSION)).toBe(true);
    expect(isVersionAtLeast('2.2.0', MIN_MOD_HOST_VERSION)).toBe(true);
    expect(isVersionAtLeast('2.1.286', MIN_MOD_HOST_VERSION)).toBe(false);
    expect(isVersionAtLeast('3.0.0', MIN_MOD_HOST_VERSION)).toBe(true);
    expect(evaluateModHostGate('2.1.286')).toMatchObject({ ok: false });
    expect(evaluateModHostGate('2.1.287')).toMatchObject({ ok: true });
    expect(evaluateModHostGate(null)).toMatchObject({ ok: true });
    expect(evaluateModHostGate(null).warning).toBeTruthy();
    process.env.WEAVE_SKIP_MOD_VERSION_CHECK = '1';
    expect(evaluateModHostGate('0.0.1')).toMatchObject({ ok: true });
    delete process.env.WEAVE_SKIP_MOD_VERSION_CHECK;
  });

  it('detectClaudeVersion：真实 spawn（win32 走 shell）返回 semver 或 null（不抛）', async () => {
    const v = await detectClaudeVersion();
    expect(v === null || /^\d+\.\d+\.\d+$/.test(v)).toBe(true);
  });

  it('meta 索引同步：enable 记入 projects.meta.toolkit.enabled，disable 移除', async () => {
    expect(projects.getMeta(project.id)?.['toolkit']).toBeUndefined();
    await service.enable(project.id, 'docs-reminder');
    expect(projects.getMeta(project.id)).toMatchObject({
      toolkit: { enabled: ['docs-reminder'] },
    });
    await service.disable(project.id, 'docs-reminder');
    expect(projects.getMeta(project.id)).toMatchObject({ toolkit: { enabled: [] } });
  });

  it('weave 成分按项目开关（批 4 修订）：写 meta.plugins.enabled，不 flip 全局 plugin_states', async () => {
    const res = await service.enable(project.id, 'md-lint');
    expect(res.pack.enabled).toBe(true);
    // toolkit 开关与 plugins.enabled 同一状态源（D3 串项目修复）
    expect(projects.getMeta(project.id)).toMatchObject({
      plugins: { enabled: { 'md-lint': true } },
    });
    // 全局 plugin_states 行不被创建/翻转；loader 不被级联调用
    expect(states.get('md-lint')).toBeUndefined();
    expect(loaderState.has('md-lint')).toBe(false);
    // 无文件成分 → 不落记录文件
    const files = Object.keys(await snapshot(projectDir));
    expect(files.filter((f) => f.includes('md-lint'))).toEqual([]);

    // 串项目：另一未同步项目不继承本项目的启用
    expect(
      (await service.list(project2.id)).packs.find((p) => p.id === 'md-lint')?.enabled,
    ).toBe(false);

    const off = await service.disable(project.id, 'md-lint');
    expect(off.pack.enabled).toBe(false);
    expect(projects.getMeta(project.id)).toMatchObject({
      plugins: { enabled: { 'md-lint': false } },
    });
    expect(states.get('md-lint')).toBeUndefined();
  });

  it('扫描缺省停用：states 无行的 weave 包默认 disabled（opt-in）', async () => {
    const list = await service.list(project.id);
    const md = list.packs.find((p) => p.id === 'md-lint');
    expect(md).toMatchObject({ enabled: false });
  });

  it('remove-dir：移除外置目录注册并级联卸载其已启用包', async () => {
    // 外置目录放一个裸表面包（无 manifest，仅 skills/）
    const bare = path.join(extRoot, 'extras', 'my-skills');
    await mkdir(path.join(bare, 'skills', 'mine'), { recursive: true });
    await writeFile(path.join(bare, 'skills', 'mine', 'SKILL.md'), '# mine');
    await addToolkitDir(extRoot, sourcesRoot);

    const enabled = await service.enable(project.id, 'my-skills');
    expect(enabled.pack.provenance).toBe('external-dir');
    expect(
      (await snapshot(projectDir))['.claude/skills/mine/SKILL.md'],
    ).toBeTruthy();

    const result = await service.removeDir(extRoot);
    expect(result.disabled).toContain('my-skills');
    expect(result.dirs).not.toContain(path.resolve(extRoot));
    const after = await snapshot(projectDir);
    expect(after['.claude/skills/mine/SKILL.md']).toBeUndefined();
    expect(after['.weave/toolkit/my-skills.json']).toBeUndefined();
    await expect(readSourcesFile(sourcesRoot)).resolves.toMatchObject({ dirs: [] });
  });

  it('add-dir 幂等 + 未知包 404 + 未知项目 404', async () => {
    await mkdir(extRoot, { recursive: true });
    await service.addDir(extRoot);
    await service.addDir(extRoot);
    expect((await service.listDirs()).dirs).toEqual([path.resolve(extRoot)]);

    await expect(service.enable(project.id, 'nope-pack')).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(service.list(99999)).rejects.toBeInstanceOf(ToolkitError);
  });

  it('用户文件冲突 append-only：目标已存在不同内容时不覆盖、禁用不删', async () => {
    // 项目里预置 codex 表面同路径用户文件（内容不同于包内）
    const userFile = path.join(projectDir, '.codex', 'skills', 'project-navigation', 'SKILL.md');
    await mkdir(path.dirname(userFile), { recursive: true });
    await writeFile(userFile, '# my own navigation skill\n');
    const userHash = await hashFile(userFile);

    await service.enable(project.id, 'project-navigation');
    expect(await hashFile(userFile)).toBe(userHash); // 启用不覆盖用户文件

    await service.disable(project.id, 'project-navigation');
    const after = await snapshot(projectDir);
    // 用户文件保留（内容未变）
    expect(after['.codex/skills/project-navigation/SKILL.md']).toBe(userHash);
    // 项目零 CC 副本（批 3：原「插件位被还原」断言升级为零副本）
    expect(Object.keys(after).some((f) => f.startsWith('.claude/plugins/'))).toBe(false);
    expect(await enabledPluginsOf(projectDir)).toEqual({ 'project-navigation@weave': false });
  });
});
