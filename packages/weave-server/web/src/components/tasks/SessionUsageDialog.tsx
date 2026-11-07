import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X } from 'lucide-react';
import { api, type SessionUsage } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { useBackPop } from '@/lib/back-pop';
import { Tooltip } from '@/components/ui/tooltip';

/** 1 万往上缩写成 1.2w——每轮一行，长数字比短列更难对齐。 */
function compact(n: number): string {
  if (n >= 10_000_000) return `${Math.round(n / 1_000_000)}m`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)}w`;
  return n.toLocaleString();
}

/**
 * 会话用量：各轮 token 计量（转录里现成的数字，纯只读——成本折算不做，牌价随
 * 时间变）。取数归 harness 能力面，这条弹窗只摆；没有该面 / 读不到转录如实置灰。
 */
export function SessionUsageDialog({
  sessionId,
  open,
  onClose,
}: {
  sessionId: string;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const [data, setData] = useState<SessionUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setError(null);
    setData(null);
    api
      .sessionUsage(sessionId)
      .then((r) => live && setData(r))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [open, sessionId]);

  // 移动端返回键/侧滑 = 关闭弹窗
  useBackPop(open, () => {
    onClose();
    return true;
  });

  const turns = data?.usage ?? [];

  const total = useMemo(
    () =>
      turns.reduce(
        (acc, u) => ({
          input: acc.input + u.inputTokens,
          output: acc.output + u.outputTokens,
          cacheRead: acc.cacheRead + u.cacheReadInputTokens,
          cacheCreation: acc.cacheCreation + u.cacheCreationInputTokens,
        }),
        { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      ),
    [turns],
  );

  if (!open) return null;

  const unavailable =
    !loading && !error && data && !data.supported
      ? t('tasks.usageUnsupported')
      : !loading && !error && data && turns.length === 0
        ? t('tasks.usageEmpty')
        : null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 lg:p-6">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-[560px] max-w-full max-h-[86%] rounded-2xl border border-edge/[0.08] bg-neutral-900 shadow-mac overflow-hidden flex flex-col">
        <header className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-edge/[0.06] frosted">
          <span className="text-sm font-semibold text-neutral-200">{t('tasks.usageTitle')}</span>
          {turns.length > 0 && (
            <span className="text-11 text-neutral-500">
              {t('tasks.usageTurns', { n: turns.length })}
              {' · '}
              {t('tasks.usageIn', { n: compact(total.input + total.cacheRead + total.cacheCreation) })}
              {' · '}
              {t('tasks.usageOut', { n: compact(total.output) })}
            </span>
          )}
          <Tooltip label={t('common.close')} className="ml-auto">
            <button
              onClick={onClose}
              className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800"
            >
              <X className="h-4 w-4" />
            </button>
          </Tooltip>
        </header>

        <div className="flex-1 min-h-0 overflow-auto">
          {loading && (
            <p className="flex items-center gap-2 p-4 text-11 text-neutral-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('tasks.usageLoading')}
            </p>
          )}
          {error && <p className="p-4 text-11 text-red-300">{error}</p>}
          {unavailable && <p className="p-4 text-11 text-neutral-500">{unavailable}</p>}
          {turns.length > 0 && (
            <table className="w-full text-11">
              <thead>
                <tr className="text-10 text-neutral-600 border-b border-edge/[0.06]">
                  <th className="px-4 py-1.5 text-left font-normal">{t('tasks.usageColAt')}</th>
                  <th className="px-2 py-1.5 text-right font-normal">{t('tasks.usageColInput')}</th>
                  <th className="px-2 py-1.5 text-right font-normal">{t('tasks.usageColCacheRead')}</th>
                  <th className="px-2 py-1.5 text-right font-normal">{t('tasks.usageColCacheWrite')}</th>
                  <th className="px-2 py-1.5 text-right font-normal">{t('tasks.usageColOutput')}</th>
                  <th className="px-4 py-1.5 text-right font-normal">{t('tasks.usageColContext')}</th>
                </tr>
              </thead>
              <tbody>
                {turns.map((u, idx) => (
                  <tr key={idx} className="border-b border-edge/[0.04] last:border-b-0">
                    <td className="px-4 py-1.5 text-neutral-500 whitespace-nowrap">
                      {stamp(u.at) || '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-neutral-200">
                      {compact(u.inputTokens)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-neutral-400">
                      {u.cacheReadInputTokens ? compact(u.cacheReadInputTokens) : '·'}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-neutral-400">
                      {u.cacheCreationInputTokens ? compact(u.cacheCreationInputTokens) : '·'}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-neutral-200">
                      {compact(u.outputTokens)}
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono text-neutral-500">
                      {u.contextTokens != null ? compact(u.contextTokens) : '·'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {turns.length > 0 && (
          <footer className="shrink-0 border-t border-edge/[0.06] px-4 py-2 text-10 text-neutral-600 frosted">
            {t('tasks.usageFootnote', {
              in: compact(total.input),
              cacheRead: compact(total.cacheRead),
              cacheWrite: compact(total.cacheCreation),
              out: compact(total.output),
            })}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** 一轮完成时刻（本地 `MM-DD HH:mm`）；宿主没带就是空。 */
function stamp(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
