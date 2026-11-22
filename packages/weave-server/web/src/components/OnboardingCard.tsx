import { useEffect, useState } from 'react';
import { CircleCheck, CircleDashed, FolderOpen, Sparkles, X } from 'lucide-react';
import { api, type ProjectRow } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { useToast } from '@/components/Toast';
import { errorText } from '@/lib/action-feedback';
import { Input } from '@/components/ui/input';
import { Tooltip } from '@/components/ui/tooltip';
import { DirectoryPickerModal } from '@/components/DirectoryPickerModal';
import { HARNESS_UI, HARNESS_ORDER } from '@/lib/harness-meta';
import type { Harness } from '@weavecode/core/harness';

/**
 * 首启引导卡（空项目列表时的三步引导）：接项目（注册 + web 终端自动跑
 * `weave init`，安装确认/初始化确认在终端里由用户作答）→ 初始化状态 →
 * 模型网关配置（不连 Anthropic 官方）。空列表不再只有一句「尚未注册任何项目」。
 */

const ONBOARDING_PROJECT_KEY = 'weave:onboarding-project';
const ONBOARDING_DISMISSED_KEY = 'weave:onboarding-dismissed';

export function onboardingStarted(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_PROJECT_KEY) !== null;
  } catch {
    return false;
  }
}

export function onboardingDismissed(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

interface InstallStatusRow {
  harness: string;
  installed: boolean;
  version: string | null;
}

export function OnboardingCard({
  projects,
  onProjectTerminal,
  onDismissed,
}: {
  /** 当前项目列表（活跃普通项目；卡显隐与步骤二状态都由它推导）。 */
  projects: ProjectRow[];
  /** 步骤一注册成功后打开项目级 web 终端（App 既有弹层），带自动命令。 */
  onProjectTerminal: (instanceId: string, label: string, autoCommand: string) => void;
  onDismissed: () => void;
}) {
  const t = useT();
  const { show } = useToast();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [registering, setRegistering] = useState(false);
  /** 引导跟随的项目（注册成功即定，id 幂等——重复注册同一目录还是它）。 */
  const [projectId, setProjectId] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(ONBOARDING_PROJECT_KEY));
      return Number.isInteger(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  });
  const [installStatus, setInstallStatus] = useState<InstallStatusRow[] | null>(null);
  const [gateway, setGateway] = useState({ baseUrl: '', authToken: '', model: '' });
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testNote, setTestNote] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'ok' | 'fail'>('idle');

  const project = projects.find((p) => p.id === projectId) ?? null;
  const harnesses = project?.harnesses ?? [];
  const allReady = harnesses.length > 0 && harnesses.every((h) => h.canStartSession);

  useEffect(() => {
    api
      .harnessInstallStatus()
      .then(setInstallStatus)
      .catch(() => {});
  }, []);

  /** 步骤一：选目录 → 注册 → 打开项目终端自动跑 `weave init`。 */
  const registerAndOpen = async (paths: string[]): Promise<void> => {
    setPickerOpen(false);
    const dir = paths[0];
    if (!dir || registering) return;
    setRegistering(true);
    try {
      const { project: row } = await api.registerProject(dir);
      try {
        localStorage.setItem(ONBOARDING_PROJECT_KEY, String(row.id));
      } catch {
        // 存不进去就只活这一局
      }
      setProjectId(row.id);
      const opened = await api.openProject(row.id, 'terminal');
      if (opened.instanceId) {
        onProjectTerminal(opened.instanceId, row.name, 'weave init\r');
      } else {
        show('info', t('onboard.runInitManually'));
      }
    } catch (e) {
      show('error', t('onboard.registerFailed', { error: errorText(e) }));
    } finally {
      setRegistering(false);
    }
  };

  /** 步骤三·测一下：凭当前表单值直接调宿主模型接口（不落盘）。 */
  const testGateway = async (): Promise<void> => {
    setTestState('testing');
    setTestNote(null);
    try {
      const r = await api.postConfigModels({
        harness: 'claude',
        file: 'user',
        projectId: null,
        baseUrl: gateway.baseUrl || undefined,
        authToken: gateway.authToken || undefined,
      });
      setTestState('ok');
      setTestNote(t('onboard.testOk', { n: r.models.length }));
    } catch (e) {
      setTestState('fail');
      setTestNote(errorText(e));
    }
  };

  /** 步骤三·保存：读现值 → 合并 env 三键 → 整份写盘（走既有备份+基线链路）。 */
  const saveGateway = async (): Promise<void> => {
    setSaveState('saving');
    try {
      const view = await api.getHarnessConfig('claude', 'user', null);
      const env = { ...((view.values.env as Record<string, unknown> | undefined) ?? {}) };
      if (gateway.baseUrl) env.ANTHROPIC_BASE_URL = gateway.baseUrl;
      if (gateway.authToken) env.ANTHROPIC_AUTH_TOKEN = gateway.authToken;
      if (gateway.model) env.ANTHROPIC_MODEL = gateway.model;
      await api.putConfigValues({
        harness: 'claude',
        file: 'user',
        projectId: null,
        values: { ...view.values, env },
      });
      setSaveState('ok');
      show('success', t('onboard.saveOk'));
    } catch (e) {
      setSaveState('fail');
      show('error', t('onboard.saveFailed', { error: errorText(e) }));
    }
  };

  const dismiss = (): void => {
    try {
      localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1');
    } catch {
      // 存不进去也照关（本局不再现）
    }
    onDismissed();
  };

  const stepIcon = (done: boolean): typeof CircleCheck =>
    done ? CircleCheck : CircleDashed;

  return (
    <div className="relative rounded-lg border border-edge/[0.1] bg-neutral-900/60 p-4 shadow-mac">
      <div className="flex items-center gap-2 pb-1">
        <Sparkles className="size-4 shrink-0 text-mac-accent" />
        <h3 className="text-sm font-semibold">{t('onboard.title')}</h3>
        <p className="min-w-0 flex-1 truncate text-11 text-neutral-500">{t('onboard.subtitle')}</p>
        <Tooltip label={t('onboard.dismiss')} side="top">
          <button
            type="button"
            aria-label={t('onboard.dismiss')}
            onClick={dismiss}
            className="rounded-md p-1 text-neutral-500 transition-colors hover:bg-edge/[0.06] hover:text-neutral-200"
          >
            <X className="size-3.5" />
          </button>
        </Tooltip>
      </div>

      <ol className="space-y-3 pt-2">
        {/* 步骤一 · 接项目 */}
        <li className="flex items-start gap-2.5">
          {(() => {
            const Icon = stepIcon(!!project);
            return <Icon className="mt-0.5 size-4 shrink-0 text-mac-accent" />;
          })()}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">{t('onboard.step1Title')}</p>
            <p className="pt-0.5 text-11 leading-relaxed text-neutral-500">{t('onboard.step1Desc')}</p>
            <div className="flex flex-wrap items-center gap-2 pt-1.5">
              <button
                type="button"
                disabled={registering}
                onClick={() => setPickerOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-edge/[0.12] bg-neutral-800 px-2.5 py-1 text-xs font-medium text-neutral-200 transition-colors hover:bg-neutral-700 disabled:opacity-40"
              >
                <FolderOpen className="size-3.5" />
                {project ? t('onboard.step1Picked', { name: project.name }) : t('onboard.step1Pick')}
              </button>
              {project && <span className="truncate text-10 text-neutral-600">{project.path}</span>}
            </div>
          </div>
        </li>

        {/* 步骤二 · 初始化（harness 选择/安装确认在终端里作答） */}
        <li className="flex items-start gap-2.5">
          {(() => {
            const Icon = stepIcon(allReady);
            return <Icon className="mt-0.5 size-4 shrink-0 text-mac-accent" />;
          })()}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">{t('onboard.step2Title')}</p>
            <p className="pt-0.5 text-11 leading-relaxed text-neutral-500">{t('onboard.step2Desc')}</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1.5">
              {HARNESS_ORDER.map((h) => {
                const ui = HARNESS_UI[h];
                const machine = installStatus?.find((s) => s.harness === h);
                const integrated = harnesses.find((x) => x.id === (h as Harness));
                return (
                  <span key={h} className="inline-flex items-center gap-1 text-11">
                    <ui.icon className={`size-3 ${machine?.installed || integrated ? ui.iconIdle : 'text-neutral-600'}`} />
                    <span className={integrated ? 'text-neutral-200' : 'text-neutral-500'}>
                      {ui.label}
                    </span>
                    <span className="text-10 text-neutral-600">
                      {integrated
                        ? integrated.canStartSession
                          ? t('onboard.harnessReady')
                          : t('onboard.harnessVersionLow')
                        : machine?.installed
                          ? t('onboard.harnessInstalled')
                          : t('onboard.harnessMissing')}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        </li>

        {/* 步骤三 · 模型网关（不连 Anthropic 官方） */}
        <li className="flex items-start gap-2.5">
          {(() => {
            const Icon = stepIcon(saveState === 'ok');
            return <Icon className="mt-0.5 size-4 shrink-0 text-mac-accent" />;
          })()}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">{t('onboard.step3Title')}</p>
            <p className="pt-0.5 text-11 leading-relaxed text-neutral-500">{t('onboard.step3Desc')}</p>
            <div className="grid gap-1.5 pt-1.5 sm:grid-cols-3">
              <Input
                value={gateway.baseUrl}
                onChange={(e) => setGateway((g) => ({ ...g, baseUrl: e.target.value.trim() }))}
                placeholder={t('onboard.fieldBaseUrl')}
                spellCheck={false}
              />
              <Input
                value={gateway.authToken}
                onChange={(e) => setGateway((g) => ({ ...g, authToken: e.target.value.trim() }))}
                placeholder={t('onboard.fieldToken')}
                type="password"
                spellCheck={false}
              />
              <Input
                value={gateway.model}
                onChange={(e) => setGateway((g) => ({ ...g, model: e.target.value.trim() }))}
                placeholder={t('onboard.fieldModel')}
                spellCheck={false}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1.5">
              <button
                type="button"
                disabled={testState === 'testing'}
                onClick={() => void testGateway()}
                className="rounded-md border border-edge/[0.12] bg-neutral-800 px-2.5 py-1 text-xs font-medium text-neutral-200 transition-colors hover:bg-neutral-700 disabled:opacity-40"
              >
                {t('onboard.test')}
              </button>
              <button
                type="button"
                disabled={saveState === 'saving' || (!gateway.baseUrl && !gateway.authToken && !gateway.model)}
                onClick={() => void saveGateway()}
                className="rounded-md bg-mac-accent px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {t('onboard.save')}
              </button>
              {testNote && (
                <span
                  className={`min-w-0 truncate text-10 ${testState === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}
                >
                  {testNote}
                </span>
              )}
            </div>
            <p className="pt-1 text-10 text-neutral-600">{t('onboard.step3Footnote')}</p>
          </div>
        </li>
      </ol>

      {pickerOpen && (
        <DirectoryPickerModal
          open
          existingPaths={projects.map((p) => p.path)}
          onClose={() => setPickerOpen(false)}
          onConfirm={(paths) => void registerAndOpen(paths)}
        />
      )}
    </div>
  );
}
