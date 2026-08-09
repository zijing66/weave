import { describe, it, expect } from 'vitest';
import { generateMcpJson } from '../init/mcp-gen';
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
