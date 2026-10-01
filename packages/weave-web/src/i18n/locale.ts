/**
 * mirror of packages/weave-server/src/daemon/settings.ts — 保持同步。
 *
 * web 不能 import 含 node:fs 的 workspace 包，故手抄（与 api.ts 既有模式
 * 一致）；服务端 mergeDefaults 白名单会把非法值规范化并回传，漂移可自愈。
 */
export type Locale = 'zh-CN' | 'en';

export const SUPPORTED_LOCALES: readonly Locale[] = ['zh-CN', 'en'];

export const DEFAULT_LOCALE: Locale = 'zh-CN';

/** Language names in their own tongue — by convention these are never
 * translated (a locale list always shows 中文 / English, not localized). */
export const LOCALE_NATIVE_NAMES: Record<Locale, string> = {
  'zh-CN': '中文（简体）',
  en: 'English',
};

/** localStorage cache key for first paint (server settings remain the
 * source of truth — see I18nProvider). */
export const LOCALE_STORAGE_KEY = 'weave:locale';
