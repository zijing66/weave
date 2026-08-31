import { describe, it, expect } from 'vitest';
import { generateSettingsJson, mergeSettingsJson } from '../init/settings-gen';
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
    const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.PreToolUse[0].hooks[0].command).toContain('/proj/.claude/helpers/hook-handler.cjs');
  });

  it('uses backslash-safe quoted paths on windows', () => {
    const settings = generateSettingsJson({
      components: FULL_COMPONENTS,
      hooks: DEFAULT_HOOKS,
      platform: windowsPlatform,
      helpersDir: 'C:\\proj\\.claude\\helpers',
    });
    const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    const cmd = hooks.PreToolUse[0].hooks[0].command;
    expect(cmd).toContain('hook-handler.cjs');
  });

  it('emits the three-layer hooks structure Claude Code expects', () => {
    const settings = generateSettingsJson({
      components: FULL_COMPONENTS,
      hooks: DEFAULT_HOOKS,
      platform: unixPlatform,
      helpersDir: '/proj/.claude/helpers',
    });
    const hooks = settings.hooks as Record<
      string,
      Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>
    >;
    // hooks.PreToolUse = [{ matcher: '*', hooks: [{ type: 'command', command }] }]
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0].matcher).toBe('*');
    expect(hooks.PreToolUse[0].hooks).toHaveLength(1);
    expect(hooks.PreToolUse[0].hooks[0].type).toBe('command');
    expect(hooks.PreToolUse[0].hooks[0].command).toContain('hook-handler.cjs');
  });
});

describe('mergeSettingsJson', () => {
  const generated = (): Record<string, unknown> =>
    generateSettingsJson({
      components: { ...FULL_COMPONENTS, helpers: true },
      hooks: DEFAULT_HOOKS,
      platform: unixPlatform,
      helpersDir: '/proj/.claude/helpers',
    });

  it('preserves unknown user keys untouched', () => {
    const merged = mergeSettingsJson({ myOwnSetting: 42 }, generated());
    expect(merged.myOwnSetting).toBe(42);
  });

  it('appends weave hook groups after the user groups and keeps both', () => {
    const userGroup = { matcher: 'Write', hooks: [{ type: 'command', command: 'node /user/audit.cjs' }] };
    const merged = mergeSettingsJson(
      { hooks: { PreToolUse: [userGroup] } },
      generated(),
    );
    const hooks = merged.hooks as Record<string, Array<unknown>>;
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse[0]).toBe(userGroup);
    expect((hooks.PreToolUse[1] as { hooks: Array<{ command: string }> }).hooks[0].command).toContain('hook-handler.cjs');
  });

  it('refreshes a stale weave hook group instead of duplicating it', () => {
    const stale = {
      matcher: '*',
      hooks: [{ type: 'command', command: 'node "/old-home/proj/.claude/helpers/hook-handler.cjs"' }],
    };
    const merged = mergeSettingsJson({ hooks: { PreToolUse: [stale] } }, generated());
    const hooks = merged.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0].hooks[0].command).toContain('/proj/.claude/helpers/hook-handler.cjs');
  });

  it('keeps a user hook that merely shares the hook-handler file name', () => {
    const userGroup = {
      matcher: '*',
      hooks: [{ type: 'command', command: 'node /user/bin/hook-handler.cjs' }],
    };
    const merged = mergeSettingsJson({ hooks: { PreToolUse: [userGroup] } }, generated());
    const hooks = merged.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse[0]).toBe(userGroup);
  });

  it('is idempotent — merging twice yields identical hooks', () => {
    const userGroup = { matcher: 'Write', hooks: [{ type: 'command', command: 'node /user/audit.cjs' }] };
    const once = mergeSettingsJson({ hooks: { PreToolUse: [userGroup] } }, generated());
    const twice = mergeSettingsJson(once, generated());
    expect(twice).toEqual(once);
  });

  it('leaves a non-array hooks event untouched', () => {
    const merged = mergeSettingsJson({ hooks: { PreToolUse: 'broken' } }, generated());
    expect((merged.hooks as Record<string, unknown>).PreToolUse).toBe('broken');
  });

  it('sets statusLine when absent', () => {
    const merged = mergeSettingsJson({}, generated());
    expect(merged.statusLine).toBeDefined();
  });

  it('refreshes a statusLine that already points at weave script', () => {
    const merged = mergeSettingsJson(
      { statusLine: { type: 'command', command: 'node "/old-home/proj/.claude/helpers/statusline.cjs"' } },
      generated(),
    );
    const statusLine = merged.statusLine as { command: string };
    expect(statusLine.command).toContain('/proj/.claude/helpers/statusline.cjs');
  });

  it('never touches a user-authored statusLine', () => {
    const userStatusLine = { type: 'command', command: 'node /user/my-statusline.cjs' };
    const merged = mergeSettingsJson({ statusLine: userStatusLine }, generated());
    expect(merged.statusLine).toEqual(userStatusLine);
  });

  it('unions permissions without duplicating entries', () => {
    const merged = mergeSettingsJson(
      { permissions: { allow: ['Bash(git:*)', 'Bash(npm:*)'], deny: ['Read(./.env)'] } },
      generated(),
    );
    const perms = merged.permissions as { allow: string[]; deny: string[] };
    expect(perms.allow).toContain('Bash(git:*)');
    expect(perms.allow.filter((x) => x === 'Bash(npm:*)')).toHaveLength(1);
    expect(perms.deny.filter((x) => x === 'Read(./.env)')).toHaveLength(1);
  });

  it('fills env keys that are missing and keeps existing values', () => {
    const merged = mergeSettingsJson({ env: { WEAVE_ENABLED: 'false', USER_VAR: '1' } }, generated());
    const env = merged.env as Record<string, string>;
    expect(env.WEAVE_ENABLED).toBe('false');
    expect(env.USER_VAR).toBe('1');
  });
});
