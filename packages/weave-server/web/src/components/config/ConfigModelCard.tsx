import { useState } from 'react';
import { Eye, EyeOff, RefreshCw } from 'lucide-react';
import { api, type ConfigFileId, type ConfigModelOption, type ConfigModelsResponse } from '@/lib/api';
import type { Harness } from '@weavecode/core/harness';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';

const INPUT_CLS =
  'w-full rounded-md bg-neutral-900 border border-edge/[0.08] px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-mac-accent/50';

/**
 * 模型：拿配置里的 API 地址 + key 去问宿主能开哪些模型，选中即写进配置的 `model` 键。
 * 手填的 key 只经这一次请求，不落盘（写进配置要回表单那一行自己写）。
 */
export function ConfigModelCard({
  harness,
  file,
  projectId,
  currentModel,
  configuredBaseUrl,
  configuredCredential,
  onApply,
}: {
  harness: Harness;
  file: ConfigFileId;
  projectId: number | null;
  /** 配置里现在的 `model` 值。 */
  currentModel: unknown;
  /** 配置里的 `env.ANTHROPIC_BASE_URL`（占位提示用）。 */
  configuredBaseUrl: string;
  /** 配置里是否已有 key / token（只用来出提示，不读值）。 */
  configuredCredential: boolean;
  onApply: (modelId: string) => void;
}) {
  const t = useT();
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  // 未聚焦前 readOnly：密码管理器只在字段可写时自动填充，这是最硬的一道闸
  // （autoComplete/ignore 属性在部分浏览器会被忽略，readOnly 不会），否则浏览器存的
  // 登录凭据会直接填进来把 placeholder 的提示盖掉。
  const [keyFocused, setKeyFocused] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConfigModelsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchModels = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api.postConfigModels({
          harness,
          file,
          projectId,
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      );
    } catch (err) {
      setError((err as Error).message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const credentialLabel = (credential: ConfigModelsResponse['credential']): string =>
    credential === 'none' ? t('cfg.modelsCredNone') : credential;

  return (
    <section className="rounded-xl border border-edge/[0.06] bg-neutral-900/40 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-neutral-300">{t('cfg.models')}</span>
        <span className="text-11 text-neutral-500">{t('cfg.modelsHint')}</span>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-11 text-neutral-500">{t('cfg.modelsBaseUrl')}</span>
          <input
            value={baseUrl}
            placeholder={configuredBaseUrl || t('cfg.modelsBaseUrlPlaceholder')}
            onChange={(e) => setBaseUrl(e.target.value)}
            className={INPUT_CLS}
          />
        </label>
        <label className="space-y-1">
          <span className="text-11 text-neutral-500">{t('cfg.modelsApiKey')}</span>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={apiKey}
              readOnly={!keyFocused}
              onFocus={() => setKeyFocused(true)}
              onBlur={() => setKeyFocused(false)}
              onChange={(e) => setApiKey(e.target.value)}
              // 不是登录凭据：显式让浏览器与密码管理器别当密码字段填（同设置里 AI key 那框）。
              // 掩码走 CSS（masked-input）而非 type=password：后者会让浏览器把前面的
              // 地址框当用户名、这里当密码，弹「保存凭据」并自动填充。
              // one-time-code 比 off/new-password 稳：既不自填已存凭据，也不弹强密码生成器。
              name="weaveConfigModelApiKey"
              autoComplete="one-time-code"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              placeholder={
                configuredCredential
                  ? t('cfg.modelsApiKeyConfigured')
                  : t('cfg.modelsApiKeyPlaceholder')
              }
              className={cn(INPUT_CLS, !showKey && 'masked-input')}
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              title={showKey ? t('cfg.modelsApiKeyHide') : t('cfg.modelsApiKeyShow')}
              className="shrink-0 rounded-md bg-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-700"
            >
              {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
        </label>
      </div>

      <div className="flex items-center gap-2">
        <button
          disabled={busy}
          onClick={() => void fetchModels()}
          className="inline-flex items-center gap-1 rounded-md bg-neutral-800 px-2.5 py-1 text-11 text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
        >
          <RefreshCw className={cn('h-3 w-3', busy && 'animate-spin')} />
          {busy ? t('cfg.modelsFetching') : t('cfg.modelsFetch')}
        </button>
        {result && (
          <span className="text-11 text-neutral-500">
            {t('cfg.modelsCount', {
              count: result.models.length,
              credential: credentialLabel(result.credential),
            })}
          </span>
        )}
        {error && <span className="text-11 text-red-400">{t('cfg.modelsFailed', { error })}</span>}
      </div>

      {currentModel !== undefined && (
        <p className="text-11 text-neutral-500">
          {t('cfg.modelsCurrent')}：<span className="font-mono text-neutral-300">{String(currentModel)}</span>
        </p>
      )}

      {result && result.models.length === 0 && (
        <p className="text-11 text-neutral-500">{t('cfg.modelsEmpty')}</p>
      )}

      {result && result.models.length > 0 && (
        <ul className="max-h-56 overflow-auto rounded-lg border border-edge/[0.06]">
          {result.models.map((model: ConfigModelOption) => (
            <li
              key={model.id}
              className="flex items-center gap-2 border-b border-edge/[0.04] last:border-0 px-2 py-1"
            >
              <span className="font-mono text-11 text-neutral-200 break-all">{model.id}</span>
              {model.name && <span className="text-11 text-neutral-500">{model.name}</span>}
              <button
                onClick={() => onApply(model.id)}
                className="ml-auto rounded-md bg-neutral-800 px-2 py-0.5 text-11 text-neutral-200 hover:bg-neutral-700"
              >
                {t('cfg.modelsApply')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
