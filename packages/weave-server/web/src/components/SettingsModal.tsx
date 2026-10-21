import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type AccessUrl, type DaemonSettings, type Locale, type TerminalPreset } from '@/lib/api';
import { useI18n } from '@/i18n/I18nProvider';
import { SUPPORTED_LOCALES, LOCALE_NATIVE_NAMES } from '@/i18n/locale';
import { zh, type MessageKey } from '@/i18n/dict';
import {
  Bell,
  Clock,
  Copy,
  Database,
  Eye,
  EyeOff,
  Globe,
  Languages,
  Power,
  RefreshCw,
  Settings,
  Sparkles,
  Terminal,
  X,
  Zap,
} from 'lucide-react';
import { fetchAiModels } from '@/lib/ai';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { Switch } from '@/components/ui/switch';
import { NumberStepper } from '@/components/ui/number-stepper';
import { registerInvalidator } from '@/lib/sse';
import { useToast } from '@/components/Toast';
import {
  ensurePushSubscribed,
  pushChannelState,
  unsubscribePush,
  type PushChannelState,
} from '@/lib/push';
import { ensureNotifyPermission, type NotifyPermission } from '@/lib/browser-notify';

/** api.ts 的 DaemonSettings mirror（外部批次维护）暂未含 events/sessions——本地扩展。 */
type DaemonSettingsExt = DaemonSettings & {
  events?: { retentionDays: number };
  sessions?: { idleDays: number };
};

/** 与 server DEFAULT_EVENT_RETENTION_DAYS / DEFAULT_SESSION_IDLE_DAYS 一致的展示兜底。 */
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_SESSION_IDLE_DAYS = 90;

/** 权限未授的成因文案（tasks 字典的三态，与订阅手势同款）。 */
const PUSH_PERMISSION_KEY: Record<Exclude<NotifyPermission, 'granted'>, MessageKey> = {
  denied: 'tasks.notifyDenied',
  unsupported: 'tasks.notifyUnsupported',
  insecure: 'tasks.notifyInsecure',
};

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
  /** 对外访问地址（服务端派生，只读展示面）。 */
  const [urls, setUrls] = useState<AccessUrl[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // AI key 只写：输入框常态为空（服务端不回显已存的 key）；「清除」= 显式写 null。
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  /** 服务端拉回的模型候选（datalist 用；空 = 还没拉/网关没有 /models）。 */
  const [models, setModels] = useState<string[]>([]);
  /** 逐行复制 URL 的反馈（1.5s ✓，折叠条同款惯例）。 */
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  /** 本浏览器推送通道态（逐设备开关，不属于 daemon settings——不进保存流程）。 */
  const [pushState, setPushState] = useState<PushChannelState | null>(null);
  const fb = useActionFeedback();
  const { show } = useToast();

  useEffect(() => {
    if (!open) return;
    void pushChannelState().then(setPushState);
  }, [open]);

  /** 推送开关：开向 = 权限申请 + 订阅（手势内）；失败可见（不静默回弹）。 */
  const onTogglePush = useCallback(
    (on: boolean): void => {
      void (async () => {
        if (on) {
          const permission = await ensureNotifyPermission();
          if (permission !== 'granted') {
            show('info', t(PUSH_PERMISSION_KEY[permission]));
            setPushState(await pushChannelState());
            return;
          }
          const result = await ensurePushSubscribed({ force: true });
          if (result !== 'ok') {
            show('info', t('settings.pushFailed'));
            setPushState(await pushChannelState());
            return;
          }
        } else {
          await unsubscribePush();
        }
        setPushState(await pushChannelState());
      })();
    },
    [t, show],
  );

  /**
   * 拉模型列表（走服务端代理 `POST /ai/models`）。`silent` = 自动拉取：
   * 失败不打扰（不是所有网关都提供 /models），手动按钮才报错（走 toast）。
   */
  const loadModels = useCallback(
    async (opts?: { baseUrl?: string; apiKey?: string; silent?: boolean }): Promise<void> => {
      try {
        const result = await fetchAiModels(
          opts && (opts.baseUrl !== undefined || opts.apiKey !== undefined)
            ? { ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}), ...(opts.apiKey ? { apiKey: opts.apiKey } : {}) }
            : undefined,
        );
        setModels(result.models);
      } catch (error) {
        if (opts?.silent) return;
        throw error;
      }
    },
    [],
  );
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
        setUrls(r.urls ?? []);
        // 已配置（存的地址 + key 齐全）**不自动拉**——模型一般已选好，按需点「拉取模型」；
        // 只有首次配置（未配置态）在表单两栏填齐后才自动拉一次（见下面的 debounce effect）。
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

  /**
   * 首次配置才自动拉模型：**未配置态**（没存下地址或 key）里，表单两栏都填了就静默拉一次
   * （debounce 700ms，避免逐键打枪）。**已配置态**一律不自动——按需点「拉取模型」。
   */
  const savedConfigured = Boolean(settings?.ai?.baseUrl && settings?.ai?.apiKeySet);
  const typedBaseUrl = settings?.ai?.baseUrl?.trim() ?? '';
  const typedKey = apiKeyInput.trim();
  useEffect(() => {
    if (!open || savedConfigured) return;
    if (typedBaseUrl === '' || typedKey === '') return;
    const timer = setTimeout(() => {
      void loadModels({ baseUrl: typedBaseUrl, apiKey: typedKey, silent: true });
    }, 700);
    return () => clearTimeout(timer);
  }, [open, savedConfigured, typedBaseUrl, typedKey, loadModels]);

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
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      {/* max-h + 内容区 min-h-0/滚动：设置项变多后（AI 段）内容会超过视口，
          面板是 overflow-hidden——不这样收口会把底部输入裁掉、点不到（见 CLAUDE.md
          「纵向 flex 堆叠的下区要 min-h-0」）。 */}
      <div className="relative w-[440px] max-w-full max-h-[calc(100dvh-1.5rem)] lg:max-h-[calc(100dvh-3rem)] rounded-2xl border border-edge/[0.08] bg-neutral-900 shadow-mac overflow-hidden flex flex-col">
        <header className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-edge/[0.06] frosted">
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
              className="w-full rounded-lg bg-neutral-800 border border-edge/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
              className="w-full rounded-lg bg-neutral-800 border border-edge/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
                className="w-full rounded-lg bg-neutral-800 border border-edge/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
              <NumberStepper
                value={settings?.events?.retentionDays ?? DEFAULT_RETENTION_DAYS}
                min={1}
                max={3650}
                onChange={(v) =>
                  setSettings((s) => (s ? { ...s, events: { retentionDays: v } } : s))
                }
                title={t('settings.retentionDays')}
              />
              <span className="text-[11px] text-neutral-500">{t('settings.daysUnit')}</span>
            </div>
          </div>

          {/* 会话保留策略：无操作 n 天后自动移除（期限随会话行的剩余存活倒计时下发）。 */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
              <Clock className="h-3.5 w-3.5 text-neutral-500" />
              {t('settings.sessionIdleDays')}
            </label>
            <p className="text-[11px] text-neutral-500">
              {t('settings.sessionIdleDaysHint', {
                n: settings?.sessions?.idleDays ?? DEFAULT_SESSION_IDLE_DAYS,
              })}
            </p>
            <div className="flex items-center gap-2">
              <NumberStepper
                value={settings?.sessions?.idleDays ?? DEFAULT_SESSION_IDLE_DAYS}
                min={1}
                max={3650}
                onChange={(v) =>
                  setSettings((s) => (s ? { ...s, sessions: { idleDays: v } } : s))
                }
                title={t('settings.sessionIdleDays')}
              />
              <span className="text-[11px] text-neutral-500">{t('settings.daysUnit')}</span>
            </div>
          </div>

          {/* 推送通道（本浏览器开关，非 daemon 配置）：页面关掉后提醒仍能到达。 */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Bell className="h-3.5 w-3.5 text-neutral-500" />
              <label className="text-xs font-medium text-neutral-300">{t('settings.push')}</label>
              <span className="ml-auto">
                <Switch
                  checked={pushState === 'on'}
                  disabled={pushState == null || pushState === 'insecure' || pushState === 'unsupported'}
                  onChange={onTogglePush}
                  title={t('settings.push')}
                />
              </span>
            </div>
            <p className="text-[11px] text-neutral-500">
              {pushState === 'insecure'
                ? t('settings.pushInsecure')
                : pushState === 'unsupported'
                  ? t('settings.pushUnsupported')
                  : t('settings.pushHint')}
            </p>
          </div>

          {/* 对外访问地址：服务端派生（全部 IP × 已开协议），只读展示 + 逐行复制。 */}
          {urls.length > 0 && (
            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
                <Globe className="h-3.5 w-3.5 text-neutral-500" />
                {t('settings.accessUrls')}
              </label>
              <p className="text-[11px] text-neutral-500">{t('settings.accessUrlsHint')}</p>
              <ul className="space-y-1">
                {urls.map((u) => (
                  <li key={u.url} className="flex items-center gap-1.5">
                    <span
                      className={
                        u.protocol === 'https'
                          ? 'rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400'
                          : 'rounded bg-edge/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-neutral-400'
                      }
                    >
                      {u.scope === 'lan' ? t('settings.urlLan') : t('settings.urlLocal')} ·{' '}
                      {u.protocol.toUpperCase()}
                    </span>
                    <code className="min-w-0 flex-1 truncate rounded bg-neutral-950 border border-edge/[0.06] px-2 py-1 text-[11px] text-neutral-300">
                      {u.url}
                    </code>
                    <button
                      type="button"
                      onClick={() => {
                        void copyText(u.url).then((ok) => {
                          if (!ok) {
                            show('error', t('common.copyFailed'));
                            return;
                          }
                          setCopiedUrl(u.url);
                          window.setTimeout(() => setCopiedUrl(null), 1500);
                        });
                      }}
                      title={t('common.copy')}
                      className="shrink-0 rounded p-1 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800"
                    >
                      {copiedUrl === u.url ? (
                        <span className="text-[10px] text-emerald-400">✓</span>
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

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
                className="min-w-0 rounded-lg bg-neutral-800 border border-edge/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <div className="flex items-center gap-1">
                {/* 拉到候选 → 原生 select（样式可跟暗色，同「终端预设」口径）；
                    没拉到（有的网关没有 /models）→ 回退文本框手填。
                    刻意不用 <datalist>：它的弹层由浏览器/系统画，浅色且不可控。 */}
                {models.length > 0 ? (
                  <select
                    value={settings?.ai?.model ?? ''}
                    onChange={(e) =>
                      setSettings((s) =>
                        s === null
                          ? s
                          : { ...s, ai: { ...(s.ai ?? { baseUrl: '' }), model: e.target.value } },
                      )
                    }
                    className="min-w-0 flex-1 rounded-lg bg-neutral-800 border border-edge/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    {/* 已存模型不在列表里（网关换过/曾手填）也要能显示，别静默丢值 */}
                    {(settings?.ai?.model ?? '') === '' && (
                      <option value="">{t('settings.aiModelPlaceholder')}</option>
                    )}
                    {settings?.ai?.model && !models.includes(settings.ai.model) && (
                      <option value={settings.ai.model}>{settings.ai.model}</option>
                    )}
                    {models.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                ) : (
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
                    className="min-w-0 flex-1 rounded-lg bg-neutral-800 border border-edge/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                )}
                <button
                  type="button"
                  onClick={() =>
                    void fb.run(
                      'ai-models',
                      () =>
                        loadModels({
                          baseUrl: settings?.ai?.baseUrl ?? '',
                          ...(apiKeyInput !== '' ? { apiKey: apiKeyInput } : {}),
                        }),
                      { fail: (error) => errorText(error) },
                    )
                  }
                  disabled={fb.stateOf('ai-models') === 'loading'}
                  title={t('settings.aiModelFetchTip')}
                  className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-neutral-800 px-2 py-1.5 text-[11px] text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
                >
                  <FeedbackIcon
                    state={fb.stateOf('ai-models')}
                    className="h-3 w-3"
                    icon={<RefreshCw className="h-3 w-3" />}
                  />
                  {t('settings.aiModelFetch')}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
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
                // 掩码走 CSS（masked-input）而非 type=password：后者会让浏览器把
                // 前面的地址框当用户名、这里当密码，弹「保存凭据」并自动填充。
                // one-time-code 比 off/new-password 稳：既不自动填充已存凭据，也不弹强密码生成器。
                name="weaveAiApiKey"
                autoComplete="one-time-code"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                className={cn(
                  'min-w-0 flex-1 cursor-text rounded-lg bg-neutral-800 border border-edge/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500',
                  !showApiKey && 'masked-input',
                )}
                placeholder={
                  settings?.ai?.apiKeySet
                    ? t('settings.aiApiKeySet')
                    : t('settings.aiApiKeyUnset')
                }
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

        <footer className="shrink-0 border-t border-edge/[0.06] px-4 py-2.5 flex items-center gap-2 frosted">
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
