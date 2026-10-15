import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectPluginTemplateUpdates, materializePluginTemplate } from '../plugin-templates.js';
import { detectProjectUpdateCounts, detectUpdates } from '../updates.js';
import { syncAll } from '../apply-update.js';
import { FingerprintCache } from '../fingerprint.js';

/**
 * 项目自有 weave 源（`.weave/plugins` 的 manifest.templates）的物化漂移：
 * 声明即期望态——目标缺失/内容不同即 outdated，显式同步覆盖物化。
 */

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), 'weave-pt-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function writePlugin(): void {
  const dir = path.join(projectDir, '.weave', 'plugins', 'demo-plug');
  mkdirSync(path.join(dir, 'agents'), { recursive: true });
  mkdirSync(path.join(dir, 'skills', 'demo-skill'), { recursive: true });
  writeFileSync(
    path.join(dir, 'weave-plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: 'demo-plug',
      name: 'Demo',
      version: '0.1.0',
      templates: { agents: ['agents/auditor.md'], skills: ['skills/demo-skill'] },
    }),
  );
  writeFileSync(path.join(dir, 'agents', 'auditor.md'), '# agent v1');
  writeFileSync(path.join(dir, 'skills', 'demo-skill', 'SKILL.md'), '# skill v1');
}

const detect = () => detectPluginTemplateUpdates(projectDir, new FingerprintCache());

const targetOf = (category: string): string => {
  const base = category === 'skill' ? 'demo-skill' : 'auditor.md';
  const sub = category === 'skill' ? 'skills' : 'agents';
  return path.join(projectDir, '.claude', sub, base);
};

describe('detectPluginTemplateUpdates', () => {
  it('目标缺失 → 全报 outdated，落点经 AssetSurface 解析', async () => {
    writePlugin();
    const list = await detect();
    expect(list.map((t) => t.targetPath).sort()).toEqual(
      [targetOf('agent'), targetOf('skill')].sort(),
    );
    expect(list.every((t) => t.outdated)).toBe(true);
  });

  it('物化后一致即静默；手改 / 删除副本又报 outdated', async () => {
    writePlugin();
    for (const t of await detect()) await materializePluginTemplate(t);
    expect((await detect()).some((t) => t.outdated)).toBe(false);
    expect(readFileSync(targetOf('agent'), 'utf8')).toBe('# agent v1');

    writeFileSync(targetOf('agent'), '# 手改');
    expect((await detect()).find((t) => t.category === 'agent')).toMatchObject({
      outdated: true,
      name: 'auditor',
      pluginId: 'demo-plug',
    });

    rmSync(targetOf('skill'), { recursive: true, force: true });
    expect((await detect()).find((t) => t.category === 'skill')).toMatchObject({
      outdated: true,
      name: 'demo-skill',
    });
  });
});

describe('更新报告 / 同步面接入', () => {
  it('无 libraries 也检测项目模板，且计入 available', async () => {
    writePlugin();
    const r = await detectUpdates(projectDir, [], new FingerprintCache());
    expect(r.pluginTemplates).toHaveLength(2);
    expect(r.available).toBe(2);
  });

  it('syncAll 覆盖物化模板，增量并入 updated', async () => {
    writePlugin();
    const { updated } = await syncAll(projectDir, [], new FingerprintCache());
    expect(updated).toEqual(
      expect.arrayContaining([
        { category: 'agent', name: 'auditor', scope: 'project' },
        { category: 'skill', name: 'demo-skill', scope: 'project' },
      ]),
    );
    expect(existsSync(targetOf('agent'))).toBe(true);
    expect(existsSync(path.join(targetOf('skill'), 'SKILL.md'))).toBe(true);
    expect((await detectUpdates(projectDir, [], new FingerprintCache())).available).toBe(0);
  });

  it('detectProjectUpdateCounts 一次算全项目（无漂移 = 0，角标推送面数据源）', async () => {
    writePlugin();
    const empty = mkdtempSync(path.join(tmpdir(), 'weave-pt-empty-'));
    try {
      const counts = await detectProjectUpdateCounts(
        [
          { id: 1, path: projectDir },
          { id: 2, path: empty },
        ],
        [],
        new FingerprintCache(),
      );
      expect(counts).toEqual({ 1: 2, 2: 0 });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
