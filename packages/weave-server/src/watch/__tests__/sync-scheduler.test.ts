import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SyncScheduler } from '../sync-scheduler.js';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { LibraryRepository } from '../../repositories/libraries.js';
import { readProjectConfig } from '../../install/project-config.js';
import { setGlobalStatuslineDir } from '../../statusline/manager.js';

/**
 * 去掉 per-project autoSync 开关后的调度行为：tick 无条件扫全部项目，落盘范围
 * 全由 git 分类单点决定——不进 git 的 init 生成物自愈，会进 git 的只报不写。
 */

let projectDir: string;
let fakeHome: string;
let globalDir: string;
let origHome: string | undefined;
let origProfile: string | undefined;
let projects: ProjectRepository;
let libs: LibraryRepository;
let db: ReturnType<typeof openDatabase>;
let scheduler: SyncScheduler;

beforeEach(() => {
  origHome = process.env.HOME;
  origProfile = process.env.USERPROFILE;
  fakeHome = mkdtempSync(path.join(tmpdir(), 'weave-sched-home-'));
  projectDir = mkdtempSync(path.join(tmpdir(), 'weave-sched-proj-'));
  globalDir = mkdtempSync(path.join(tmpdir(), 'weave-sched-g-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  setGlobalStatuslineDir(globalDir);
  db = openDatabase(':memory:');
  projects = new ProjectRepository(db);
  libs = new LibraryRepository(db, fakeHome);
  projects.register({
    path: projectDir,
    name: 'proj',
    token: 't',
    source: 'init',
  });
  scheduler = new SyncScheduler(projects, libs);
});

afterEach(() => {
  scheduler.stop();
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = origProfile;
  for (const dir of [fakeHome, projectDir, globalDir]) rmSync(dir, { recursive: true, force: true });
  db.close();
});

function git(...args: string[]): void {
  execFileSync('git', ['-C', projectDir, ...args], { stdio: 'ignore' });
}

/** init 跑过的项目：`.weave/config.yaml` 在，生成物期望态才有出处。 */
function writeConfig(): void {
  const runtimeConfig = {
    initVersion: '0.0.1',
    initTimestamp: new Date().toISOString(),
    preset: 'default',
    harnesses: ['claude'],
    components: {
      settings: true,
      skills: true,
      commands: false,
      agents: false,
      helpers: true,
      mcp: false,
      claudeMd: true,
      agentsMd: true,
    },
  };
  mkdirSync(path.join(projectDir, '.weave'), { recursive: true });
  writeFileSync(
    path.join(projectDir, '.weave', 'config.yaml'),
    Object.entries(runtimeConfig)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join('\n') + '\n',
  );
}

const handlerRel = '.claude/helpers/hook-handler.cjs';
const handlerPath = () => path.join(projectDir, ...handlerRel.split('/'));

describe('SyncScheduler — git 分类决定自动/手动', () => {
  it('不进 git 的 init 生成物随 tick 自愈（非 git 仓库全算自动）', async () => {
    writeConfig();
    mkdirSync(path.dirname(handlerPath()), { recursive: true });
    writeFileSync(handlerPath(), '// @version weave@0.0.1\nold\n');

    await scheduler.tick();

    expect(readFileSync(handlerPath(), 'utf-8')).not.toContain('0.0.1\nold');
    expect(readFileSync(handlerPath(), 'utf-8')).toContain('@version weave@');
    expect((await readProjectConfig(projectDir)).lastSyncAt).not.toBeNull();
  });

  it('会进 git 的漂移：tick 只报不写，也不记同步时刻', async () => {
    writeConfig();
    mkdirSync(path.dirname(handlerPath()), { recursive: true });
    writeFileSync(handlerPath(), '// @version weave@0.0.1\nold\n');
    git('init');
    git('add', '-f', handlerRel);

    await scheduler.tick();

    expect(readFileSync(handlerPath(), 'utf-8')).toBe('// @version weave@0.0.1\nold\n');
    expect(existsSync(path.join(projectDir, '.weave', 'config.json'))).toBe(false);
    expect((await readProjectConfig(projectDir)).lastSyncAt).toBeNull();
  });

  it('tick 扫全部项目——没有 per-project 开关能挡', async () => {
    writeConfig();
    const other = mkdtempSync(path.join(tmpdir(), 'weave-sched-proj2-'));
    try {
      // 第二个项目用同样的期望态，但没有注册到任何「开关」上。
      mkdirSync(path.join(other, '.weave'), { recursive: true });
      writeFileSync(
        path.join(other, '.weave', 'config.yaml'),
        readFileSync(path.join(projectDir, '.weave', 'config.yaml'), 'utf-8'),
      );
      mkdirSync(path.join(other, '.claude', 'helpers'), { recursive: true });
      writeFileSync(path.join(other, '.claude', 'helpers', 'hook-handler.cjs'), '// @version weave@0.0.1\nold\n');
      projects.register({ path: other, name: 'proj2', token: 't2', source: 'init' });
      mkdirSync(path.dirname(handlerPath()), { recursive: true });
      writeFileSync(handlerPath(), '// @version weave@0.0.1\nold\n');

      await scheduler.tick();

      for (const dir of [projectDir, other]) {
        const body = readFileSync(path.join(dir, '.claude', 'helpers', 'hook-handler.cjs'), 'utf-8');
        expect(body).toContain('@version weave@');
        expect(body).not.toContain('0.0.1\nold');
      }
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
