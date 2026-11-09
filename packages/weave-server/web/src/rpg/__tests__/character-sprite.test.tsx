import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { CharacterSprite } from '../CharacterSprite';
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
});
