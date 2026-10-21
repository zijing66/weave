import { describe, it, expect } from 'vitest';
import { applyUpdates, getDotted } from '../dotted.js';

describe('点号路径读写', () => {
  it('落值走嵌套，不改入参', () => {
    const base = { model: 'opus', sandbox: { filesystem: { allowWrite: ['/a'] } } };
    const next = applyUpdates(base, [
      { path: 'model', value: 'sonnet' },
      { path: 'sandbox.filesystem.allowWrite', value: ['/b'] },
      { path: 'env.NEW_KEY', value: '1' },
    ]);
    expect(next).toEqual({
      model: 'sonnet',
      sandbox: { filesystem: { allowWrite: ['/b'] } },
      env: { NEW_KEY: '1' },
    });
    expect(base.model).toBe('opus');
  });

  it('remove 删键，父对象空了不强删', () => {
    const next = applyUpdates({ env: { A: '1', B: '2' } }, [
      { path: 'env.A', remove: true },
      { path: 'nope.deep.key', remove: true },
    ]);
    expect(next).toEqual({ env: { B: '2' } });
  });

  it('取值：不存在给 undefined，非对象中途不炸', () => {
    expect(getDotted({ a: { b: 1 } }, 'a.b')).toBe(1);
    expect(getDotted({ a: { b: 1 } }, 'a.c')).toBeUndefined();
    expect(getDotted({ a: 'x' }, 'a.b.c')).toBeUndefined();
  });

  it('原型链相关段一律拒', () => {
    expect(() => applyUpdates({}, [{ path: '__proto__.polluted', value: 1 }])).toThrow(/非法配置键/);
    expect(() => applyUpdates({}, [{ path: 'constructor.prototype.x', value: 1 }])).toThrow(/非法配置键/);
    expect(() => getDotted({}, 'a..b')).toThrow(/非法配置键/);
  });
});
