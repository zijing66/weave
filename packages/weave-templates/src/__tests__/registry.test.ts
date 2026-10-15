import { describe, it, expect } from 'vitest';
import { TemplateRegistry } from '../index';

describe('TemplateRegistry', () => {
  it('模板不再自带内置 skill，commands/agents 照常注册', () => {
    const reg = new TemplateRegistry();
    expect(reg.getByCategory('skill').length).toBe(0);
    expect(reg.getByCategory('command').length).toBeGreaterThan(0);
    expect(reg.getByCategory('agent').length).toBeGreaterThan(0);
  });

  it('finds a template by name', () => {
    const reg = new TemplateRegistry();
    const command = reg.getByName('review');
    expect(command).toBeDefined();
    expect(command?.category).toBe('command');
    // 内置 skill 已移除
    expect(reg.getByName('code-review')).toBeUndefined();
  });

  it('returns undefined for an unknown name', () => {
    const reg = new TemplateRegistry();
    expect(reg.getByName('nonexistent')).toBeUndefined();
  });

  it('resolves source paths to absolute paths', () => {
    const reg = new TemplateRegistry();
    const entry = reg.getByName('writer');
    const resolved = reg.resolvePath(entry!);
    expect(resolved.endsWith('writer.md')).toBe(true);
    expect(resolved).toMatch(/^(\/|[A-Za-z]:\\)/); // absolute path
  });

  it('source dirs point inside the built-in repo', () => {
    const reg = new TemplateRegistry();
    for (const dir of [reg.getSkillsSourceDir(), reg.getCommandsSourceDir(), reg.getAgentsSourceDir()]) {
      expect(dir).toMatch(/resources[\\/]weave-market/);
    }
  });

  it('getAll returns all templates', () => {
    const reg = new TemplateRegistry();
    expect(reg.getAll().length).toBe(
      reg.getByCategory('skill').length + reg.getByCategory('command').length + reg.getByCategory('agent').length,
    );
  });
});
