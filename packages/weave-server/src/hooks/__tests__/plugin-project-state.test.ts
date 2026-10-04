import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository, type ProjectRow } from '../../repositories/projects.js';
import { PluginStateRepository } from '../../repositories/plugin-states.js';
import {
  pluginsStateOf,
  effective,
  setProjectEnabled,
  syncPlugins,
} from '../plugin-project-state.js';

/**
 * D3 plugin-project-state：effective 三分支单点 + syncPlugins 同步语义。
 * 分支①显式覆盖 → ②已同步未启用 → ③回落全局 plugin_states 行；
 * 同步只补「无显式记录」的 enabled=false，显式选择永不覆盖。
 */
describe('plugin-project-state', () => {
  let db: DatabaseSync;
  let projects: ProjectRepository;
  let states: PluginStateRepository;
  let project: ProjectRow;

  beforeEach(() => {
    db = openDatabase(':memory:');
    projects = new ProjectRepository(db);
    states = new PluginStateRepository(db);
    project = projects.register({ path: 'D:\\p', name: 'p', token: 't', source: 'init' });
  });

  afterEach(() => db.close());

  /** setMeta 后重取行（effective 读 row.meta，须拿写后的快照）。 */
  const fresh = (): ProjectRow => projects.getById(project.id)!;

  it('分支①：显式覆盖优先于全局与 syncedAt', () => {
    states.setEnabled('demo', true);
    projects.setMeta(project.id, {
      plugins: { syncedAt: '2026-01-01T00:00:00.000Z', enabled: { demo: false } },
    });
    expect(effective(fresh(), 'demo', { states })).toBe(false);

    states.setEnabled('other', false);
    projects.setMeta(project.id, { plugins: { syncedAt: null, enabled: { other: true } } });
    expect(effective(fresh(), 'other', { states })).toBe(true);
  });

  it('分支②：已同步无显式记录 → false（即使全局为 true）', () => {
    states.setEnabled('demo', true);
    projects.setMeta(project.id, { plugins: { syncedAt: '2026-01-01T00:00:00.000Z', enabled: {} } });
    expect(effective(fresh(), 'demo', { states })).toBe(false);
  });

  it('分支③：未同步回落全局行；无全局行按调用面默认', () => {
    // 有行 → 行值
    states.setEnabled('demo', true);
    expect(effective(fresh(), 'demo', { states })).toBe(true);
    states.setEnabled('demo', false);
    expect(effective(fresh(), 'demo', { states })).toBe(false);
    // 无行 → dispatcher/管理面语义 true，toolkit 读侧 ?? false
    expect(effective(fresh(), 'ghost', { states })).toBe(true);
    expect(effective(fresh(), 'ghost', { states, defaultEnabled: false })).toBe(false);
  });

  it('pluginsStateOf：缺失/损坏/形态不对 → 未同步空覆盖', () => {
    expect(pluginsStateOf(null)).toEqual({ syncedAt: null, enabled: {} });
    expect(pluginsStateOf('not json')).toEqual({ syncedAt: null, enabled: {} });
    expect(pluginsStateOf('[]')).toEqual({ syncedAt: null, enabled: {} });
    expect(pluginsStateOf('{"toolkit":{"enabled":["x"]}}')).toEqual({
      syncedAt: null,
      enabled: {},
    });
    expect(
      pluginsStateOf('{"plugins":{"syncedAt":123,"enabled":{"a":true,"b":"x"}}}'),
    ).toEqual({ syncedAt: null, enabled: { a: true } });
  });

  it('setProjectEnabled：写 meta.plugins.enabled，保留 syncedAt 与其他顶层键', () => {
    projects.setMeta(project.id, {
      toolkit: { enabled: ['keep-me'] },
      plugins: { syncedAt: 't1', enabled: { other: true } },
    });
    setProjectEnabled(fresh(), 'demo', true, { projects });
    expect(projects.getMeta(project.id)).toMatchObject({
      toolkit: { enabled: ['keep-me'] },
      plugins: { syncedAt: 't1', enabled: { other: true, demo: true } },
    });
    setProjectEnabled(fresh(), 'demo', false, { projects });
    expect(projects.getMeta(project.id)).toMatchObject({
      plugins: { syncedAt: 't1', enabled: { other: true, demo: false } },
    });
  });

  it('syncPlugins：写 syncedAt + 只补无显式记录为 false（显式选择永不覆盖）', () => {
    projects.setMeta(project.id, {
      toolkit: { enabled: ['x'] },
      plugins: { syncedAt: null, enabled: { kept: true, dropped: false } },
    });
    const syncedAt = syncPlugins(fresh(), ['kept', 'dropped', 'fresh'], {
      projects,
      now: '2026-02-02T00:00:00.000Z',
    });
    expect(syncedAt).toBe('2026-02-02T00:00:00.000Z');
    expect(projects.getMeta(project.id)).toMatchObject({
      toolkit: { enabled: ['x'] },
      plugins: {
        syncedAt: '2026-02-02T00:00:00.000Z',
        enabled: { kept: true, dropped: false, fresh: false },
      },
    });

    // 再同步：显式 true 不被改写，新发现的插件补 false
    syncPlugins(fresh(), ['kept', 'fresh', 'newcomer'], { projects, now: 't3' });
    expect(projects.getMeta(project.id)).toMatchObject({
      plugins: { syncedAt: 't3', enabled: { kept: true, dropped: false, fresh: false, newcomer: false } },
    });

    // 同步后语义：无显式记录的插件 → 分支②不命中
    expect(effective(fresh(), 'unknown', { states })).toBe(false);
  });
});
