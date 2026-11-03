import { describe, it, expect } from 'vitest';
import { capabilitiesOf, canInstall } from '../install-capabilities';
import type { InstallCapabilities } from '../api';

/** 与服务端 installCapabilities() 同构的矩阵（服务端另有 capabilities.test 锚定派生）。 */
const table: InstallCapabilities = {
  categories: {
    skill: {
      surfaces: [
        { harness: 'claude', scopes: ['project', 'user'] },
        { harness: 'codex', scopes: ['project', 'user'] },
      ],
    },
    mcp: {
      surfaces: [
        { harness: 'claude', scopes: ['project', 'user'] },
        { harness: 'codex', scopes: ['user'] },
      ],
    },
    command: { surfaces: [{ harness: 'claude', scopes: ['project', 'user'] }] },
    agent: { surfaces: [{ harness: 'claude', scopes: ['project', 'user'] }] },
    'output-style': { surfaces: [{ harness: 'claude', scopes: ['project', 'user'] }] },
    workflow: { surfaces: [{ harness: 'claude', scopes: ['project'] }] },
    rule: { surfaces: [{ harness: 'claude', scopes: ['project'] }] },
  },
  statusline: [{ harness: 'claude', tui: 'injectable', segments: ['project', 'model'] }],
  config: ['claude'],
};

describe('canInstall', () => {
  it('skill 双 harness 双范围全过', () => {
    const attrs = capabilitiesOf('skill', table);
    for (const scope of ['project', 'user'] as const) {
      for (const agent of ['claude', 'codex'] as const) {
        expect(canInstall(attrs, { scope, agent })).toEqual({ ok: true, reasonKey: null });
      }
    }
  });

  it('workflow × user 拒（projectOnly）；× project 过', () => {
    const attrs = capabilitiesOf('workflow', table);
    expect(canInstall(attrs, { scope: 'user', agent: 'claude' })).toEqual({
      ok: false,
      reasonKey: 'capability.reason.projectOnly',
    });
    expect(canInstall(attrs, { scope: 'project', agent: 'claude' }).ok).toBe(true);
  });

  it('command × codex 拒（claudeOnly——资源不支持 Codex）', () => {
    const attrs = capabilitiesOf('command', table);
    expect(canInstall(attrs, { scope: 'project', agent: 'codex' })).toEqual({
      ok: false,
      reasonKey: 'capability.reason.claudeOnly',
    });
    expect(canInstall(attrs, { scope: 'project', agent: 'claude' }).ok).toBe(true);
  });

  it('mcp × codex × project 由 scopes 拒（globalOnly）；× user 过', () => {
    const attrs = capabilitiesOf('mcp', table);
    expect(canInstall(attrs, { scope: 'project', agent: 'codex' })).toEqual({
      ok: false,
      reasonKey: 'capability.reason.globalOnly',
    });
    expect(canInstall(attrs, { scope: 'user', agent: 'codex' }).ok).toBe(true);
    expect(canInstall(attrs, { scope: 'project', agent: 'claude' }).ok).toBe(true);
  });

  it('table 未加载回落全放行（存量行为，服务端硬校验兜底）', () => {
    expect(canInstall(capabilitiesOf('workflow', null), { scope: 'user', agent: 'claude' }).ok).toBe(
      true,
    );
    expect(canInstall(capabilitiesOf('skill', undefined), { scope: 'project', agent: 'codex' }).ok).toBe(
      true,
    );
  });
});
