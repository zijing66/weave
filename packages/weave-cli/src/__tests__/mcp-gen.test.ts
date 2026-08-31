import { describe, it, expect } from 'vitest';
import { generateMcpJson, mergeMcpJson } from '../init/mcp-gen';
import type { PlatformInfo } from '@weave/core';

const unix: PlatformInfo = { os: 'linux', arch: 'x64', nodeVersion: 'v20', shell: 'bash', homeDir: '/u', configDir: '/u/.config' };
const windows: PlatformInfo = { os: 'windows', arch: 'x64', nodeVersion: 'v20', shell: 'powershell', homeDir: 'C:\\u', configDir: 'C:\\u\\AppData' };

describe('generateMcpJson', () => {
  it('returns empty mcpServers when the weave server is not included', () => {
    const out = generateMcpJson({ platform: unix, includeWeaveServer: false });
    expect(out).toEqual({ mcpServers: {} });
  });

  it('uses npx directly on unix', () => {
    const out = generateMcpJson({ platform: unix, includeWeaveServer: true });
    const servers = out.mcpServers as Record<string, { command: string; args: string[] }>;
    expect(servers.weave.command).toBe('npx');
    expect(servers.weave.args).toEqual(['weave', 'mcp', 'start']);
  });

  it('uses cmd /c npx on windows', () => {
    const out = generateMcpJson({ platform: windows, includeWeaveServer: true });
    const servers = out.mcpServers as Record<string, { command: string; args: string[] }>;
    expect(servers.weave.command).toBe('cmd');
    expect(servers.weave.args).toEqual(['/c', 'npx', 'weave', 'mcp', 'start']);
  });
});

describe('mergeMcpJson', () => {
  it('appends missing servers and preserves user servers', () => {
    const userServer = { command: 'my-server' };
    const merged = mergeMcpJson(
      { mcpServers: { user: userServer }, extraTopLevel: 1 },
      { mcpServers: { weave: { command: 'npx' } } },
    );
    const servers = merged.mcpServers as Record<string, unknown>;
    expect(servers.user).toBe(userServer);
    expect(servers.weave).toEqual({ command: 'npx' });
    expect(merged.extraTopLevel).toBe(1);
  });

  it('refreshes the weave server entry when it already exists', () => {
    const merged = mergeMcpJson(
      { mcpServers: { weave: { command: 'old-command' } } },
      { mcpServers: { weave: { command: 'new-command' } } },
    );
    const servers = merged.mcpServers as Record<string, { command: string }>;
    expect(servers.weave.command).toBe('new-command');
  });

  it('never replaces a foreign server that shares a generated name', () => {
    const userServer = { command: 'user-own' };
    const merged = mergeMcpJson(
      { mcpServers: { audit: userServer } },
      { mcpServers: { audit: { command: 'weave-audit' } } },
    );
    const servers = merged.mcpServers as Record<string, unknown>;
    expect(servers.audit).toBe(userServer);
  });

  it('is idempotent', () => {
    const generated = { mcpServers: { weave: { command: 'npx' } } };
    const once = mergeMcpJson({ mcpServers: { user: { command: 'u' } } }, generated);
    const twice = mergeMcpJson(once, generated);
    expect(twice).toEqual(once);
  });
});
