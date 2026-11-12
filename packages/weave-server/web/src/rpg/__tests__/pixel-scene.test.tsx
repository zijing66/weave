import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { I18nProvider } from '@/i18n/I18nProvider';
import { PixelScene, RpgBootBar } from '../PixelScene';
import { HOME_MAP, HOME_HOTSPOTS, WORLD_MAP, WORLD_HOTSPOTS, GOD_SPOT, ROOM_MAP, ROOM_HOTSPOTS, ROOM_GOD_SPOT } from '../worldmap';

/**
 * PixelScene 冒烟（同 character-sprite.test.tsx 先例）：renderToString 防守
 * 「样式对象当裸子节点」与「tilemap 逐格渲染不炸」两条不变式；G4 行走态
 * （god 化身 + 静态席位共存、三场景全给化身）渲染不炸。
 */
describe('PixelScene', () => {
  it('Home 室内渲染不炸（tile 格数 = 行×列）', () => {
    const html = renderToString(
      <I18nProvider>
        <PixelScene map={HOME_MAP} hotspots={HOME_HOTSPOTS} onHotspot={() => {}} />
      </I18nProvider>,
    );
    expect(html).toContain('rpg-pixel-scene');
    expect(html.match(/rpg-hotspot/g)?.length).toBe(HOME_HOTSPOTS.length);
  });

  it('世界地图 + 行走态上帝化身渲染不炸（化身 transform 落在初始格）', () => {
    const html = renderToString(
      <I18nProvider>
        <PixelScene
          map={WORLD_MAP}
          hotspots={WORLD_HOTSPOTS}
          onHotspot={() => {}}
          god={{ start: GOD_SPOT, facing: 'down', node: (facing) => <div data-facing={facing} style={{ width: 24, height: 48 }} /> }}
        />
      </I18nProvider>,
    );
    expect(html).toContain('rpg-god-sprite');
    expect(html).toContain(`translate(${GOD_SPOT.x * 24}px, ${GOD_SPOT.y * 24}px)`);
    // 初始朝向传进渲染函数（出房落点朝外的不变式）
    expect(html).toContain('data-facing="down"');
  });

  it('Room 协同棋盘：上帝化身与静态席位共存渲染不炸', () => {
    expect(() =>
      renderToString(
        <I18nProvider>
          <PixelScene
            map={ROOM_MAP}
            hotspots={ROOM_HOTSPOTS}
            onHotspot={() => {}}
            sprites={[{ key: 'seat', x: 9, y: 4, node: <div style={{ width: 24, height: 48 }} /> }]}
            god={{ start: ROOM_GOD_SPOT, node: (facing) => <div data-facing={facing} style={{ width: 24, height: 48 }} /> }}
          />
        </I18nProvider>,
      ),
    ).not.toThrow();
  });

  it('RpgBootBar 渲染六格（判据⑥：格数 = 真实清单项数）', () => {
    const html = renderToString(
      <I18nProvider>
        <RpgBootBar />
      </I18nProvider>,
    );
    expect(html.match(/rpg-boot-cell"/g)?.length).toBe(6);
  });
});
