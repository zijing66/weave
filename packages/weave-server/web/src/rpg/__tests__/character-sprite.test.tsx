import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { CharacterSprite, GodSprite, spriteSeedOf } from '../CharacterSprite';
import type { GameStatus } from '../status-map';

/**
 * sprite 冒烟（2026-11-08 黑屏回归锚）：`cell()` 产的是样式对象，裸当子节点
 * 渲染会在 React 的「Objects are not valid as a React child」上炸掉整棵树
 * （当时症状 = 建角色后游戏视图整页黑屏）。renderToString 执行同一条不变式，
 * 零 DOM 基建即可防守。
 */
describe('CharacterSprite', () => {
  it.each(['battle', 'idle', 'defeated', 'gone'] as GameStatus[])(
    '四态渲染不炸（%s）——所有 cell 都是 style 属性，不是裸子节点',
    (status) => {
      expect(() => renderToString(<CharacterSprite archetype="能量" status={status} size={2} />)).not.toThrow();
    },
  );

  it('未知型与空型走素衣回落，同样不炸', () => {
    expect(() => renderToString(<CharacterSprite archetype={null} status="idle" />)).not.toThrow();
    expect(() => renderToString(<CharacterSprite archetype="不存在的型" status="idle" />)).not.toThrow();
  });

  it('四朝向 × 男女 × 多 seed × 上帝素衣全组合 SSR 不炸（Plan B 验收）', () => {
    for (const facing of ['up', 'down', 'left', 'right'] as const) {
      for (const gender of ['male', 'female'] as const) {
        for (const seed of [0, 1, 42, 2147483647]) {
          expect(() =>
            renderToString(
              <CharacterSprite archetype="能量" status="idle" size={1} gender={gender} appearanceSeed={seed} facing={facing} />,
            ),
          ).not.toThrow();
        }
      }
    }
    expect(() => renderToString(<CharacterSprite archetype={null} status="idle" god size={1} />)).not.toThrow();
  });

  it('spriteSeedOf：同 id 同貌、不同 id 不同 seed、值域在 0..2^31-1（peer/分身确定性）', () => {
    expect(spriteSeedOf('peer-a')).toBe(spriteSeedOf('peer-a'));
    expect(spriteSeedOf('peer-a')).not.toBe(spriteSeedOf('peer-b'));
    expect(spriteSeedOf('')).toBeGreaterThanOrEqual(0);
    for (const id of ['a', 'b', 'house-1', 'sid-123456']) {
      const v = spriteSeedOf(id);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0x7fffffff);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('GodSprite SSR 不炸（无 window/localStorage 路径走内存回落）', () => {
    expect(() => renderToString(<GodSprite size={0.75} />)).not.toThrow();
    expect(() => renderToString(<GodSprite size={0.75} facing="up" />)).not.toThrow();
  });

  it('常驻状态条：bar 在场才渲染色条（绿/黄/红三档），null 不摆', () => {
    const withBar = renderToString(<CharacterSprite archetype="能量" status="idle" size={1} bar="ok" />);
    expect(withBar).toContain('#3fbf5f');
    const warn = renderToString(<CharacterSprite archetype="能量" status="idle" size={1} bar="warn" />);
    expect(warn).toContain('#d9a441');
    const err = renderToString(<CharacterSprite archetype="能量" status="idle" size={1} bar="err" />);
    expect(err).toContain('#c9566e');
    const none = renderToString(<CharacterSprite archetype="能量" status="idle" size={1} />);
    expect(none).not.toContain('#3fbf5f');
    expect(none).not.toContain('#d9a441');
    // 上帝化身默认带绿条（规格 §4.3）
    const god = renderToString(<GodSprite size={0.75} />);
    expect(god).toContain('#3fbf5f');
    expect(god).toContain('rpg-god-mark');
  });
});
