/**
 * 场景注册表（D1 场景框架 + G1 红白机骨架）：场景 = { key, kind, skin? }。
 * Home = 室内俯瞰（/rpg 默认落点，注册表首位）；world = 室外世界地图（Home
 * 的门走出）；办公区 / 教室 / 会议室 = 同一个协同状态视图（CollabScene）的
 * 样式变体——功能一律相同、只有皮肤差异。room = 进房协同棋盘（G2：World
 * 项目房点击落点，房间 tilemap + 席位纵排 + 状态徽章横排）。新场景实装 = 注册表加一项。
 */

export interface RpgScene {
  key: string;
  kind: 'home' | 'world' | 'office' | 'classroom' | 'meeting' | 'room';
  titleKey:
    | 'rpg.sceneHome'
    | 'rpg.sceneWorld'
    | 'rpg.sceneOffice'
    | 'rpg.sceneClassroom'
    | 'rpg.sceneMeeting'
    | 'rpg.sceneRoom';
}

export const RPG_SCENES: readonly RpgScene[] = [
  { key: 'home', kind: 'home', titleKey: 'rpg.sceneHome' },
  { key: 'world', kind: 'world', titleKey: 'rpg.sceneWorld' },
  { key: 'room', kind: 'room', titleKey: 'rpg.sceneRoom' },
  { key: 'office', kind: 'office', titleKey: 'rpg.sceneOffice' },
  { key: 'classroom', kind: 'classroom', titleKey: 'rpg.sceneClassroom' },
  { key: 'meeting', kind: 'meeting', titleKey: 'rpg.sceneMeeting' },
];

export function sceneOf(key: string | undefined): RpgScene {
  // 房间键是动态键（`room-<houseId>`，深链直达某间房）——按前缀归一到 room。
  if (isRoomSceneKey(key)) return RPG_SCENES.find((s) => s.kind === 'room')!;
  // 出房键 `world-exit-<houseId>`：world 场景 + 门外落点上下文（深链兼容）。
  if (isWorldExitSceneKey(key)) return RPG_SCENES.find((s) => s.kind === 'world')!;
  return RPG_SCENES.find((s) => s.key === key) ?? RPG_SCENES[0]!;
}

/** 房间场景键 = `room-<houseId>`（URL 唯一真源：深链可直接进某间房）。 */
export function roomSceneKey(houseId: number): string {
  return `room-${houseId}`;
}

export function isRoomSceneKey(key: string | undefined): boolean {
  return /^room-\d+$/.test(key ?? '');
}

/** 出房场景键 = `world-exit-<houseId>`：从该房南门走出，落世界门外一格。 */
export function worldExitSceneKey(houseId: number): string {
  return `world-exit-${houseId}`;
}

export function isWorldExitSceneKey(key: string | undefined): boolean {
  return /^world-exit-\d+$/.test(key ?? '');
}

/** 解析出房键里的 houseId；非出房键返回 null。 */
export function worldExitHouseIdOf(key: string | undefined): number | null {
  const m = /^world-exit-(\d+)$/.exec(key ?? '');
  return m ? Number(m[1]) : null;
}
