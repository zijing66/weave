import { zh } from './zh.js';
import { en } from './en.js';
import type { Locale } from '@weave/server';

export { zh, en };
export type MessageKey = keyof typeof zh;
export type Dict = Record<MessageKey, string>;

/** 注册即用：加语言 = 服务端 Locale 联合 + 这里加一项；字典缺失则编译报错。 */
export const DICTS: Record<Locale, Dict> = {
  'zh-CN': zh,
  en,
};
