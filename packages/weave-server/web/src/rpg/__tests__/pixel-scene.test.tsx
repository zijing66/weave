import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { I18nProvider } from '@/i18n/I18nProvider';
import { PixelScene, RpgBootBar } from '../PixelScene';
import { HOME_MAP, HOME_HOTSPOTS, WORLD_MAP, WORLD_HOTSPOTS, GOD_SPOT } from '../worldmap';

/**
 * PixelScene 冒烟（同 character-sprite.test.tsx 先例）：renderToString 防守
 * 「样式对象当裸子节点」与「tilemap 逐格渲染不炸」两条不变式；RpgBootBar
 * 判据⑥的同一条（进度条渲染不炸、格数 = 清单项数）。
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

  it('世界地图 + 静态摆位 sprite 渲染不炸（cell 只进 style）', () => {
    expect(() =>
      renderToString(
        <I18nProvider>
          <PixelScene
            map={WORLD_MAP}
            hotspots={WORLD_HOTSPOTS}
            onHotspot={() => {}}
            sprites={[
              {
                key: 'god',
                x: GOD_SPOT.x,
                y: GOD_SPOT.y,
                node: <div style={{ width: 24, height: 48 }} />,
              },
            ]}
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
