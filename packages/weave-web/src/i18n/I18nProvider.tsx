import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api } from '@/lib/api';
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  type Locale,
} from './locale';
import { DICTS, type MessageKey } from './dict';
import { makeT, type Params, type TFunc } from './t';

interface I18nValue {
  locale: Locale;
  t: (key: MessageKey, params?: Params) => string;
  /** Local switch (also updates the first-paint cache). Persisting to the
   * daemon settings — the source of truth — happens on Settings save. */
  setLocale: (l: Locale) => void;
}

const I18nCtx = createContext<I18nValue | null>(null);

function readCachedLocale(): Locale {
  try {
    const v = localStorage.getItem(LOCALE_STORAGE_KEY);
    return v === 'zh-CN' || v === 'en' ? v : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

function cacheLocale(l: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, l);
  } catch {
    // private mode / quota — the cache is best-effort only
  }
}

/**
 * App-wide i18n. First paint uses the localStorage cache (avoids a flash of
 * the wrong language); the daemon settings are fetched once on mount and are
 * the source of truth — a mismatch corrects the UI and the cache. Failures
 * (network/token) keep the cached value so the UI still renders.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readCachedLocale);

  useEffect(() => {
    let alive = true;
    api
      .getDaemonSettings()
      .then((r) => {
        if (!alive) return;
        // Stale daemon builds may not return locale yet — ignore instead of
        // poisoning the UI state with an unregistered value.
        const l = r.settings.locale;
        if (!(SUPPORTED_LOCALES as readonly string[]).includes(l)) return;
        setLocaleState(l);
        cacheLocale(l);
      })
      .catch(() => {
        // offline / unauthenticated — keep the cached locale
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useMemo(() => makeT(DICTS[locale], DICTS[DEFAULT_LOCALE]), [locale]);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      t,
      setLocale: (l: Locale) => {
        setLocaleState(l);
        cacheLocale(l);
      },
    }),
    [locale, t],
  );

  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export function useI18n(): I18nValue {
  const v = useContext(I18nCtx);
  if (!v) throw new Error('useI18n must be used inside <I18nProvider>');
  return v;
}

export function useT(): I18nValue['t'] {
  return useI18n().t;
}

export type { TFunc };
