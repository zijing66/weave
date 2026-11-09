import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useT } from '@/i18n/I18nProvider';
import { api } from '@/lib/api';
import { useRpgData } from './use-rpg-data';
import { CharacterSprite } from './CharacterSprite';
import { gameStatusOf } from './status-map';
import { PixelScene } from './PixelScene';
import { SpriteHeadBars, headBarsOf, SelectionDetailBar } from './hud';
import { RoleProgressPanel } from './RoleProgressPanel';
import { useState } from 'react';
import { ROOM_GOD_SPOT, ROOM_HOTSPOTS, ROOM_MAP, TILE_PX, roomSeatSpot } from './worldmap';
import { navigate } from '@/lib/route';
import type { RpgRoleView, SessionRow } from '@/lib/api';

/**
 * 进房协同棋盘（G2 段1）：World 项目房点击的落点——房间 tilemap + 席位纵排 +
 * 状态徽章横排（TFT 可读性口径）。数据面复用 useRpgData（观察态零冗余：席位
 * 状态 = 该角色项目最近会话的派生态）；名册 live 展开走 houses 表成员行现读。
 * 上帝化身自由走动语义 G2 先静态摆位（席位列左侧）。
 */

export function RoomScene({ houseId }: { houseId: number }) {
  const t = useT();
  const data = useRpgData();
  const [selectedRoleId, setSelectedRoleId] = useState<number | null>(null);
  const house = useQuery({
    queryKey: ['rpg-house', houseId],
    queryFn: () => api.fetchHouse(houseId),
    staleTime: 15_000,
  });

  // 席位名册 = 分身（协调者，固定语义首排）+ 入住角色（house 成员行现读，live）。
  const seats = useMemo(() => {
    const roleById = new Map<number, RpgRoleView>();
    for (const r of data.roles ?? []) roleById.set(r.id, r);
    const members = (house.data?.members ?? [])
      .map((m) => (m.kind === 'role' && m.roleId != null ? roleById.get(m.roleId) : undefined))
      .filter((r): r is RpgRoleView => r != null);
    return members;
  }, [data.roles, house.data]);

  const onHotspot = (h: { action: { type: string; scene?: string } }): void => {
    if (h.action.type === 'scene' && h.action.scene) navigate({ kind: 'rpg', scene: h.action.scene });
  };

  const sprites = seats.slice(0, 4).map((role, i) => {
    const spot = roomSeatSpot(i + 1); // 席位 0 留给分身
    const row = latestSessionOf(role.projectId, data.sessionById);
    const status = row ? (data.statuses.get(row.sessionId) ?? 'open') : 'open';
    if (!spot) return null;
    return {
      key: `seat-${role.id}`,
      x: spot.x,
      y: spot.y,
      node: (
        <div
          className="flex cursor-pointer flex-col items-center"
          title={role.name}
          onClick={(e) => {
            e.stopPropagation();
            setSelectedRoleId((cur) => (cur === role.id ? null : role.id));
          }}
        >
          {/* G2.5 三件套①：头顶状态条（派生不出的格不摆） */}
          <SpriteHeadBars bars={headBarsOf(role, data, Date.now())} />
          <CharacterSprite archetype={role.archetype} status={gameStatusOf(status)} size={0.5} />
          <span
            className={
              'mt-0.5 whitespace-nowrap rounded px-1 text-[9px] ' +
              (status === 'running' || status === 'compacting'
                ? 'bg-[var(--w-accent)] text-white'
                : 'bg-[var(--w-surface-2)] text-[var(--w-text-dim)]')
            }
          >
            {role.name}
          </span>
        </div>
      ),
    };
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PixelScene
        map={ROOM_MAP}
          indoor
        hotspots={ROOM_HOTSPOTS}
        onHotspot={onHotspot}
        onEmptyClick={() => setSelectedRoleId(null)}
        sprites={[
          {
            key: 'coordinator',
            x: roomSeatSpot(0)!.x,
            y: roomSeatSpot(0)!.y,
            node: (
              <div title={t('rpg.coordinatorSeat')}>
                <CharacterSprite archetype={null} status="idle" size={0.5} />
              </div>
            ),
          },
          ...sprites.filter((s): s is NonNullable<typeof s> => s != null),
        ]}
        god={{
          start: ROOM_GOD_SPOT,
          node: (
            <div title={t('rpg.godAvatar')}>
              <CharacterSprite archetype={null} status="idle" size={0.5} />
            </div>
          ),
        }}
      >
        <span
          className="absolute whitespace-nowrap text-[11px] text-[var(--w-text-dim)]"
          style={{ left: 8 * TILE_PX, top: 11 * TILE_PX - 26 }}
        >
          {t('rpg.doorExit')} ↓
        </span>
        <span
          className="absolute whitespace-nowrap text-[11px] text-[var(--w-text-dim)]"
          style={{ left: ROOM_GOD_SPOT.x * TILE_PX + TILE_PX * 2.5, top: ROOM_GOD_SPOT.y * TILE_PX }}
        >
          {t('rpg.godZone')}
        </span>
        {house.data && (
          <span
            className="absolute whitespace-nowrap text-[11px] text-[var(--w-text-dim)]"
            style={{ left: TILE_PX, top: 6 }}
          >
            {house.data.name} · {t('rpg.coordinatorSeat')}
          </span>
        )}
      </PixelScene>
      {house.isPending && <p className="text-xs text-[var(--w-text-dim)]">…</p>}
      {house.isError && <p className="text-xs text-[var(--w-text-dim)]">{t('rpg.roomNoHouse')}</p>}
      {/* G2.5 三件套③：底部选中详情条（点席位 sprite 展开） */}
      {selectedRoleId != null && (
        <SelectionDetailBar roleId={selectedRoleId} onClose={() => setSelectedRoleId(null)}>
          <RoleProgressPanel roleId={selectedRoleId} />
        </SelectionDetailBar>
      )}
    </div>
  );
}

function latestSessionOf(
  projectId: number,
  sessionById: ReadonlyMap<string, SessionRow>,
): SessionRow | undefined {
  let best: SessionRow | undefined;
  for (const s of sessionById.values()) {
    if (s.projectId !== projectId) continue;
    if (!best || s.createdAt > best.createdAt) best = s;
  }
  return best;
}
