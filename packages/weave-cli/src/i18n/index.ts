import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  readDaemonSettings,
  type Locale,
} from '@weave/server';
import { DICTS, type MessageKey } from './dict/index.js';
import { makeT, type Params, type TFunc } from './t.js';

/**
 * CLI i18n — the machine-level daemon settings are the single source of
 * truth shared with the dashboard. Resolution order (initCliLocale):
 *
 *   1. `WEAVE_LOCALE` env var (valid value only) — per-call override for
 *      scripts/CI that want stable English output;
 *   2. `settings.json` locale (already normalized by the server);
 *   3. DEFAULT_LOCALE (zh-CN).
 *
 * Everything else in the CLI calls the module-level `t()`; dictionaries are
 * plain objects so no async is ever needed on the render path.
 */
let locale: Locale = DEFAULT_LOCALE;
let translator: TFunc = makeT(DICTS[DEFAULT_LOCALE], DICTS[DEFAULT_LOCALE]);

function applyLocale(l: Locale): void {
  locale = l;
  translator = makeT(DICTS[l], DICTS[DEFAULT_LOCALE]);
}

/** Resolve the effective locale; call once at CLI startup (before help). */
export async function initCliLocale(): Promise<void> {
  const env = process.env.WEAVE_LOCALE;
  if (env && (SUPPORTED_LOCALES as readonly string[]).includes(env)) {
    applyLocale(env as Locale);
    return;
  }
  try {
    applyLocale((await readDaemonSettings()).locale);
  } catch {
    applyLocale(DEFAULT_LOCALE);
  }
}

/** Force a locale (tests / WEAVE_LOCALE-free embedding). */
export function setLocale(l: Locale): void {
  applyLocale(l);
}

export function getLocale(): Locale {
  return locale;
}

/** Translate a dict key in the current locale. Unknown keys return the key. */
export function t(key: MessageKey, p?: Params): string {
  return translator(key, p);
}
