import { describe, it, expect } from 'vitest';
import { TemplateRegistry } from '../index';

describe('TemplateRegistry', () => {
  it('registers skills, commands, and agents', () => {
    const reg = new TemplateRegistry();
    expect(reg.getByCategory('skill').length).toBeGreaterThan(0);
    expect(reg.getByCategory('command').length).toBeGreaterThan(0);
    expect(reg.getByCategory('agent').length).toBeGreaterThan(0);
  });

  it('finds a template by name', () => {
    const reg = new TemplateRegistry();
    const skill = reg.getByName('code-review');
    expect(skill).toBeDefined();
    expect(skill?.category).toBe('skill');
  });

  it('returns undefined for an unknown name', () => {
    const reg = new TemplateRegistry();
    expect(reg.getByName('nonexistent')).toBeUndefined();
  });

  it('resolves source paths to absolute paths', () => {
    const reg = new TemplateRegistry();
    const entry = reg.getByName('coder');
    const resolved = reg.resolvePath(entry!);
    expect(resolved.endsWith('coder.md')).toBe(true);
    expect(resolved).toMatch(/^(\/|[A-Za-z]:\\)/); // absolute path
  });

  it('source dirs point inside the package', () => {
    const reg = new TemplateRegistry();
    for (const dir of [reg.getSkillsSourceDir(), reg.getCommandsSourceDir(), reg.getAgentsSourceDir()]) {
      expect(dir).toContain('templates');
    }
  });

  it('getAll returns all templates', () => {
    const reg = new TemplateRegistry();
    expect(reg.getAll().length).toBe(
      reg.getByCategory('skill').length + reg.getByCategory('command').length + reg.getByCategory('agent').length,
    );
  });
});
