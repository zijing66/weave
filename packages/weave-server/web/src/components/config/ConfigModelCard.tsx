import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
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
  onApply,
}: {
  harness: Harness;
  file: ConfigFileId;
  projectId: number | null;
  /** 配置里现在的 `model` 值。 */
  currentModel: unknown;
  /** 配置里的 `env.ANTHROPIC_BASE_URL`（占位提示用）。 */
  configuredBaseUrl: string;
  onApply: (modelId: string) => void;
}) {
  const t = useT();
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
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
        <span className="text-[11px] text-neutral-500">{t('cfg.modelsHint')}</span>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-[11px] text-neutral-500">{t('cfg.modelsBaseUrl')}</span>
          <input
            value={baseUrl}
            placeholder={configuredBaseUrl || t('cfg.modelsBaseUrlPlaceholder')}
            onChange={(e) => setBaseUrl(e.target.value)}
            className={INPUT_CLS}
          />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-neutral-500">{t('cfg.modelsApiKey')}</span>
          <input
            type="password"
            value={apiKey}
            placeholder={t('cfg.modelsApiKeyPlaceholder')}
            onChange={(e) => setApiKey(e.target.value)}
            className={INPUT_CLS}
          />
        </label>
      </div>

      <div className="flex items-center gap-2">
        <button
          disabled={busy}
          onClick={() => void fetchModels()}
          className="inline-flex items-center gap-1 rounded-md bg-neutral-800 px-2.5 py-1 text-[11px] text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
        >
          <RefreshCw className={cn('h-3 w-3', busy && 'animate-spin')} />
          {busy ? t('cfg.modelsFetching') : t('cfg.modelsFetch')}
        </button>
        {result && (
          <span className="text-[11px] text-neutral-500">
            {t('cfg.modelsCount', {
              count: result.models.length,
              credential: credentialLabel(result.credential),
            })}
          </span>
        )}
        {error && <span className="text-[11px] text-red-400">{t('cfg.modelsFailed', { error })}</span>}
      </div>

      {currentModel !== undefined && (
        <p className="text-[11px] text-neutral-500">
          {t('cfg.modelsCurrent')}：<span className="font-mono text-neutral-300">{String(currentModel)}</span>
        </p>
      )}

      {result && result.models.length === 0 && (
        <p className="text-[11px] text-neutral-500">{t('cfg.modelsEmpty')}</p>
      )}

      {result && result.models.length > 0 && (
        <ul className="max-h-56 overflow-auto rounded-lg border border-edge/[0.06]">
          {result.models.map((model: ConfigModelOption) => (
            <li
              key={model.id}
              className="flex items-center gap-2 border-b border-edge/[0.04] last:border-0 px-2 py-1"
            >
              <span className="font-mono text-[11px] text-neutral-200 break-all">{model.id}</span>
              {model.name && <span className="text-[11px] text-neutral-500">{model.name}</span>}
              <button
                onClick={() => onApply(model.id)}
                className="ml-auto rounded-md bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-200 hover:bg-neutral-700"
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
