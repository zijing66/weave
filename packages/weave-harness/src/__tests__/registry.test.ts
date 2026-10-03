import { describe, it, expect } from 'vitest';
import { HarnessRegistry, supports, type HarnessDriver } from '../driver';

function makeDriver(
  id: 'claude' | 'codex',
  capabilities: HarnessDriver['capabilities'] = [],
  extra: Partial<HarnessDriver> = {},
): HarnessDriver {
  return { id, displayName: id, capabilities, ...extra };
}

describe('HarnessRegistry', () => {
  it('register → get / all', () => {
    const reg = new HarnessRegistry();
    const claude = makeDriver('claude');
    const codex = makeDriver('codex');
    reg.register(claude);
    reg.register(codex);

    expect(reg.get('claude')).toBe(claude);
    expect(reg.get('codex')).toBe(codex);
    expect(reg.all()).toEqual([claude, codex]);
  });

  it('get 未注册 id 返回 undefined', () => {
    const reg = new HarnessRegistry();
    expect(reg.get('claude')).toBeUndefined();
    expect(reg.all()).toEqual([]);
  });

  it('byCapability 只返回声明了该能力的驱动', () => {
    const reg = new HarnessRegistry();
    const claude = makeDriver('claude', ['init', 'events']);
    const codex = makeDriver('codex', ['detect']);
    reg.register(claude);
    reg.register(codex);

    expect(reg.byCapability('init')).toEqual([claude]);
    expect(reg.byCapability('events')).toEqual([claude]);
    expect(reg.byCapability('detect')).toEqual([codex]);
    expect(reg.byCapability('assets')).toEqual([]);
  });

  it('disposer 恢复注册前快照', () => {
    const reg = new HarnessRegistry();
    const claude = makeDriver('claude');
    const codex = makeDriver('codex');

    const disposeClaude = reg.register(claude);
    const disposeCodex = reg.register(codex);
    expect(reg.all()).toHaveLength(2);

    disposeClaude();
    expect(reg.get('claude')).toBeUndefined();
    expect(reg.all()).toEqual([codex]);

    disposeCodex();
    expect(reg.all()).toEqual([]);
  });

  it('disposer 幂等，且不移除后继的同 id 注册', () => {
    const reg = new HarnessRegistry();
    const first = makeDriver('claude');
    const disposeFirst = reg.register(first);
    reg.unregister('claude');

    const second = makeDriver('claude');
    reg.register(second);

    disposeFirst();
    disposeFirst(); // 幂等：二次调用 no-op
    expect(reg.get('claude')).toBe(second);
  });

  it('重复 id 注册抛错且先到先得', () => {
    const reg = new HarnessRegistry();
    const first = makeDriver('claude', ['init']);
    reg.register(first);

    expect(() => reg.register(makeDriver('claude', ['detect']))).toThrow(
      /already registered/,
    );
    expect(reg.get('claude')).toBe(first);
    expect(reg.all()).toHaveLength(1);
  });

  it('unregister 移除驱动并返回是否存在', () => {
    const reg = new HarnessRegistry();
    reg.register(makeDriver('claude'));

    expect(reg.unregister('claude')).toBe(true);
    expect(reg.unregister('claude')).toBe(false);
    expect(reg.get('claude')).toBeUndefined();
  });

  it('initFor 返回 init 槽；未补槽或未注册返回 undefined', () => {
    class FakeInit {}
    const reg = new HarnessRegistry();
    reg.register(
      makeDriver('claude', ['init'], { init: FakeInit as unknown as HarnessDriver['init'] }),
    );
    reg.register(makeDriver('codex', []));

    expect(reg.initFor('claude')).toBe(FakeInit);
    expect(reg.initFor('codex')).toBeUndefined();
    expect(new HarnessRegistry().initFor('claude')).toBeUndefined();
  });
});

describe('supports', () => {
  it('按 capabilities 判断', () => {
    expect(supports(makeDriver('claude', ['events']), 'events')).toBe(true);
    expect(supports(makeDriver('claude', ['events']), 'init')).toBe(false);
    expect(supports(makeDriver('codex'), 'detect')).toBe(false);
  });
});
