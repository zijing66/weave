/**
 * 场景注册表（D1 场景框架）：场景 = { key, kind, enterable }。办公区 / 教室 /
 * 会议室 = 已实装三场景。新场景实装 = 注册表加一项 + 场景卡族补一员，路由与
 * 切换零改动。
 */

export interface RpgScene {
  key: string;
  kind: 'office' | 'classroom' | 'meeting' | 'placeholder';
  titleKey: 'rpg.sceneOffice' | 'rpg.sceneClassroom' | 'rpg.sceneMeeting';
  descKey: 'rpg.scenePlaceholder' | null;
}

export const RPG_SCENES: readonly RpgScene[] = [
  { key: 'office', kind: 'office', titleKey: 'rpg.sceneOffice', descKey: null },
  { key: 'classroom', kind: 'classroom', titleKey: 'rpg.sceneClassroom', descKey: null },
  { key: 'meeting', kind: 'meeting', titleKey: 'rpg.sceneMeeting', descKey: null },
];

export function sceneOf(key: string | undefined): RpgScene {
  return RPG_SCENES.find((s) => s.key === key) ?? RPG_SCENES[0]!;
}
