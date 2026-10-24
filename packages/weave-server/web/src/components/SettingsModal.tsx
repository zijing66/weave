import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  api,
  type AccessUrl,
  type DaemonSettings,
  type HtmlExportProfile,
  type HtmlExportSettings,
  type Locale,
  type SessionRow,
  type SessionUploadsResult,
  type TerminalPreset,
  type UploadsOverview,
} from '@/lib/api';
import { useI18n } from '@/i18n/I18nProvider';
import { SUPPORTED_LOCALES, LOCALE_NATIVE_NAMES } from '@/i18n/locale';
import { zh, type MessageKey } from '@/i18n/dict';
import {
  Bell,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Database,
  Eye,
  EyeOff,
  FileCode,
  Globe,
  Image as ImageIcon,
  Languages,
  Loader2,
  Paperclip,
  Power,
  RefreshCw,
  Settings,
  Sparkles,
  Terminal,
  Trash2,
  X,
  Zap,
  Scale,
  Server,
  ZoomIn,
  type LucideIcon,
} from 'lucide-react';
import { fetchAiModels } from '@/lib/ai';
import { API_BASE } from '@/lib/api';
import { isImageUpload } from '@/components/tasks/attach';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { useBackPop } from '@/lib/back-pop';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { Switch } from '@/components/ui/switch';
import { NumberStepper } from '@/components/ui/number-stepper';
import { Combobox } from '@/components/ui/combobox';
import { registerInvalidator } from '@/lib/sse';
import { sessionLabel } from '@/lib/hook-payload';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import {
  ensurePushSubscribed,
  pushChannelState,
  unsubscribePush,
  type PushChannelState,
} from '@/lib/push';
import { ensureNotifyPermission, type NotifyPermission } from '@/lib/browser-notify';
import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STEP,
  setFontScale,
  useFontScale,
} from '@/lib/font-scale';

/** api.ts 的 DaemonSettings mirror（外部批次维护）暂未含 events/sessions——本地扩展。 */
type DaemonSettingsExt = DaemonSettings & {
  events?: { retentionDays: number };
  sessions?: { idleDays: number };
};

/** 与 server DEFAULT_EVENT_RETENTION_DAYS / DEFAULT_SESSION_IDLE_DAYS 一致的展示兜底。 */
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_SESSION_IDLE_DAYS = 90;

/** 字节可读形状（清理面的容量标注；与对话附件格的 sizeLabel 同口径）。 */
function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** 权限未授的成因文案（tasks 字典的三态，与订阅手势同款）。 */
const PUSH_PERMISSION_KEY: Record<Exclude<NotifyPermission, 'granted'>, MessageKey> = {
  denied: 'tasks.notifyDenied',
  unsupported: 'tasks.notifyUnsupported',
  insecure: 'tasks.notifyInsecure',
};

/** 设置分段：桌面端左栏导航 + 滚动跟随高亮的锚点清单（移动端只渲染分隔标题）。 */
const SECTIONS: Array<{ id: string; key: MessageKey; icon: LucideIcon }> = [
  { id: 'general', key: 'settings.sectionGeneral', icon: Settings },
  { id: 'service', key: 'settings.sectionService', icon: Server },
  { id: 'data', key: 'settings.sectionData', icon: Database },
  { id: 'notify', key: 'settings.sectionNotify', icon: Bell },
  { id: 'ai', key: 'settings.sectionAi', icon: Sparkles },
  { id: 'export', key: 'settings.sectionExport', icon: FileCode },
];

/** 分段容器：标题行 + 内容；id 供导航锚点与 IntersectionObserver 观察。 */
function SettingsSection(props: { id: string; icon: LucideIcon; title: string; children: ReactNode }) {
  const Icon = props.icon;
  return (
    <section id={`settings-section-${props.id}`} data-settings-section={props.id} className="scroll-mt-2">
      <div className="mb-2 flex items-center gap-1.5 pb-1.5 border-b border-edge/[0.06]">
        <Icon className="h-3.5 w-3.5 text-neutral-500" />
        <h3 className="text-xs font-semibold text-neutral-200">{props.title}</h3>
      </div>
      <div className="space-y-4">{props.children}</div>
    </section>
  );
}

/** 字段标签（AI 两卡的「API 地址 / 模型」这类行内小标）。 */
function FieldLabel(props: { children: ReactNode }) {
  return <span className="block text-11 text-neutral-500">{props.children}</span>;
}

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 密钥输入（AI 助手 / 决策模型共用）：服务端回显已存 key、掩码展示（眼睛切换明文），
 * 清空文本框 = 保存时清除。掩码走 CSS（masked-input）而非 type=password——后者会让
 * 浏览器把前面的地址框当用户名、这里当密码，弹「保存凭据」并自动填充；
 * one-time-code 比 off/new-password 稳：既不自动填充已存凭据，也不弹强密码生成器
 * （autoComplete/ignore 属性在部分浏览器会被忽略，readOnly 不会——但回显态下
 * readOnly 会挡住首次编辑，故只在「已存 key 且未动过」时只读，聚焦即解）。
 */
function SecretKeyInput(props: {
  name: string;
  value: string;
  onChange: (value: string) => void;
  keySet: boolean | undefined;
  labels: { set: string; unset: string; show: string; hide: string };
}) {
  const [show, setShow] = useState(false);
  const [focused, setFocused] = useState(false);
  const { labels } = props;
  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={props.value}
        readOnly={!focused}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => props.onChange(e.target.value)}
        // 这不是登录凭据：显式告诉浏览器与密码管理器别把它当密码字段——
        // 同源上「保存的凭据」只该归登录页那个框（见 LoginPage：current-password）。
        name={props.name}
        autoComplete="one-time-code"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        className={cn(
          'min-w-0 flex-1 cursor-text rounded-lg bg-neutral-800 border border-edge/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500',
          !show && 'masked-input',
        )}
        placeholder={props.keySet ? labels.set : labels.unset}
      />
      <button
        type="button"
        onClick={() => setShow((value) => !value)}
        title={show ? labels.hide : labels.show}
        className="shrink-0 rounded-lg bg-neutral-800 px-2 py-1.5 text-neutral-300 hover:bg-neutral-700"
      >
        {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
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
  // AI / 决策模型 key：服务端回显已存值进输入框（掩码展示），编辑即改、清空 = 保存时清除。
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [decisionKeyInput, setDecisionKeyInput] = useState('');
  /** 服务端拉回的模型候选（datalist 用；空 = 还没拉/网关没有 /models）。 */
  const [models, setModels] = useState<string[]>([]);
  /** 逐行复制 URL 的反馈（1.5s ✓，折叠条同款惯例）。 */
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  /** 本浏览器推送通道态（逐设备开关，不属于 daemon settings——不进保存流程）。 */
  const [pushState, setPushState] = useState<PushChannelState | null>(null);
  /** 对话附件存储：总览账 + 无引用件预告 + 按会话用量（打开时拉一次，清理后重拉）。 */
  const [overview, setOverview] = useState<UploadsOverview | null>(null);
  const [unref, setUnref] = useState<{ count: number; bytes: number } | null>(null);
  const [usage, setUsage] = useState<Array<{ sessionId: string; count: number; bytes: number }>>([]);
  const [sessionTitles, setSessionTitles] = useState<Map<string, string>>(new Map());
  /** 按会话多选清理的勾选集；展开钻取的会话 id（null = 全收起）。 */
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 展开会话的单件清单（懒加载：展开才拉）。 */
  const [detail, setDetail] = useState<SessionUploadsResult | null>(null);
  /** 钻取层里勾选的单件 id 集。 */
  const [detailChecked, setDetailChecked] = useState<Set<string>>(new Set());
  /** 清理进行中（进度 = 已清 / 预告数）；确认弹窗的目标（null = 关着）。 */
  const [cleaning, setCleaning] = useState<{ done: number; total: number } | null>(null);
  const [confirmClean, setConfirmClean] = useState<'unref' | string | null>(null);
  const fb = useActionFeedback();
  const { show } = useToast();
  const scale = useFontScale();
  /** 左栏导航高亮：滚动跟随——最后一个越过容器顶部阈值的分段；触底则钉在最后一段。 */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [activeSection, setActiveSection] = useState('general');
  const onContentScroll = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return;
    const rootTop = root.getBoundingClientRect().top;
    let current = 'general';
    for (const s of SECTIONS) {
      const el = root.querySelector<HTMLElement>(`[data-settings-section="${s.id}"]`);
      if (el && el.getBoundingClientRect().top - rootTop <= 24) current = s.id;
    }
    if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) {
      current = SECTIONS[SECTIONS.length - 1]?.id ?? current;
    }
    setActiveSection(current);
  }, []);
  const jumpToSection = useCallback((id: string) => {
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-settings-section="${id}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  /** 对话附件存储的统计面（打开时拉一次；清理后重拉）。会话名顺带对一遍表。 */
  const loadStorage = useCallback(async (): Promise<void> => {
    try {
      const [overviewR, unrefR, usageR, sessionsR] = await Promise.all([
        api.getUploadsOverview(),
        api.getUnreferencedUploads(),
        api.getUploadsUsage(),
        api.listSessions(),
      ]);
      setOverview(overviewR);
      setUnref(unrefR);
      setUsage(usageR.sessions);
      setSessionTitles(new Map(sessionsR.sessions.map((s: SessionRow) => [s.sessionId, sessionLabel(s.title, s.sessionId)])));
    } catch {
      // 统计面拉不到（旧 daemon）就空着——清理块整体不渲染，不挡设置页
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setChecked(new Set());
    setExpanded(null);
    setDetail(null);
    setDetailChecked(new Set());
    void loadStorage();
  }, [open, loadStorage]);

  /** 展开某会话：拉单件清单（懒加载），收起即清。 */
  const toggleExpand = useCallback((sessionId: string): void => {
    setExpanded((cur) => {
      const next = cur === sessionId ? null : sessionId;
      if (next === null) {
        setDetail(null);
        setDetailChecked(new Set());
      } else if (next !== cur) {
        setDetail(null);
        setDetailChecked(new Set());
        void api.getSessionUploads(next).then(setDetail).catch(() => setDetail(null));
      }
      return next;
    });
  }, []);

  /** 钻取层按 ids 删（单件或图/文件分组勾选），完了重拉清单与总账。 */
  const runRemoveIds = useCallback(
    async (ids: readonly string[]): Promise<void> => {
      if (ids.length === 0) return;
      setCleaning({ done: 0, total: ids.length });
      try {
        const r = await api.removeUploads(ids);
        show('success', t('settings.cleanUnrefDone', { n: r.removed }));
        setDetailChecked(new Set());
        if (expanded) {
          const rows = await api.getSessionUploads(expanded).catch(() => null);
          setDetail(rows);
        }
        await loadStorage();
      } catch (e) {
        show('error', t('settings.cleanFailed', { error: String(e) }));
      } finally {
        setCleaning(null);
      }
    },
    [expanded, loadStorage, show, t],
  );

  /** 批量清勾选的会话（逐会话走既有 DELETE，进度按会话数推进）。 */
  const runCleanupChecked = useCallback(async (): Promise<void> => {
    const ids = [...checked];
    if (ids.length === 0) return;
    setCleaning({ done: 0, total: ids.length });
    let removed = 0;
    try {
      for (const sessionId of ids) {
        const r = await api.deleteSessionUploads(sessionId);
        removed += r.removed;
        setCleaning((c) => (c ? { ...c, done: c.done + 1 } : c));
      }
      show('success', t('settings.cleanBatchDone', { n: removed }));
      setChecked(new Set());
      await loadStorage();
    } catch (e) {
      show('error', t('settings.cleanFailed', { error: String(e) }));
      await loadStorage();
    } finally {
      setCleaning(null);
    }
  }, [checked, loadStorage, show, t]);

  /** 一键清无引用件：确认后逐条清（进度按预告数推进），完了重拉统计。 */
  const runCleanupUnref = useCallback(async (): Promise<void> => {
    const total = unref?.count ?? 0;
    setCleaning({ done: 0, total });
    try {
      const r = await api.cleanupUnreferencedUploads();
      show('success', t('settings.cleanUnrefDone', { n: r.removed }));
    } catch (e) {
      show('error', t('settings.cleanFailed', { error: String(e) }));
    } finally {
      setCleaning(null);
      void loadStorage();
    }
  }, [unref, loadStorage, show, t]);

  /** 按会话清：确认后删该会话全部随附件，完了重拉统计。 */
  const runCleanupSession = useCallback(
    async (sessionId: string): Promise<void> => {
      setCleaning({ done: 0, total: 1 });
      try {
        const r = await api.deleteSessionUploads(sessionId);
        show('success', t('settings.cleanSessionDone', { n: r.removed }));
      } catch (e) {
        show('error', t('settings.cleanFailed', { error: String(e) }));
      } finally {
        setCleaning(null);
        void loadStorage();
      }
    },
    [loadStorage, show, t],
  );

  useEffect(() => {
    if (!open) return;
    setActiveSection('general');
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
  const loadSettings = useCallback(() => {
    setError(null);
    api
      .getDaemonSettings()
      .then((r) => {
        const s = r.settings as DaemonSettingsExt;
        setSettings(s);
        // key 回显：服务端随 GET 返回已存值（掩码展示，眼睛可切明文）
        setApiKeyInput(s.ai?.apiKey ?? '');
        setDecisionKeyInput(s.decision?.apiKey ?? '');
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

  // 移动端返回键/侧滑 = 关闭设置（层退完才落回路由）
  useBackPop(open, () => {
    onClose();
    return true;
  });

  if (!open) return null;

  const preset = settings?.terminal.preset ?? 'auto';
  const customCommand = settings?.terminal.customCommand ?? '';

  // ---- HTML 导出自定义头（多份保存、一份在用；内容只在导出文件里生效）----
  const htmlExport: HtmlExportSettings = settings?.htmlExport ?? { activeId: null, profiles: [] };
  const setHtmlExport = (next: HtmlExportSettings): void =>
    setSettings((s) => (s ? { ...s, htmlExport: next } : s));
  const setActiveHtmlExport = (id: string | null): void =>
    setHtmlExport({ ...htmlExport, activeId: id });
  const patchProfile = (id: string, patch: Partial<HtmlExportProfile>): void =>
    setHtmlExport({
      ...htmlExport,
      profiles: htmlExport.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });
  const addProfile = (): void => {
    // 新配置自动成为「当前使用」：刚加完就要能直接导出，少一步
    const profile: HtmlExportProfile = {
      id:
        typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `p-${Date.now().toString(36)}`,
      name: `${t('settings.htmlExportName')} ${htmlExport.profiles.length + 1}`,
      head: '',
    };
    setHtmlExport({ activeId: profile.id, profiles: [...htmlExport.profiles, profile] });
  };
  const removeProfile = (id: string): void => {
    const profiles = htmlExport.profiles.filter((p) => p.id !== id);
    setHtmlExport({
      profiles,
      activeId: htmlExport.activeId === id ? null : htmlExport.activeId,
    });
  };

  async function handleSave(): Promise<void> {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      // `ai.apiKey` / `decision.apiKey`：输入框是回显态，原样提交（用户没动 = 原值
      // 写回，无害）；清空 = 显式清除（服务端空串即删文件）。
      const payload: DaemonSettingsExt = {
        ...settings,
        ...(settings.ai
          ? {
              ai: {
                baseUrl: settings.ai.baseUrl,
                model: settings.ai.model,
                apiKey: apiKeyInput,
              },
            }
          : {}),
        ...(settings.decision
          ? {
              decision: {
                baseUrl: settings.decision.baseUrl,
                model: settings.decision.model,
                apiKey: decisionKeyInput,
              },
            }
          : {}),
      };
      const saved = await api.putDaemonSettings(payload);
      setSettings(saved as DaemonSettingsExt);
      setApiKeyInput((saved as DaemonSettingsExt).ai?.apiKey ?? '');
      setDecisionKeyInput((saved as DaemonSettingsExt).decision?.apiKey ?? '');
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
      {/* max-h-full：界面缩放（zoom）下 calc(dvh-rem) 混合单位基准错乱会爆高
          （125% 时上下各溢 90px），父容器 inset-0+p-3 的百分比基准可靠。 */}
      <div className="relative w-[640px] max-w-full max-h-full rounded-2xl border border-edge/[0.08] bg-neutral-900 shadow-mac overflow-hidden flex flex-col">
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

        <div className="min-h-0 flex-1 flex overflow-hidden">
          <nav className="hidden lg:flex w-32 shrink-0 flex-col gap-0.5 border-r border-edge/[0.06] p-2">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => jumpToSection(s.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs',
                    activeSection === s.id
                      ? 'bg-edge/[0.08] text-neutral-100'
                      : 'text-neutral-500 hover:text-neutral-200 hover:bg-edge/[0.04]',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t(s.key)}
                </button>
              );
            })}
          </nav>
          <div ref={scrollRef} onScroll={onContentScroll} className="min-w-0 flex-1 overflow-y-auto p-4 space-y-6">
          <SettingsSection id="general" icon={Settings} title={t('settings.sectionGeneral')}>
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
              <Languages className="h-3.5 w-3.5 text-neutral-500" />
              {t('settings.language')}
            </label>
            <p className="text-11 text-neutral-500">{t('settings.languageHint')}</p>
            <Combobox
              className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-xs"
              value={settings?.locale ?? locale}
              options={SUPPORTED_LOCALES.map((l) => ({ value: l, label: LOCALE_NATIVE_NAMES[l] }))}
              onChange={(v) => setSettings((s) => (s ? { ...s, locale: v as Locale } : s))}
            />
          </div>

          {/* 界面缩放：纯本机显示偏好（localStorage），即调即生效，不进保存流程。 */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
              <ZoomIn className="h-3.5 w-3.5 text-neutral-500" />
              {t('settings.fontScale')}
            </label>
            <p className="text-11 text-neutral-500">{t('settings.fontScaleHint')}</p>
            <div className="flex items-center gap-2">
              <NumberStepper
                value={scale}
                min={FONT_SCALE_MIN}
                max={FONT_SCALE_MAX}
                step={FONT_SCALE_STEP}
                onChange={setFontScale}
                title={t('settings.fontScale')}
              />
              <span className="text-11 text-neutral-500">%</span>
              {scale !== 100 && (
                <button
                  type="button"
                  onClick={() => setFontScale(100)}
                  className="rounded-lg bg-neutral-800 px-2 py-1 text-11 text-neutral-300 hover:bg-neutral-700"
                >
                  {t('settings.fontScaleReset')}
                </button>
              )}
            </div>
          </div>
          </SettingsSection>

          <SettingsSection id="service" icon={Server} title={t('settings.sectionService')}>

          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
              <Terminal className="h-3.5 w-3.5 text-neutral-500" />
              {t('settings.defaultTerminal')}
            </label>
            <p className="text-11 text-neutral-500">{t('settings.defaultTerminalHint')}</p>
            <Combobox
              className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-xs"
              value={preset}
              options={presets.map((p) => {
                // 本地词典优先（中英随 UI 切换），未知 id 回落服务端 label
                const key = `preset.${p.id}` as MessageKey;
                return { value: p.id, label: key in zh ? t(key) : p.label };
              })}
              onChange={(v) =>
                setSettings((s) =>
                  s ? { ...s, terminal: { ...s.terminal, preset: v as TerminalPreset } } : s,
                )
              }
            />
          </div>

          {preset === 'custom' && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-neutral-300">
                {t('settings.customCommand')}
              </label>
              <p className="text-11 text-neutral-500">
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
            <p className="text-11 text-neutral-500">{t('settings.hooksHint')}</p>
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
            <p className="text-11 text-neutral-500">{t('settings.launchOnLoginHint')}</p>
          </div>
          </SettingsSection>

          <SettingsSection id="data" icon={Database} title={t('settings.sectionData')}>

          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
              <Database className="h-3.5 w-3.5 text-neutral-500" />
              {t('settings.retentionDays')}
            </label>
            <p className="text-11 text-neutral-500">{t('settings.retentionDaysHint')}</p>
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
              <span className="text-11 text-neutral-500">{t('settings.daysUnit')}</span>
            </div>
          </div>

          {/* 会话保留策略：无操作 n 天后自动移除（期限随会话行的剩余存活倒计时下发）。 */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
              <Clock className="h-3.5 w-3.5 text-neutral-500" />
              {t('settings.sessionIdleDays')}
            </label>
            <p className="text-11 text-neutral-500">
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
              <span className="text-11 text-neutral-500">{t('settings.daysUnit')}</span>
            </div>
          </div>

          {/* 对话附件存储清理（微信式）：总览大数字 + 图/文件占比条 + 「可安全清」
              一键 + 按会话多选批量清 + 展开钻取按单件/分组删。每项先给「是什么、
              多大、清了损什么」再动手；清理中显示进度。 */}
          {overview !== null && unref !== null && (
            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
                <Database className="h-3.5 w-3.5 text-neutral-500" />
                {t('settings.cleanStorage')}
              </label>
              <p className="text-11 text-neutral-500">{t('settings.cleanStorageHint')}</p>

              {/* 总览：大数字 + 图/文件占比条（微信存储页的形态） */}
              <div className="rounded-lg border border-edge/[0.08] bg-neutral-950/60 p-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="text-lg font-semibold text-neutral-100">{fmtBytes(overview.total.bytes)}</span>
                  <span className="text-11 text-neutral-500">
                    {t('settings.cleanTotalStat', { n: overview.total.count })}
                  </span>
                </div>
                {overview.total.bytes > 0 && (
                  <div className="mt-2 space-y-1">
                    <div className="flex h-1.5 overflow-hidden rounded-full bg-neutral-800">
                      <span
                        className="bg-sky-500/80"
                        style={{ width: `${Math.max(overview.images.bytes > 0 ? 2 : 0, (overview.images.bytes / overview.total.bytes) * 100)}%` }}
                      />
                      <span
                        className="bg-violet-500/80"
                        style={{ width: `${Math.max(overview.files.bytes > 0 ? 2 : 0, (overview.files.bytes / overview.total.bytes) * 100)}%` }}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-10 text-neutral-500">
                      <span className="inline-flex items-center gap-1">
                        <ImageIcon className="h-3 w-3 text-sky-400" />
                        {t('settings.cleanImagesStat', { n: overview.images.count, size: fmtBytes(overview.images.bytes) })}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Paperclip className="h-3 w-3 text-violet-400" />
                        {t('settings.cleanFilesStat', { n: overview.files.count, size: fmtBytes(overview.files.bytes) })}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* 可安全清理：无引用件（历史气泡不受影响） */}
              <div className="flex items-center gap-2">
                <span className="text-11 text-neutral-400">
                  {t('settings.cleanUnrefStat', { n: unref.count, size: fmtBytes(unref.bytes) })}
                </span>
                <span className="ml-auto flex items-center gap-2">
                  {cleaning && cleaning.total > 1 && (
                    <span className="text-11 text-blue-300">
                      {t('settings.cleaningProgress', { done: cleaning.done, total: cleaning.total })}
                    </span>
                  )}
                  {cleaning ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-300" />
                  ) : (
                    <button
                      type="button"
                      disabled={unref.count === 0}
                      onClick={() => setConfirmClean('unref')}
                      className="rounded-lg bg-neutral-800 px-2.5 py-1 text-11 text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
                    >
                      {t('settings.cleanUnrefBtn')}
                    </button>
                  )}
                </span>
              </div>

              {/* 按会话清理：多选 + 批量清；行可展开钻取单件 */}
              {usage.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="text-11 text-neutral-500">{t('settings.cleanBySession')}</p>
                    {checked.size > 0 && cleaning === null && (
                      <button
                        type="button"
                        onClick={() => setConfirmClean('__batch__')}
                        className="ml-auto rounded-lg bg-red-500/15 px-2.5 py-1 text-11 text-red-300 hover:bg-red-500/25"
                      >
                        {t('settings.cleanBatchBtn', { n: checked.size })}
                      </button>
                    )}
                  </div>
                  <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
                    {usage.map((u) => {
                      const isOpen = expanded === u.sessionId;
                      return (
                        <li key={u.sessionId} className="rounded bg-neutral-950 border border-edge/[0.06]">
                          <div className="flex items-center gap-2 px-2 py-1">
                            <input
                              type="checkbox"
                              checked={checked.has(u.sessionId)}
                              onChange={(e) =>
                                setChecked((prev) => {
                                  const next = new Set(prev);
                                  if (e.target.checked) next.add(u.sessionId);
                                  else next.delete(u.sessionId);
                                  return next;
                                })
                              }
                              className="shrink-0 accent-blue-500"
                              aria-label={sessionTitles.get(u.sessionId) ?? u.sessionId.slice(0, 8)}
                            />
                            <button
                              type="button"
                              onClick={() => toggleExpand(u.sessionId)}
                              className="shrink-0 rounded p-0.5 text-neutral-500 hover:text-neutral-200"
                              title={isOpen ? t('settings.cleanCollapse') : t('settings.cleanExpand')}
                            >
                              {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                            </button>
                            <span className="min-w-0 flex-1 truncate text-11 text-neutral-300">
                              {sessionTitles.get(u.sessionId) ?? u.sessionId.slice(0, 8)}
                            </span>
                            <span className="shrink-0 text-10 text-neutral-500">
                              {t('settings.cleanSessionStat', { n: u.count, size: fmtBytes(u.bytes) })}
                            </span>
                            {cleaning ? (
                              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-blue-300" />
                            ) : (
                              <button
                                type="button"
                                title={t('settings.cleanSessionDamage')}
                                onClick={() => setConfirmClean(u.sessionId)}
                                className="shrink-0 rounded p-1 text-neutral-500 hover:bg-edge/[0.08] hover:text-red-400"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                          {isOpen && (
                            <div className="border-t border-edge/[0.06] px-2 py-1.5">
                              {detail === null ? (
                                <Loader2 className="h-3 w-3 animate-spin text-neutral-500" />
                              ) : detail.uploads.length === 0 ? (
                                <p className="text-10 text-neutral-600">{t('settings.cleanDetailEmpty')}</p>
                              ) : (
                                <div className="space-y-1">
                                  <ul className="max-h-40 space-y-0.5 overflow-y-auto">
                                    {detail.uploads.map((a) => (
                                      <li key={a.id} className="flex items-center gap-1.5">
                                        <input
                                          type="checkbox"
                                          checked={detailChecked.has(a.id)}
                                          onChange={(e) =>
                                            setDetailChecked((prev) => {
                                              const next = new Set(prev);
                                              if (e.target.checked) next.add(a.id);
                                              else next.delete(a.id);
                                              return next;
                                            })
                                          }
                                          className="shrink-0 accent-blue-500"
                                        />
                                        {isImageUpload(a) ? (
                                          <img
                                            src={`${API_BASE}/images/${a.id}`}
                                            alt=""
                                            className="h-5 w-5 shrink-0 rounded object-cover"
                                            loading="lazy"
                                          />
                                        ) : (
                                          <FileCode className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                                        )}
                                        <span className="min-w-0 flex-1 truncate text-10 text-neutral-300">{a.name}</span>
                                        <span className="shrink-0 text-10 text-neutral-500">{fmtBytes(a.size ?? 0)}</span>
                                      </li>
                                    ))}
                                  </ul>
                                  {detailChecked.size > 0 && cleaning === null && (
                                    <button
                                      type="button"
                                      onClick={() => void runRemoveIds([...detailChecked])}
                                      className="rounded-lg bg-red-500/15 px-2 py-0.5 text-10 text-red-300 hover:bg-red-500/25"
                                    >
                                      {t('settings.cleanSelectedBtn', { n: detailChecked.size })}
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          )}
          </SettingsSection>

          <SettingsSection id="notify" icon={Bell} title={t('settings.sectionNotify')}>

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
            <p className="text-11 text-neutral-500">
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
              <p className="text-11 text-neutral-500">{t('settings.accessUrlsHint')}</p>
              <ul className="space-y-1">
                {urls.map((u) => (
                  <li key={u.url} className="flex items-center gap-1.5">
                    <span
                      className={
                        u.protocol === 'https'
                          ? 'rounded bg-emerald-500/15 px-1.5 py-0.5 text-10 font-medium text-emerald-400'
                          : 'rounded bg-edge/[0.06] px-1.5 py-0.5 text-10 font-medium text-neutral-400'
                      }
                    >
                      {u.scope === 'lan' ? t('settings.urlLan') : t('settings.urlLocal')} ·{' '}
                      {u.protocol.toUpperCase()}
                    </span>
                    <code className="min-w-0 flex-1 truncate rounded bg-neutral-950 border border-edge/[0.06] px-2 py-1 text-11 text-neutral-300">
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
                        <span className="text-10 text-emerald-400">✓</span>
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          </SettingsSection>

          <SettingsSection id="ai" icon={Sparkles} title={t('settings.sectionAi')}>

          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
              <Sparkles className="h-3.5 w-3.5 text-neutral-500" />
              {t('settings.ai')}
            </label>
            <div className="grid grid-cols-2 gap-2">
              <div className="min-w-0 space-y-1">
                <FieldLabel>{t('settings.aiBaseUrl')}</FieldLabel>
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
                  className="w-full min-w-0 rounded-lg bg-neutral-800 border border-edge/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div className="min-w-0 space-y-1">
                <FieldLabel>{t('settings.aiModel')}</FieldLabel>
                <div className="flex items-center gap-1">
                {/* 拉到候选 → 统一 Combobox（可搜，网关模型上百也不卡）；
                    没拉到（有的网关没有 /models）→ 回退文本框手填。 */}
                {models.length > 0 ? (
                  <Combobox
                    className="min-w-0 flex-1 rounded-lg bg-neutral-800 px-2.5 py-1.5 text-xs"
                    value={settings?.ai?.model ?? ''}
                    placeholder={t('settings.aiModelPlaceholder')}
                    options={[
                      // 已存模型不在列表里（网关换过/曾手填）也要能显示，别静默丢值
                      ...(settings?.ai?.model && !models.includes(settings.ai.model)
                        ? [{ value: settings.ai.model }]
                        : []),
                      ...models.map((model) => ({ value: model })),
                    ]}
                    onChange={(v) =>
                      setSettings((s) =>
                        s === null ? s : { ...s, ai: { ...(s.ai ?? { baseUrl: '' }), model: v } },
                      )
                    }
                  />
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
                  className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-neutral-800 px-2 py-1.5 text-11 text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
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
            </div>
            <SecretKeyInput
              name="weaveAiApiKey"
              value={apiKeyInput}
              onChange={setApiKeyInput}
              keySet={settings?.ai?.apiKeySet}
              labels={{
                set: t('settings.aiApiKeySet'),
                unset: t('settings.aiApiKeyUnset'),
                show: t('settings.aiApiKeyShow'),
                hide: t('settings.aiApiKeyHide'),
              }}
            />
            <p className="text-11 text-neutral-500">{t('settings.aiHint')}</p>
          </div>

          {/* 决策模型（Jev 兼容 / System One）：编排条件边的判断引擎——配了先问它，
              判不准/失败回落 fork 子 Agent。 */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
              <Scale className="h-3.5 w-3.5 text-neutral-500" />
              {t('settings.decision')}
            </label>
            <div className="grid grid-cols-2 gap-2">
              <div className="min-w-0 space-y-1">
                <FieldLabel>{t('settings.aiBaseUrl')}</FieldLabel>
                <input
                  value={settings?.decision?.baseUrl ?? ''}
                  onChange={(e) =>
                    setSettings((s) =>
                      s === null
                        ? s
                        : {
                            ...s,
                            decision: { ...(s.decision ?? { model: '' }), baseUrl: e.target.value },
                          },
                    )
                  }
                  placeholder={t('settings.decisionBaseUrlPlaceholder')}
                  className="w-full min-w-0 rounded-lg bg-neutral-800 border border-edge/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div className="min-w-0 space-y-1">
                <FieldLabel>{t('settings.aiModel')}</FieldLabel>
                <input
                  value={settings?.decision?.model ?? ''}
                  onChange={(e) =>
                    setSettings((s) =>
                      s === null
                        ? s
                        : {
                            ...s,
                            decision: { ...(s.decision ?? { baseUrl: '' }), model: e.target.value },
                          },
                    )
                  }
                  placeholder={t('settings.decisionModelPlaceholder')}
                  className="w-full min-w-0 rounded-lg bg-neutral-800 border border-edge/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
            <SecretKeyInput
              name="weaveDecisionApiKey"
              value={decisionKeyInput}
              onChange={setDecisionKeyInput}
              keySet={settings?.decision?.apiKeySet}
              labels={{
                set: t('settings.aiApiKeySet'),
                unset: t('settings.aiApiKeyUnset'),
                show: t('settings.aiApiKeyShow'),
                hide: t('settings.aiApiKeyHide'),
              }}
            />
            <p className="text-11 text-neutral-500">{t('settings.decisionHint')}</p>
          </div>
          </SettingsSection>

          <SettingsSection id="export" icon={FileCode} title={t('settings.sectionExport')}>

          {/* HTML 导出自定义头：多份保存、一份在用；导出时原样注入到 </head> 前。
              这里只编辑**文本**——片段绝不在 dashboard 里渲染或执行。 */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
              <FileCode className="h-3.5 w-3.5 text-neutral-500" />
              {t('settings.htmlExport')}
            </label>
            <p className="text-11 text-neutral-500">{t('settings.htmlExportHint')}</p>
            <div className="space-y-2">
              {htmlExport.profiles.map((profile) => (
                <div
                  key={profile.id}
                  className="space-y-1.5 rounded-lg border border-edge/[0.08] bg-neutral-900/60 p-2"
                >
                  <div className="flex items-center gap-2">
                    <input
                      value={profile.name}
                      onChange={(e) => patchProfile(profile.id, { name: e.target.value })}
                      placeholder={t('settings.htmlExportName')}
                      className="min-w-0 flex-1 rounded bg-neutral-800 border border-edge/[0.08] px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <label className="flex shrink-0 items-center gap-1 text-11 text-neutral-400">
                      <input
                        type="radio"
                        name="htmlExportActive"
                        checked={htmlExport.activeId === profile.id}
                        onChange={() => setActiveHtmlExport(profile.id)}
                        className="accent-blue-500"
                      />
                      {t('settings.htmlExportActive')}
                    </label>
                    <button
                      type="button"
                      onClick={() => removeProfile(profile.id)}
                      title={t('settings.htmlExportDelete')}
                      className="shrink-0 rounded p-1 text-neutral-500 hover:bg-edge/[0.08] hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <textarea
                    value={profile.head}
                    onChange={(e) => patchProfile(profile.id, { head: e.target.value })}
                    placeholder={t('settings.htmlExportHead')}
                    spellCheck={false}
                    rows={6}
                    className="w-full resize-y rounded bg-neutral-950 border border-edge/[0.08] px-2 py-1.5 font-mono text-11 text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              ))}
              {htmlExport.profiles.length === 0 && (
                <p className="text-11 text-neutral-600">{t('settings.htmlExportEmpty')}</p>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={addProfile}
                  className="rounded-lg bg-neutral-800 px-2.5 py-1 text-11 text-neutral-200 hover:bg-neutral-700"
                >
                  {t('settings.htmlExportAdd')}
                </button>
                <button
                  type="button"
                  onClick={() => setActiveHtmlExport(null)}
                  disabled={htmlExport.activeId === null}
                  className="rounded-lg bg-neutral-800 px-2.5 py-1 text-11 text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
                >
                  {t('settings.htmlExportNone')}
                </button>
              </div>
            </div>
          </div>

          </SettingsSection>

          {error && <p className="text-11 text-red-400 break-all">{error}</p>}
          </div>
        </div>

        {/* 清理确认：每项写清「清的是什么、损什么」（原生 confirm/alert 禁用）。 */}
        <ConfirmDialog
          open={confirmClean !== null}
          title={t('settings.cleanConfirmTitle')}
          message={
            confirmClean === 'unref'
              ? t('settings.cleanUnrefDamage', { n: unref?.count ?? 0, size: fmtBytes(unref?.bytes ?? 0) })
              : confirmClean === '__batch__'
                ? t('settings.cleanBatchDamage', {
                    n: checked.size,
                    size: fmtBytes(
                      usage.filter((u) => checked.has(u.sessionId)).reduce((s, u) => s + u.bytes, 0),
                    ),
                  })
                : t('settings.cleanSessionDamageMsg', {
                    name: sessionTitles.get(confirmClean ?? '') ?? (confirmClean ?? '').slice(0, 8),
                    n: usage.find((u) => u.sessionId === confirmClean)?.count ?? 0,
                    size: fmtBytes(usage.find((u) => u.sessionId === confirmClean)?.bytes ?? 0),
                  })
          }
          confirmLabel={t('settings.cleanConfirmBtn')}
          onConfirm={() => {
            if (confirmClean === 'unref') void runCleanupUnref();
            else if (confirmClean === '__batch__') void runCleanupChecked();
            else if (confirmClean) void runCleanupSession(confirmClean);
          }}
          onClose={() => setConfirmClean(null)}
        />

        <footer className="shrink-0 border-t border-edge/[0.06] px-4 py-2.5 flex items-center gap-2 frosted">
          <span className="flex-1 text-11 text-neutral-500">
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
