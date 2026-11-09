/**
 * 场景注册表（D1 场景框架 + E4 语义收敛）：场景 = { key, kind, skin? }。
 * Home = 出征前准备视图（/rpg 默认落点，注册表首位）；办公区 / 教室 / 会议室 =
 * 同一个协同状态视图（CollabScene）的样式变体——功能一律相同、只有皮肤差异，
 * 不按角色派位、无场景专属功能。新场景实装 = 注册表加一项。
 */

export interface RpgScene {
  key: string;
  kind: 'home' | 'office' | 'classroom' | 'meeting';
  titleKey: 'rpg.sceneHome' | 'rpg.sceneOffice' | 'rpg.sceneClassroom' | 'rpg.sceneMeeting';
}

export const RPG_SCENES: readonly RpgScene[] = [
  { key: 'home', kind: 'home', titleKey: 'rpg.sceneHome' },
  { key: 'office', kind: 'office', titleKey: 'rpg.sceneOffice' },
  { key: 'classroom', kind: 'classroom', titleKey: 'rpg.sceneClassroom' },
  { key: 'meeting', kind: 'meeting', titleKey: 'rpg.sceneMeeting' },
];

export function sceneOf(key: string | undefined): RpgScene {
  return RPG_SCENES.find((s) => s.key === key) ?? RPG_SCENES[0]!;
}
