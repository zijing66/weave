/**
 * 场景注册表（D1 场景框架）：场景 = { key, kind, enterable }。办公区 = 本批实装
 * （俯视 MVP）；教室/会议室 = E1 的实装位——注册表里立牌（入口可见、空态说明），
 * 组件零实现。新场景实装 = 注册表加一项 + 场景卡族补一员，路由与切换零改动。
 */

export interface RpgScene {
  key: string;
  kind: 'office' | 'placeholder';
  titleKey: 'rpg.sceneOffice' | 'rpg.sceneClassroom' | 'rpg.sceneMeeting';
  descKey: 'rpg.scenePlaceholder' | null;
}

export const RPG_SCENES: readonly RpgScene[] = [
  { key: 'office', kind: 'office', titleKey: 'rpg.sceneOffice', descKey: null },
  { key: 'classroom', kind: 'placeholder', titleKey: 'rpg.sceneClassroom', descKey: 'rpg.scenePlaceholder' },
  { key: 'meeting', kind: 'placeholder', titleKey: 'rpg.sceneMeeting', descKey: 'rpg.scenePlaceholder' },
];

export function sceneOf(key: string | undefined): RpgScene {
  return RPG_SCENES.find((s) => s.key === key) ?? RPG_SCENES[0]!;
}
