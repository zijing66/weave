import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
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
 * 批 10 硬闸（5.6）逐条：
 * 闸① 无改写主用例——enable→disable 后文件树逐字节还原；
 * 闸② 改写分支——改写文件保留，其余按 checksum 还原；
 * 闸③ 重复 enable 幂等（快照零变化）；
 * 闸④ 非 targets 表面零写入；
 * 闸⑤ 内置 vs add-dir 外置同包 enable 结果一致（provenance 除外）；
 * 另：mod 宿主版本闸、meta 索引同步、remove-dir 级联、weave 成分级联。
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

  const makeService = (claudeVersion?: () => Promise<string | null>): ToolkitService =>
    new ToolkitService({
      projects,
      states,
      builtinRoot: BUILTIN_ROOT,
      sourcesRoot,
      claudeVersion: claudeVersion ?? (async () => '2.1.288'),
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
    service = makeService();
  });

  afterEach(async () => {
    db.close();
    await rm(base, { recursive: true, force: true });
  });

  it('闸①：无改写主用例——enable→disable 后文件树逐字节还原', async () => {
    const before = await snapshot(projectDir);
    const { pack } = await service.enable(project.id, 'docs-reminder');
    expect(pack.enabled).toBe(true);
    // 落盘：插件位整体（含 .claude-plugin 结构保持）
    const landed = await snapshot(projectDir);
    expect(landed['.claude/plugins/docs-reminder/.claude-plugin/plugin.json']).toBeTruthy();
    expect(landed['.claude/plugins/docs-reminder/hooks/reminder.cjs']).toBeTruthy();
    expect(landed['.weave/toolkit/docs-reminder.json']).toBeTruthy();

    await service.disable(project.id, 'docs-reminder');
    const after = await snapshot(projectDir);
    expect(after).toEqual(before);
    // settings.json 从未被触碰（内容一致由快照保证）
    expect(JSON.parse(await readFile(path.join(projectDir, '.claude', 'settings.json'), 'utf8')))
      .toHaveProperty('hooks.Stop');
  });

  it('闸②：改写分支——改写文件保留，其余按 checksum 还原', async () => {
    await service.enable(project.id, 'docs-reminder');
    const rewritten = '.claude/plugins/docs-reminder/hooks/reminder.cjs';
    await writeFile(path.join(projectDir, ...rewritten.split('/')), '// user rewrote this\n');

    await service.disable(project.id, 'docs-reminder');
    const after = await snapshot(projectDir);
    expect(after[rewritten]).toBe(await hashFile(path.join(projectDir, ...rewritten.split('/'))));
    // 其余包文件按 checksum 删除
    expect(after['.claude/plugins/docs-reminder/.claude-plugin/plugin.json']).toBeUndefined();
    expect(after['.weave/toolkit/docs-reminder.json']).toBeUndefined();
    // 用户原文件仍在
    expect(after['.claude/settings.json']).toBeTruthy();
  });

  it('闸③：重复 enable 幂等——第二次无任何写入（快照零变化）', async () => {
    await service.enable(project.id, 'docs-reminder');
    const first = await snapshot(projectDir);
    const again = await service.enable(project.id, 'docs-reminder');
    expect(again.pack.enabled).toBe(true);
    expect(await snapshot(projectDir)).toEqual(first);
  });

  it('闸④：非 targets 表面零写入（claude-only 不碰 .codex；双目标双落）', async () => {
    await service.enable(project.id, 'docs-reminder');
    const files = Object.keys(await snapshot(projectDir));
    expect(files.some((f) => f.startsWith('.codex/'))).toBe(false);

    await service.enable(project.id, 'code-review');
    const all = await snapshot(projectDir);
    // claude：插件位整体
    expect(all['.claude/plugins/code-review/.claude-plugin/plugin.json']).toBeTruthy();
    // codex：表面解包 skills（cc 包不重复解 claude skills）
    expect(all['.codex/skills/code-review/SKILL.md']).toBeTruthy();
    expect(all['.claude/skills/code-review/SKILL.md']).toBeUndefined();
  });

  it('闸⑤：内置与 add-dir 外置同包 enable 结果一致（provenance/sourceRoot/dir 除外）', async () => {
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
    // 实际落盘（包内容部分，剔除带 provenance 的记录文件与用户预置文件）逐文件一致
    const landed = async (dir: string): Promise<Record<string, string>> => {
      const snap = await snapshot(dir);
      return Object.fromEntries(
        Object.entries(snap).filter(
          ([f]) =>
            (f.startsWith('.claude/plugins/') || f.startsWith('.codex/')) &&
            !f.startsWith('.weave/'),
        ),
      );
    };
    expect(await landed(project2.path)).toEqual(await landed(projectDir));
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

  it('weave 成分级联：md-lint（weave-only）无落盘，开关走 plugin_states 级联事实', async () => {
    const res = await service.enable(project.id, 'md-lint');
    expect(res.pack.enabled).toBe(true);
    expect(loaderState.get('md-lint')).toBe(true);
    expect(states.get('md-lint')?.enabled).toBe(true);
    // 无文件成分 → 不落记录文件
    const files = Object.keys(await snapshot(projectDir));
    expect(files.filter((f) => f.includes('md-lint'))).toEqual([]);

    const off = await service.disable(project.id, 'md-lint');
    expect(off.pack.enabled).toBe(false);
    expect(states.get('md-lint')?.enabled).toBe(false);
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
    // 无冲突的插件位部分被还原
    expect(after['.claude/plugins/project-navigation/.claude-plugin/plugin.json']).toBeUndefined();
  });
});
