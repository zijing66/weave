import { describe, it, expect } from 'vitest';
import { installCapabilities, type InstallCapabilities } from '../capabilities.js';
import { FILE_ASSET_SPECS, FILE_ASSET_CATEGORIES } from '../file-assets.js';

const caps: InstallCapabilities = installCapabilities();

function surfacesOf(cat: keyof InstallCapabilities['categories']) {
  return caps.categories[cat].surfaces;
}

function scopesOf(cat: keyof InstallCapabilities['categories'], harness: string) {
  return surfacesOf(cat).find((s) => s.harness === harness)?.scopes;
}

describe('installCapabilities', () => {
  it('文件资产矩阵逐格锚定 FILE_ASSET_SPECS 落点表（有 project ⇒ 项目面、有 user ⇒ 全局面）', () => {
    for (const cat of FILE_ASSET_CATEGORIES) {
      const dirs = FILE_ASSET_SPECS[cat].dirs;
      for (const harness of ['claude', 'codex'] as const) {
        const d = dirs[harness];
        const expectScopes = d
          ? [...(d.project ? (['project'] as const) : []), ...(d.user ? (['global'] as const) : [])]
          : undefined;
        expect(scopesOf(cat, harness), `${cat}/${harness}`).toEqual(expectScopes);
      }
    }
  });

  it('workflow/rule 仅项目（无 user 落点 → 全局拒）', () => {
    expect(scopesOf('workflow', 'claude')).toEqual(['project']);
    expect(scopesOf('rule', 'claude')).toEqual(['project']);
  });

  it('command/agent/output-style claude 双范围、无 codex 面', () => {
    for (const cat of ['command', 'agent', 'output-style'] as const) {
      expect(scopesOf(cat, 'claude')).toEqual(['project', 'global']);
      expect(scopesOf(cat, 'codex')).toBeUndefined();
    }
  });

  it('skill 双 harness 双范围', () => {
    expect(scopesOf('skill', 'claude')).toEqual(['project', 'global']);
    expect(scopesOf('skill', 'codex')).toEqual(['project', 'global']);
  });

  it('mcp：claude 双范围、codex 强制 global', () => {
    expect(scopesOf('mcp', 'claude')).toEqual(['project', 'global']);
    expect(scopesOf('mcp', 'codex')).toEqual(['global']);
  });

  it('类别表齐全（skill/mcp + 5 类文件资产）', () => {
    expect(Object.keys(caps.categories).sort()).toEqual(
      ['agent', 'command', 'mcp', 'output-style', 'rule', 'skill', 'workflow'].sort(),
    );
  });
});
