import { describe, it, expect } from 'vitest';
import { generateSettingsJson } from '../init/settings-gen';
import type { PlatformInfo } from '@weave/core';
import { FULL_COMPONENTS, DEFAULT_HOOKS } from '@weave/core';

const unixPlatform: PlatformInfo = {
  os: 'linux',
  arch: 'x64',
  nodeVersion: 'v20.0.0',
  shell: 'bash',
  homeDir: '/home/user',
  configDir: '/home/user/.config',
};

const windowsPlatform: PlatformInfo = {
  os: 'windows',
  arch: 'x64',
  nodeVersion: 'v20.0.0',
  shell: 'powershell',
  homeDir: 'C:\\Users\\user',
  configDir: 'C:\\Users\\user\\AppData\\Roaming',
};

describe('generateSettingsJson', () => {
  it('generates hooks only when helpers are enabled', () => {
    const settings = generateSettingsJson({
      components: { ...FULL_COMPONENTS, helpers: true },
      hooks: DEFAULT_HOOKS,
      platform: unixPlatform,
      helpersDir: '/proj/.claude/helpers',
    });
    expect(settings.hooks).toBeDefined();
    const hooks = settings.hooks as Record<string, unknown>;
    expect(Object.keys(hooks)).toContain('PreToolUse');
    expect(Object.keys(hooks)).toContain('PostToolUse');
    expect(Object.keys(hooks)).toContain('SessionStart');
  });

  it('omits hooks when helpers are disabled', () => {
    const settings = generateSettingsJson({
      components: { ...FULL_COMPONENTS, helpers: false },
      hooks: DEFAULT_HOOKS,
      platform: unixPlatform,
      helpersDir: '/proj/.claude/helpers',
    });
    expect(settings.hooks).toBeUndefined();
  });

  it('respects per-hook toggles', () => {
    const settings = generateSettingsJson({
      components: FULL_COMPONENTS,
      hooks: { ...DEFAULT_HOOKS, preToolUse: false, postToolUse: false, sessionStart: false },
      platform: unixPlatform,
      helpersDir: '/proj/.claude/helpers',
    });
    // all hooks disabled → hooks field omitted entirely
    expect(settings.hooks).toBeUndefined();
  });

  it('adds deny rules for sensitive files', () => {
    const settings = generateSettingsJson({
      components: FULL_COMPONENTS,
      hooks: DEFAULT_HOOKS,
      platform: unixPlatform,
      helpersDir: '/proj/.claude/helpers',
    });
    const perms = settings.permissions as { deny: string[] };
    expect(perms.deny).toContain('Read(./.env)');
  });

  it('adds WEAVE_ENABLED env var', () => {
    const settings = generateSettingsJson({
      components: FULL_COMPONENTS,
      hooks: DEFAULT_HOOKS,
      platform: unixPlatform,
      helpersDir: '/proj/.claude/helpers',
    });
    const env = settings.env as Record<string, string>;
    expect(env.WEAVE_ENABLED).toBe('true');
  });

  it('uses forward-slash paths on unix', () => {
    const settings = generateSettingsJson({
      components: FULL_COMPONENTS,
      hooks: DEFAULT_HOOKS,
      platform: unixPlatform,
      helpersDir: '/proj/.claude/helpers',
    });
    const hooks = settings.hooks as Record<string, Array<{ command: string }>>;
    expect(hooks.PreToolUse[0].command).toContain('/proj/.claude/helpers/hook-handler.cjs');
  });

  it('uses backslash-safe quoted paths on windows', () => {
    const settings = generateSettingsJson({
      components: FULL_COMPONENTS,
      hooks: DEFAULT_HOOKS,
      platform: windowsPlatform,
      helpersDir: 'C:\\proj\\.claude\\helpers',
    });
    const hooks = settings.hooks as Record<string, Array<{ command: string }>>;
    const cmd = hooks.PreToolUse[0].command;
    expect(cmd).toContain('hook-handler.cjs');
  });
});
