import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { HookRuleRepository } from '../../repositories/hook-rules.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { HookRuleRegistry } from '../registry.js';
import { HookEventBus } from '../bus.js';
import {
  MirrorWriter,
  buildMirrorDoc,
  hookShardId,
  hooksRoot,
  mirrorPathOf,
  type HookMirrorDoc,
} from '../mirror.js';

describe('buildMirrorDoc：只投影 hook 本地可裁决的 inject 规则', () => {
  let db: DatabaseSync;
  let projects: ProjectRepository;
  let registry: HookRuleRegistry;
  let projectId: number;

  const read = async (dataDir: string, token: string): Promise<HookMirrorDoc> =>
    JSON.parse(await readFile(mirrorPathOf(hooksRoot(dataDir), hookShardId(token)), 'utf8'));

  beforeEach(() => {
    db = openDatabase(':memory:');
    projects = new ProjectRepository(db);
    projectId = projects.register({ path: '/proj', name: 'p', token: 'tok-m', source: 'init' }).id;
    registry = new HookRuleRegistry(new HookRuleRepository(db));
  });

  afterEach(() => db.close());

  const injectRule = (
    name: string,
    over: { priority?: number; projectId?: number | null; event?: string; filter?: object; template?: string } = {},
  ) =>
    registry.create({
      name,
      projectId: over.projectId === undefined ? null : over.projectId,
      priority: over.priority ?? 0,
      source: { kind: 'claude-event', event: over.event ?? 'PostToolUse' },
      filter: over.filter ?? {},
      handler: { type: 'inject', template: over.template ?? `t ${name}` },
    });

  it('保留 claude inject 规则并按 priority 降序；过滤 plugin/manual/项目外/crossProjectOnly', () => {
    const otherId = projects.register({ path: '/other', name: 'o', token: 'tok-o', source: 'init' }).id;
    injectRule('low', { priority: 0 });
    injectRule('high', { priority: 10, filter: { toolNames: ['Edit'], pathGlobs: ['**/*.md'] } });
    injectRule('other-project', { projectId: otherId });
    injectRule('cross', { filter: { crossProjectOnly: true } });
    registry.create({
      name: 'manual-rule',
      projectId: null,
      source: { kind: 'claude-event', event: 'PostToolUse' },
      handler: { type: 'manual', template: 'x' },
    });
    registry.create({
      name: 'disabled',
      enabled: false,
      projectId: null,
      source: { kind: 'claude-event', event: 'PostToolUse' },
      handler: { type: 'inject', template: 'x' },
    });
    registry.create({
      name: 'webhook-rule',
      projectId: null,
      source: { kind: 'webhook', routeId: 'r1' },
      handler: { type: 'webhook', url: 'http://x' },
    });

    const project = projects.getById(projectId)!;
    const doc = buildMirrorDoc(project, registry.list(), { s1: '标题' });
    expect(doc.version).toBe(1);
    expect(doc.project).toBe('proj');
    expect(doc.pendingTitles).toEqual({ s1: '标题' });
    expect(doc.rules.map((r) => r.name)).toEqual(['high', 'low']);
    expect(doc.rules[0]).toMatchObject({
      events: ['PostToolUse'],
      tools: ['Edit'],
      globs: ['**/*.md'],
      template: 't high',
    });
    expect(doc.rules[1]!.tools).toBeNull();
    expect(doc.rules[1]!.globs).toBeNull();
  });

  it('逐条盖章归属 harness：多 harness 的 inject 规则同进一份镜像，不在服务端剪枝', () => {
    injectRule('claude-rule');
    // 归属票来自 source.harness；storage 侧只允许具体 harness 挂 inject（'any' 只作
    // 投影层的兜底），故这里绕过 registry 校验直接喂投影函数。
    const rules = ['codex', 'any'].map((harness) => ({
      ...registry.list()[0]!,
      name: `${harness}-rule`,
      source: { kind: 'hook-event' as const, harness: harness as 'codex' | 'any', event: 'PostToolUse' },
    }));

    const doc = buildMirrorDoc(projects.getById(projectId)!, [...registry.list(), ...rules], {});
    const owner = new Map(doc.rules.map((r) => [r.name, r.harness]));
    expect([...owner.keys()].sort()).toEqual(['any-rule', 'claude-rule', 'codex-rule']);
    expect(owner.get('claude-rule')).toBe('claude');
    expect(owner.get('codex-rule')).toBe('codex');
    expect(owner.get('any-rule')).toBe('any');
  });

  it('项目范围规则只进本项目的 mirror', () => {
    injectRule('scoped', { projectId });
    const doc = buildMirrorDoc(projects.getById(projectId)!, registry.list(), {});
    expect(doc.rules.map((r) => r.name)).toEqual(['scoped']);
  });

  it('MirrorWriter 落盘到 <dataDir>/hooks/mirror/<shard>.json（tmp+rename 原子换）', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'weave-mirror-'));
    try {
      injectRule('r1');
      const writer = new MirrorWriter({ dataDir, projects, rules: registry, sessions: new SessionRepository(db) });
      writer.syncAll();
      const doc = await read(dataDir, 'tok-m');
      expect(doc.rules.map((r) => r.name)).toEqual(['r1']);
      expect(doc.project).toBe('proj');
      expect(doc.pendingTitles).toEqual({});
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('pendingTitles 只带本项目的挂起改名', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'weave-mirror-'));
    try {
      const sessions = new SessionRepository(db);
      sessions.touch('s1', projectId);
      sessions.setPendingTitle('s1', '新名');
      const writer = new MirrorWriter({ dataDir, projects, rules: registry, sessions });
      writer.syncProject(projectId);
      const doc = await read(dataDir, 'tok-m');
      expect(doc.pendingTitles).toEqual({ s1: '新名' });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('attachToBus：session.renamed 触发重写（改名交付落定后 mirror 里同步清掉）', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'weave-mirror-'));
    try {
      const sessions = new SessionRepository(db);
      const bus = new HookEventBus();
      sessions.touch('s1', projectId);
      sessions.setPendingTitle('s1', '待生效');
      const writer = new MirrorWriter({ dataDir, projects, rules: registry, sessions });
      writer.attachToBus(bus);
      writer.syncProject(projectId);
      expect((await read(dataDir, 'tok-m')).pendingTitles).toEqual({ s1: '待生效' });

      // 交付落定：pending 清空 → session.renamed → mirror 重写
      sessions.confirmPendingTitle('s1', '待生效');
      bus.emit({ kind: 'session.renamed', sessionId: 's1', title: '待生效', at: new Date().toISOString() });
      expect((await read(dataDir, 'tok-m')).pendingTitles).toEqual({});
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
