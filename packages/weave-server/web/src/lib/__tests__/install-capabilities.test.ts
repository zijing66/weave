import { describe, it, expect } from 'vitest';
import { capabilitiesOf, canInstall } from '../install-capabilities';
import type { InstallCapabilities } from '../api';

/** 与服务端 installCapabilities() 同构的矩阵（服务端另有 capabilities.test 锚定派生）。 */
const table: InstallCapabilities = {
  categories: {
    skill: {
      surfaces: [
        { harness: 'claude', scopes: ['project', 'global'] },
        { harness: 'codex', scopes: ['project', 'global'] },
      ],
    },
    mcp: {
      surfaces: [
        { harness: 'claude', scopes: ['project', 'global'] },
        { harness: 'codex', scopes: ['global'] },
      ],
    },
    command: { surfaces: [{ harness: 'claude', scopes: ['project', 'global'] }] },
    agent: { surfaces: [{ harness: 'claude', scopes: ['project', 'global'] }] },
    'output-style': { surfaces: [{ harness: 'claude', scopes: ['project', 'global'] }] },
    workflow: { surfaces: [{ harness: 'claude', scopes: ['project'] }] },
    rule: { surfaces: [{ harness: 'claude', scopes: ['project'] }] },
  },
};

describe('canInstall', () => {
  it('skill 双 harness 双范围全过', () => {
    const attrs = capabilitiesOf('skill', table);
    for (const scope of ['project', 'global'] as const) {
      for (const agent of ['claude', 'codex'] as const) {
        expect(canInstall(attrs, { scope, agent })).toEqual({ ok: true, reasonKey: null });
      }
    }
  });

  it('workflow × global 拒（projectOnly）；× project 过', () => {
    const attrs = capabilitiesOf('workflow', table);
    expect(canInstall(attrs, { scope: 'global', agent: 'claude' })).toEqual({
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

  it('mcp × codex × project 由 scopes 拒（globalOnly）；× global 过', () => {
    const attrs = capabilitiesOf('mcp', table);
    expect(canInstall(attrs, { scope: 'project', agent: 'codex' })).toEqual({
      ok: false,
      reasonKey: 'capability.reason.globalOnly',
    });
    expect(canInstall(attrs, { scope: 'global', agent: 'codex' }).ok).toBe(true);
    expect(canInstall(attrs, { scope: 'project', agent: 'claude' }).ok).toBe(true);
  });

  it('table 未加载回落全放行（存量行为，服务端硬校验兜底）', () => {
    expect(canInstall(capabilitiesOf('workflow', null), { scope: 'global', agent: 'claude' }).ok).toBe(
      true,
    );
    expect(canInstall(capabilitiesOf('skill', undefined), { scope: 'project', agent: 'codex' }).ok).toBe(
      true,
    );
  });
});
