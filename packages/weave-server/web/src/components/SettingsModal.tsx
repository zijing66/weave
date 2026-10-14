import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type DaemonSettings, type Locale, type TerminalPreset } from '@/lib/api';
import { useI18n } from '@/i18n/I18nProvider';
import { SUPPORTED_LOCALES, LOCALE_NATIVE_NAMES } from '@/i18n/locale';
import { zh, type MessageKey } from '@/i18n/dict';
import {
  Database,
  Eye,
  EyeOff,
  Languages,
  Power,
  Settings,
  Sparkles,
  Terminal,
  X,
  Zap,
} from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { registerInvalidator } from '@/lib/sse';

/** api.ts 的 DaemonSettings mirror（外部批次维护）暂未含 events——本地扩展。 */
type DaemonSettingsExt = DaemonSettings & { events?: { retentionDays: number } };

/** 与 server DEFAULT_EVENT_RETENTION_DAYS 一致的展示兜底。 */
const DEFAULT_RETENTION_DAYS = 90;

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Daemon settings dialog (top-right gear): UI language, the terminal
 * "open in terminal" launches, the daemon hooks master switch, the login
 * autostart toggle, and event retention. Presets offered come from the
 * server, so the dropdown only shows options valid for the daemon's platform.
 * Everything is persisted together on 保存 — one atomic PUT, then the whole
 * UI switches immediately via the i18n context.
 */
export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const { locale, t, setLocale } = useI18n();
  const [settings, setSettings] = useState<DaemonSettingsExt | null>(null);
  const [presets, setPresets] = useState<Array<{ id: TerminalPreset; label: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // AI key 只写：输入框常态为空（服务端不回显已存的 key）；「清除」= 显式写 null。
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  // 未聚焦前 readOnly：密码管理器只在字段可写时自动填充/弹生成器，这是最硬的一道闸
  // （autoComplete/ignore 属性在部分浏览器会被忽略，readOnly 不会）。聚焦即可正常输入。
  const [keyFocused, setKeyFocused] = useState(false);

  const loadSettings = useCallback(() => {
    setError(null);
    // 每次打开都清空 key 相关输入态：不回显既有 key，也不留上一次的明文在内存里。
    setApiKeyInput('');
    setClearKey(false);
    setShowApiKey(false);
    api
      .getDaemonSettings()
      .then((r) => {
        setSettings(r.settings as DaemonSettingsExt); // 运行时含 events（server 归一化回传）
        setPresets(r.presets);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!open) return;
    loadSettings();
  }, [open, loadSettings]);

  // 设置被别处写（另一个页签保存）→ 服务端推 invalidate('settings')；只在弹窗
  // 打开时重拉，关着不用管。写路径自身的刷新在 handleSave 里，不必等这一枪。
  useEffect(() => {
    if (!open) return;
    return registerInvalidator('settings', loadSettings);
  }, [open, loadSettings]);

  if (!open) return null;

  const preset = settings?.terminal.preset ?? 'auto';
  const customCommand = settings?.terminal.customCommand ?? '';

  async function handleSave(): Promise<void> {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      // `ai.apiKey` 只写：只在用户真输入过 / 点过清除时才带进请求（留空 = 服务端保持原值）。
      const payload: DaemonSettingsExt = {
        ...settings,
        ...(settings.ai
          ? {
              ai: {
                baseUrl: settings.ai.baseUrl,
                model: settings.ai.model,
                ...(apiKeyInput !== ''
                  ? { apiKey: apiKeyInput }
                  : clearKey
                    ? { apiKey: null }
                    : {}),
              },
            }
          : {}),
      };
      const saved = await api.putDaemonSettings(payload);
      setSettings(saved as DaemonSettingsExt);
      setApiKeyInput('');
      setClearKey(false);
      setLocale(saved.locale);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 lg:p-6">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      {/* max-h + 内容区 min-h-0/滚动：设置项变多后（AI 段）内容会超过视口，
          面板是 overflow-hidden——不这样收口会把底部输入裁掉、点不到（见 CLAUDE.md
          「纵向 flex 堆叠的下区要 min-h-0」）。 */}
      <div className="relative w-[440px] max-w-full max-h-[calc(100dvh-1.5rem)] lg:max-h-[calc(100dvh-3rem)] rounded-2xl border border-white/[0.08] bg-neutral-900 shadow-mac overflow-hidden flex flex-col">
        <header className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-white/[0.06] frosted">
          <Settings className="h-4 w-4 text-blue-400" />
          <span className="text-sm font-semibold text-neutral-200">{t('settings.title')}</span>
          <button
            onClick={onClose}
            className="ml-auto p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800"
            title={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-4">
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
              <Languages className="h-3.5 w-3.5 text-neutral-500" />
              {t('settings.language')}
            </label>
            <p className="text-[11px] text-neutral-500">{t('settings.languageHint')}</p>
            <select
              value={settings?.locale ?? locale}
              onChange={(e) =>
                setSettings((s) => (s ? { ...s, locale: e.target.value as Locale } : s))
              }
              className="w-full rounded-lg bg-neutral-800 border border-white/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {SUPPORTED_LOCALES.map((l) => (
                <option key={l} value={l}>
                  {LOCALE_NATIVE_NAMES[l]}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
              <Terminal className="h-3.5 w-3.5 text-neutral-500" />
              {t('settings.defaultTerminal')}
            </label>
            <p className="text-[11px] text-neutral-500">{t('settings.defaultTerminalHint')}</p>
            <select
              value={preset}
              onChange={(e) =>
                setSettings((s) =>
                  s ? { ...s, terminal: { ...s.terminal, preset: e.target.value as TerminalPreset } } : s,
                )
              }
              className="w-full rounded-lg bg-neutral-800 border border-white/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {presets.map((p) => {
                // 本地词典优先（中英随 UI 切换），未知 id 回落服务端 label
                const key = `preset.${p.id}` as MessageKey;
                return (
                  <option key={p.id} value={p.id}>
                    {key in zh ? t(key) : p.label}
                  </option>
                );
              })}
            </select>
          </div>

          {preset === 'custom' && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-neutral-300">
                {t('settings.customCommand')}
              </label>
              <p className="text-[11px] text-neutral-500">
                <code className="text-neutral-400">{'{path}'}</code> {t('settings.pathHint')}
                <code className="text-neutral-400"> alacritty -e cd {'{path}'}</code>
              </p>
              <input
                type="text"
                value={customCommand}
                onChange={(e) =>
                  setSettings((s) =>
                    s
                      ? { ...s, terminal: { ...s.terminal, customCommand: e.target.value } }
                      : s,
                  )
                }
                placeholder="my-terminal --dir {path}"
                className="w-full rounded-lg bg-neutral-800 border border-white/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5 text-neutral-500" />
              <label className="text-xs font-medium text-neutral-300">{t('settings.hooks')}</label>
              <span className="ml-auto">
                <Switch
                  checked={settings?.hooks.enabled ?? true}
                  onChange={(v) =>
                    setSettings((s) => (s ? { ...s, hooks: { ...s.hooks, enabled: v } } : s))
                  }
                  title={t('settings.hooks')}
                />
              </span>
            </div>
            <p className="text-[11px] text-neutral-500">{t('settings.hooksHint')}</p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Power className="h-3.5 w-3.5 text-neutral-500" />
              <label className="text-xs font-medium text-neutral-300">
                {t('settings.launchOnLogin')}
              </label>
              <span className="ml-auto">
                <Switch
                  checked={settings?.startup?.launchOnLogin ?? false}
                  onChange={(v) =>
                    setSettings((s) => (s ? { ...s, startup: { launchOnLogin: v } } : s))
                  }
                  title={t('settings.launchOnLogin')}
                />
              </span>
            </div>
            <p className="text-[11px] text-neutral-500">{t('settings.launchOnLoginHint')}</p>
          </div>

          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
              <Database className="h-3.5 w-3.5 text-neutral-500" />
              {t('settings.retentionDays')}
            </label>
            <p className="text-[11px] text-neutral-500">{t('settings.retentionDaysHint')}</p>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={3650}
                value={settings?.events?.retentionDays ?? DEFAULT_RETENTION_DAYS}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  setSettings((s) =>
                    s
                      ? {
                          ...s,
                          events: {
                            retentionDays:
                              Number.isFinite(n) && n >= 1 ? Math.min(n, 3650) : 1,
                          },
                        }
                      : s,
                  );
                }}
                className="w-24 rounded-lg bg-neutral-800 border border-white/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <span className="text-[11px] text-neutral-500">{t('settings.daysUnit')}</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
              <Sparkles className="h-3.5 w-3.5 text-neutral-500" />
              {t('settings.ai')}
            </label>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={settings?.ai?.baseUrl ?? ''}
                onChange={(e) =>
                  setSettings((s) =>
                    s === null
                      ? s
                      : { ...s, ai: { ...(s.ai ?? { model: '' }), baseUrl: e.target.value } },
                  )
                }
                placeholder={t('settings.aiBaseUrlPlaceholder')}
                className="min-w-0 rounded-lg bg-neutral-800 border border-white/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <input
                value={settings?.ai?.model ?? ''}
                onChange={(e) =>
                  setSettings((s) =>
                    s === null
                      ? s
                      : { ...s, ai: { ...(s.ai ?? { baseUrl: '' }), model: e.target.value } },
                  )
                }
                placeholder={t('settings.aiModelPlaceholder')}
                className="min-w-0 rounded-lg bg-neutral-800 border border-white/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKeyInput}
                readOnly={!keyFocused}
                onFocus={() => setKeyFocused(true)}
                onBlur={() => setKeyFocused(false)}
                onChange={(e) => {
                  setApiKeyInput(e.target.value);
                  if (e.target.value !== '') setClearKey(false);
                }}
                // 这不是登录凭据：显式告诉浏览器与密码管理器别把它当密码字段——
                // 同源上「保存的凭据」只该归登录页那个框（见 LoginPage：current-password）。
                // one-time-code 比 off/new-password 稳：既不自动填充已存凭据，也不弹强密码生成器。
                name="weaveAiApiKey"
                autoComplete="one-time-code"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                placeholder={
                  settings?.ai?.apiKeySet
                    ? t('settings.aiApiKeySet')
                    : t('settings.aiApiKeyUnset')
                }
                className="min-w-0 flex-1 cursor-text rounded-lg bg-neutral-800 border border-white/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={() => setShowApiKey((value) => !value)}
                title={showApiKey ? t('settings.aiApiKeyHide') : t('settings.aiApiKeyShow')}
                className="shrink-0 rounded-lg bg-neutral-800 px-2 py-1.5 text-neutral-300 hover:bg-neutral-700"
              >
                {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
              {settings?.ai?.apiKeySet === true && (
                <button
                  type="button"
                  onClick={() => {
                    setApiKeyInput('');
                    setClearKey(true);
                  }}
                  className="shrink-0 rounded-lg bg-neutral-800 px-2 py-1.5 text-[11px] text-neutral-300 hover:bg-neutral-700"
                >
                  {t('settings.aiApiKeyClear')}
                </button>
              )}
            </div>
            <p className="text-[11px] text-neutral-500">{t('settings.aiHint')}</p>
          </div>

          {error && <p className="text-[11px] text-red-400 break-all">{error}</p>}
        </div>

        <footer className="shrink-0 border-t border-white/[0.06] px-4 py-2.5 flex items-center gap-2 frosted">
          <span className="flex-1 text-[11px] text-neutral-500">
            {settings === null && !error ? t('common.loading') : ''}
          </span>
          <button
            onClick={onClose}
            className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={settings === null || saving}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
