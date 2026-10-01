import type { Locale } from '../locale';
import { commonZh, commonEn } from './common';
import { settingsZh, settingsEn } from './settings';
import { presetsZh, presetsEn } from './presets';
import { appZh, appEn } from './app';
import { statuslineZh, statuslineEn } from './statusline';
import { libraryZh, libraryEn } from './library';
import { assetsZh, assetsEn } from './assets';

/** 扁平 dotted key 词典：按领域分 chunk，chunk 内 zh/en 成对、文件级强制
 * key 对齐（漏译编译失败），合并后这里再兜一层类型。 */
export const zh = {
  ...commonZh,
  ...settingsZh,
  ...presetsZh,
  ...appZh,
  ...statuslineZh,
  ...libraryZh,
  ...assetsZh,
};

export const en: Record<keyof typeof zh, string> = {
  ...commonEn,
  ...settingsEn,
  ...presetsEn,
  ...appEn,
  ...statuslineEn,
  ...libraryEn,
  ...assetsEn,
};

export type MessageKey = keyof typeof zh;
export type Dict = Record<MessageKey, string>;

/** 注册即用：加语言 = Locale 联合 + 这里加一项；字典缺失则编译期报错。 */
export const DICTS: Record<Locale, Dict> = {
  'zh-CN': zh,
  en,
};
