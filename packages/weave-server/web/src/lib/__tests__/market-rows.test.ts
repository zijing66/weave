import { describe, it, expect } from 'vitest';
import {
  buildInstallationIndex,
  filterAndRankRows,
  installationKeyOf,
  installationKeyOfRow,
  rowsOfLibrary,
  type MarketRow,
} from '../market-rows';
import type { InstallationRow } from '@/lib/api';

const lib = {
  skills: [
    { name: 'review', dirPath: '/a', relPath: 'skills/review', group: '' },
    { name: 'docs', dirPath: '/b', relPath: 'x/skills/docs', group: 'x' },
  ],
  mcp: [{ name: 'srv', command: 'npx', sourcePath: '/c', relPath: 'm.json' }],
  files: [
    { name: 'cmd-a', filePath: '/d', relPath: 'f.md', group: '', category: 'command' as const },
  ],
  plugins: [
    {
      name: 'pack',
      version: '1.0.0',
      dirPath: '/e',
      relPath: 'p',
      ccPack: true,
      weavePack: false,
      kind: 'skill' as const,
      components: [],
      targets: ['claude' as const],
      skills: [],
    },
  ],
};

describe('rowsOfLibrary', () => {
  it('四类摊平，uid 含类别不撞键', () => {
    const rows = rowsOfLibrary(7, lib);
    expect(rows.map((r) => r.kind)).toEqual(['skill', 'skill', 'mcp', 'command', 'plugin']);
    expect(new Set(rows.map((r) => r.uid)).size).toBe(5);
    expect(rows[0]).toMatchObject({ marketId: 7, name: 'review', skill: lib.skills[0] });
  });
});

describe('buildInstallationIndex / installationKeyOfRow', () => {
  it('同键多行聚成一组；plugin 行键优先于名', () => {
    const rows: InstallationRow[] = [
      { kind: 'skill', name: 'foo', projectId: 1, projectName: 'a', scope: 'project', harness: 'claude' },
      { kind: 'skill', name: 'foo', projectId: 2, projectName: 'b', scope: 'project', harness: 'claude' },
      { kind: 'plugin', name: 'pack', key: 'pack@weave', projectId: null, projectName: null, scope: 'user', harness: 'claude' },
    ];
    const index = buildInstallationIndex(rows);
    expect(index.get(installationKeyOf('skill', 'foo'))).toHaveLength(2);
    expect(index.get(installationKeyOf('plugin', 'pack', 'pack@weave'))).toHaveLength(1);
    // 名字相同但键不同的 plugin 行不串组
    expect(index.get(installationKeyOf('plugin', 'pack'))).toBeUndefined();
  });

  it('市场行的索引键与安装行同键空间', () => {
    const row: MarketRow = {
      uid: '1:plugin:pack',
      marketId: 1,
      kind: 'plugin',
      name: 'pack',
      plugin: { ...lib.plugins[0]!, key: 'pack@weave' },
    };
    expect(installationKeyOfRow(row)).toBe(installationKeyOf('plugin', 'pack', 'pack@weave'));
  });
});

describe('filterAndRankRows', () => {
  const rows: MarketRow[] = [
    { uid: '1', marketId: 1, kind: 'skill', name: 'code-review' },
    { uid: '2', marketId: 1, kind: 'skill', name: 'reviewer' },
    { uid: '3', marketId: 1, kind: 'skill', name: 'rweiv' },
    { uid: '4', marketId: 1, kind: 'skill', name: 'docs' },
  ];
  it('空查询原样返回', () => {
    expect(filterAndRankRows(rows, '')).toHaveLength(4);
    expect(filterAndRankRows(rows, '   ')).toHaveLength(4);
  });
  it('三档：前缀 > 包含 > 子序列；不命中剔除', () => {
    const out = filterAndRankRows(rows, 'rev');
    // reviewer 前缀(3)、code-review 包含(2)、rweiv 子序列(1)
    expect(out.map((r) => r.name)).toEqual(['reviewer', 'code-review', 'rweiv']);
    expect(filterAndRankRows(rows, 'zzz')).toHaveLength(0);
  });
  it('大小写不敏感', () => {
    expect(filterAndRankRows(rows, 'REV')[0]?.name).toBe('reviewer');
  });
});
