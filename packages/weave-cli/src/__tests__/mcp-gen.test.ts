import { describe, it, expect } from 'vitest';
import { mergeMcpJson, stripWeaveMcp } from '../init/mcp-gen';

describe('mergeMcpJson', () => {
  it('appends missing servers and preserves user servers', () => {
    const userServer = { command: 'my-server' };
    const merged = mergeMcpJson(
      { mcpServers: { user: userServer }, extraTopLevel: 1 },
      { mcpServers: { plugin: { command: 'npx' } } },
    );
    const servers = merged.mcpServers as Record<string, unknown>;
    expect(servers.user).toBe(userServer);
    expect(servers.plugin).toEqual({ command: 'npx' });
    expect(merged.extraTopLevel).toBe(1);
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
    const generated = { mcpServers: { plugin: { command: 'npx' } } };
    const once = mergeMcpJson({ mcpServers: { user: { command: 'u' } } }, generated);
    const twice = mergeMcpJson(once, generated);
    expect(twice).toEqual(once);
  });
});

describe('stripWeaveMcp', () => {
  it('removes only the weave server key and drops mcpServers when empty', () => {
    expect(stripWeaveMcp({ mcpServers: { weave: { command: 'npx' }, user: { command: 'u' } } })).toEqual({
      mcpServers: { user: { command: 'u' } },
    });
    expect(stripWeaveMcp({ mcpServers: { weave: { command: 'npx' } } })).toEqual({});
    expect(stripWeaveMcp({ other: 1 })).toEqual({ other: 1 });
  });
});
