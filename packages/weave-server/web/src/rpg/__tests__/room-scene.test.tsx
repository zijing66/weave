import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { I18nProvider } from '@/i18n/I18nProvider';
import { PixelScene } from '../PixelScene';
import { ROOM_MAP, ROOM_HOTSPOTS, ROOM_GOD_SPOT, roomSeatSpot } from '../worldmap';

/**
 * RoomScene 数据面冒烟（G2 段1）：房间 tilemap 与席位槽位纯函数不炸；
 * 网络面（houses 查询）不进 renderToString——组件级断言只守 tile/席位不变式。
 */
describe('RoomScene 数据面（G2）', () => {
  it('房间 tilemap 渲染不炸（门热点在场）', () => {
    const html = renderToString(
      <I18nProvider>
        <PixelScene map={ROOM_MAP} hotspots={ROOM_HOTSPOTS} onHotspot={() => {}} />
      </I18nProvider>,
    );
    expect(html).toContain('rpg-pixel-scene');
    expect(html.match(/rpg-hotspot/g)?.length).toBe(ROOM_HOTSPOTS.length);
  });

  it('席位槽位纯函数：纵排 1×2、超行界返回 null、负数返回 null', () => {
    const first = roomSeatSpot(0)!;
    expect(first).toEqual({ x: 9, y: 4 });
    expect(roomSeatSpot(1)).toEqual({ x: 9, y: 6 });
    expect(roomSeatSpot(1)!.y).toBeGreaterThan(first.y); // 纵排：y 单调递增
    expect(roomSeatSpot(4)).toBeNull();
    expect(roomSeatSpot(-1)).toBeNull();
  });

  it('上帝化身摆位在席位列左侧（自由走动语义先静态）', () => {
    expect(ROOM_GOD_SPOT.x).toBeLessThan(roomSeatSpot(0)!.x);
  });
});
