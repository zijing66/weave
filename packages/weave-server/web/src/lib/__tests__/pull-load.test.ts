import { describe, it, expect } from 'vitest';
import { PULL_FIRE_PX, createPullGate, touchPull, wheelPull } from '../pull-load';

describe('wheelPull / touchPull', () => {
  it('只认朝那一头的位移，且单次封顶', () => {
    expect(wheelPull(-30, 0, 'top')).toBe(30);
    expect(wheelPull(30, 0, 'top')).toBe(0);
    expect(wheelPull(30, 0, 'bottom')).toBe(30);
    expect(wheelPull(-30, 0, 'bottom')).toBe(0);
    expect(wheelPull(-500, 0, 'top')).toBe(40);
    expect(wheelPull(-3, 1, 'top')).toBe(40);
    expect(touchPull(12, 'top')).toBe(12);
    expect(touchPull(-12, 'top')).toBe(0);
    expect(touchPull(-12, 'bottom')).toBe(12);
  });
});

describe('createPullGate', () => {
  it('刚贴边不加载：贴边本身不放行', () => {
    const g = createPullGate();
    g.setEdge(true);
    expect(g.add(0).fired).toBe(false);
  });

  it('贴边后继续拉够门槛才放行一次', () => {
    const g = createPullGate();
    g.setEdge(true);
    expect(g.add(50)).toEqual({ value: 50, fired: false });
    expect(g.add(50)).toEqual({ value: 100, fired: false });
    expect(g.add(PULL_FIRE_PX - 100).fired).toBe(true);
  });

  it('同一段贴边只放行一次，离边后重新武装', () => {
    const g = createPullGate();
    g.setEdge(true);
    g.add(500);
    expect(g.add(500).fired).toBe(false);
    g.setEdge(false);
    expect(g.add(500)).toEqual({ value: 0, fired: false }); // 离边：不累积
    g.setEdge(true);
    expect(g.add(500).fired).toBe(true);
  });

  it('没贴边时怎么拉都不放行', () => {
    const g = createPullGate();
    expect(g.add(999).fired).toBe(false);
    expect(g.add(999).value).toBe(0);
  });
});
