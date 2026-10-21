import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileWarning, RefreshCw } from 'lucide-react';
import {
  api,
  type ConfigCatalogResponse,
  type ConfigFileId,
  type ConfigKeySpec,
  type ConfigUpdate,
  type ConfigView,
} from '@/lib/api';
import type { Harness } from '@weavecode/core/harness';
import { HARNESS_ORDER, harnessUiOf } from '@/lib/harness-meta';
import { groupKeys, matchesQuery, valueAt, valueOfText } from '@/lib/config-form';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';
import { ConfigValueRow, type RowEdit } from './ConfigValueRow';
import { ConfigProfiles } from './ConfigProfiles';
import { ConfigModelCard } from './ConfigModelCard';
import { DiffDialog } from './DiffDialog';

const FILE_LABEL: Record<ConfigFileId, MessageKey> = {
  user: 'cfg.file.user',
  project: 'cfg.file.project',
  projectLocal: 'cfg.file.projectLocal',
  global: 'cfg.file.global',
};

type Filter = 'all' | 'set' | 'unset';

const FILTERS: { key: Filter; label: MessageKey }[] = [
  { key: 'all', label: 'cfg.all' },
  { key: 'set', label: 'cfg.setOnly' },
  { key: 'unset', label: 'cfg.unsetOnly' },
];

/**
 * 资源管理 · 配置视图：一个 harness 的配置文件全量接管。
 *
 * 词表（含未设置的键）由服务端按官方文档派生；表单改动先攒成 edits，
 * 一次 PUT 落到活文件并同步激活快照。切换快照与漂移都先弹 diff 再落盘。
 */
export function HarnessConfigPanel({
  harness,
  projectId,
}: {
  /** 资源管理页的 harness 页签（'all' 时取第一个有配置面的）。 */
  harness: Harness | 'all';
  /** global 视图没有项目（project 档不出现）。 */
  projectId: number | null;
}) {
  const t = useT();
  // 'all' 页签要落到一个真有配置面的 harness 上：面清单由 /capabilities 派生
  const [configHarnesses, setConfigHarnesses] = useState<Harness[] | null>(null);
  useEffect(() => {
    void api
      .capabilities()
      .then((caps) => setConfigHarnesses(caps.config ?? []))
      .catch(() => setConfigHarnesses([]));
  }, []);
  const target: Harness =
    harness !== 'all' ? harness : (configHarnesses?.[0] ?? HARNESS_ORDER[0]);

  const [file, setFile] = useState<ConfigFileId>(projectId != null ? 'project' : 'user');
  const [catalog, setCatalog] = useState<ConfigCatalogResponse | null>(null);
  const [view, setView] = useState<ConfigView | null>(null);
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState('');
  const [diffState, setDiffState] = useState<{
    title: string;
    beforeLabel: string;
    afterLabel: string;
    before: string;
    after: string;
    acceptKey: string;
    onAccept: () => void;
  } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const nextCatalog = await api.getConfigCatalog(target, file);
      setCatalog(nextCatalog);
      if (!nextCatalog.supported) {
        setView(null);
        return;
      }
      setView(await api.getHarnessConfig(target, file, projectId));
      setEdits({});
    } catch (err) {
      setError((err as Error).message);
    }
  }, [target, file, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => setRawMode(false), [file, target]);

  const values = view?.values ?? {};
  const managed = view?.managedKeys ?? [];

  const currentValue = useCallback(
    (dotted: string): unknown => {
      const edit = edits[dotted];
      if (edit) return edit.remove ? undefined : edit.value;
      return valueAt(values, dotted);
    },
    [edits, values],
  );

  const isManaged = useCallback(
    (dotted: string): boolean =>
      managed.some((m) => dotted === m || dotted.startsWith(`${m}.`)),
    [managed],
  );

  const setEdit = (dotted: string, edit: RowEdit): void => {
    setEdits((prev) => ({ ...prev, [dotted]: edit }));
  };

  const pendingCount = Object.keys(edits).length;

  const save = async (): Promise<void> => {
    if (pendingCount === 0 || !catalog) return;
    const updates: ConfigUpdate[] = Object.entries(edits).map(([path, edit]) =>
      edit.remove ? { path, remove: true } : { path, value: edit.value },
    );
    setBusy(true);
    setError(null);
    try {
      setView(await api.putConfigValues({ harness: target, file, projectId, updates }));
      setEdits({});
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveRaw = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setView(await api.putConfigRaw({ harness: target, file, projectId, text: rawText }));
      setEdits({});
      setRawMode(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const profileAction = async (body: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.postConfigProfile<ConfigView & Record<string, unknown>>({
        harness: target,
        file,
        projectId,
        ...body,
      });
      if ('values' in res) setView(res);
      else await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const activate = async (id: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const preview = await api.postConfigProfile<{
        requiresConfirm?: boolean;
        liveText: string;
        profileText: string;
      }>({ harness: target, file, projectId, action: 'activate', id });
      if (!preview.requiresConfirm) return;
      setDiffState({
        title: t('cfg.switchTitle'),
        beforeLabel: t('cfg.diffLive'),
        afterLabel: t('cfg.diffProfile'),
        before: preview.liveText,
        after: preview.profileText,
        acceptKey: 'cfg.switchConfirm',
        onAccept: () => void profileAction({ action: 'activate', id, confirm: true }),
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const groups = useMemo(() => {
    if (!catalog) return [];
    const inScope = catalog.keys.filter((key) => {
      const set = currentValue(key.key) !== undefined;
      if (filter === 'set' && !set) return false;
      if (filter === 'unset' && set) return false;
      return matchesQuery(key.key, key.description, query);
    });
    return groupKeys(inScope, catalog.groups);
  }, [catalog, currentValue, filter, query]);

  const envRows = useMemo(() => {
    if (!catalog) return [];
    const env = valueAt(values, 'env');
    const setNames = new Set(
      typeof env === 'object' && env !== null && !Array.isArray(env) ? Object.keys(env) : [],
    );
    const editedNames = Object.keys(edits)
      .filter((k) => k.startsWith('env.'))
      .map((k) => k.slice(4));
    for (const name of editedNames) {
      const edit = edits[`env.${name}`];
      if (edit?.remove) setNames.delete(name);
      else setNames.add(name);
    }
    if (filter === 'unset') return [];
    const all = catalog.envVars;
    const matched = query.trim()
      ? all.filter((v) => matchesQuery(v.name, v.description, query)).slice(0, 50)
      : all.filter((v) => setNames.has(v.name));
    return matched;
  }, [catalog, edits, filter, query, values]);

  if (catalog && !catalog.supported) {
    return (
      <div className="rounded-xl border border-dashed border-edge/[0.1] bg-neutral-900/40 p-8 text-center">
        <FileWarning className="mx-auto h-8 w-8 text-neutral-600" />
        <p className="mt-3 text-sm text-neutral-300">
          {t('cfg.unsupported', { harness: harnessUiOf(target).label })}
        </p>
        <p className="mt-1 text-xs text-neutral-500">{t('cfg.unsupportedHint')}</p>
      </div>
    );
  }

  if (!catalog || !view) {
    return (
      <div className="rounded-xl border border-edge/[0.06] bg-neutral-900/40 p-6 text-center text-xs text-neutral-500">
        {error ?? '…'}
      </div>
    );
  }

  const files = catalog.files.filter((f) => projectId != null || (f.id !== 'project' && f.id !== 'projectLocal'));

  return (
    <div className="space-y-3">
      {/* 档位 + 落点 + 保存 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg bg-neutral-900/60 border border-edge/[0.06] p-0.5 w-fit">
          {files.map((f) => (
            <button
              key={f.id}
              onClick={() => setFile(f.id)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150',
                file === f.id
                  ? 'bg-neutral-800 text-neutral-100 shadow-mac-sm'
                  : 'text-neutral-500 hover:text-neutral-300',
              )}
            >
              {t(FILE_LABEL[f.id])}
            </button>
          ))}
        </div>
        <span className="font-mono text-[10px] text-neutral-600 break-all" title={t('cfg.fileHint')}>
          {view.path || '—'}
        </span>
        {!view.exists && <span className="text-[10px] text-amber-400/80">{t('cfg.notExists')}</span>}
        <div className="ml-auto flex items-center gap-2">
          {pendingCount > 0 && (
            <span className="text-[11px] text-amber-300">{t('cfg.pending', { count: pendingCount })}</span>
          )}
          {pendingCount > 0 && (
            <button
              onClick={() => setEdits({})}
              className="rounded-md bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700"
            >
              {t('cfg.reset')}
            </button>
          )}
          <button
            disabled={busy || pendingCount === 0}
            onClick={() => void save()}
            className="rounded-md bg-mac-accent px-3 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {busy ? t('cfg.saving') : t('cfg.save')}
          </button>
          <button
            onClick={() => void load()}
            title={t('cfg.reload')}
            className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {error && <p className="text-[11px] text-red-400">{t('cfg.saveFailed', { error })}</p>}

      {/* 漂移 */}
      {view.drifted && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2">
          <FileWarning className="h-4 w-4 text-amber-400" />
          <span className="text-xs text-amber-200">{t('cfg.drift')}</span>
          <span className="text-[11px] text-neutral-500">{t('cfg.driftHint')}</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() =>
                setDiffState({
                  title: t('cfg.diffTitle'),
                  beforeLabel: t('cfg.diffProfile'),
                  afterLabel: t('cfg.diffLive'),
                  before: view.activeText ?? '',
                  after: view.liveText,
                  acceptKey: 'cfg.driftAccept',
                  onAccept: () => void profileAction({ action: 'acceptDrift', id: view.activeId }),
                })
              }
              className="rounded-md bg-neutral-800 px-2 py-1 text-[11px] text-neutral-200 hover:bg-neutral-700"
            >
              {t('cfg.driftDiff')}
            </button>
            <button
              onClick={() => void profileAction({ action: 'acceptDrift', id: view.activeId })}
              className="rounded-md bg-amber-500/20 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-500/30"
            >
              {t('cfg.driftAccept')}
            </button>
          </div>
        </div>
      )}

      <ConfigProfiles
        profiles={view.profiles}
        activeId={view.activeId}
        enabled={files.find((f) => f.id === file)?.profiles ?? false}
        busy={busy}
        onCreate={(name) => void profileAction({ action: 'create', name })}
        onRename={(id, name) => void profileAction({ action: 'rename', id, name })}
        onDuplicate={(id) => void profileAction({ action: 'duplicate', id })}
        onRemove={(id) => void profileAction({ action: 'remove', id })}
        onSaveActive={() => void profileAction({ action: 'save', id: view.activeId })}
        onActivate={(id) => void activate(id)}
      />

      <ConfigModelCard
        harness={target}
        file={file}
        projectId={projectId}
        currentModel={currentValue('model')}
        configuredBaseUrl={(() => {
          const env = valueAt(values, 'env');
          const url = typeof env === 'object' && env !== null ? valueAt(env as Record<string, unknown>, 'ANTHROPIC_BASE_URL') : undefined;
          return typeof url === 'string' ? url : '';
        })()}
        onApply={(modelId) => setEdit('model', { value: modelId })}
      />

      {/* 搜索 / 过滤 / 原始视图 */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('cfg.search')}
          className="w-56 rounded-md bg-neutral-900 border border-edge/[0.08] px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-mac-accent/50"
        />
        <div className="flex items-center gap-1 rounded-lg bg-neutral-900/60 border border-edge/[0.06] p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                'rounded-md px-2 py-0.5 text-[11px]',
                filter === f.key ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300',
              )}
            >
              {t(f.label)}
            </button>
          ))}
        </div>
        <button
          onClick={() => {
            setRawMode((v) => !v);
            setRawText(view.liveText);
          }}
          className={cn(
            'ml-auto rounded-md px-2 py-1 text-[11px]',
            rawMode ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300',
          )}
          title={t('cfg.rawHint')}
        >
          {t('cfg.raw')}
        </button>
      </div>

      {rawMode ? (
        <div className="space-y-2">
          <textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            spellCheck={false}
            className="w-full min-h-[40dvh] rounded-xl border border-edge/[0.08] bg-neutral-950/60 p-3 font-mono text-[11px] leading-5 text-neutral-200 focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              disabled={busy}
              onClick={() => void saveRaw()}
              className="rounded-md bg-mac-accent px-3 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {t('cfg.save')}
            </button>
            <button
              onClick={() => setRawText(view.liveText)}
              className="rounded-md bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700"
            >
              {t('cfg.reset')}
            </button>
            {valueOfText(rawText).error === 'invalidJson' && (
              <span className="text-[11px] text-red-400">{t('cfg.invalidJson')}</span>
            )}
          </div>
        </div>
      ) : (
        <>
          {groups.length === 0 && <p className="text-[11px] text-neutral-500">{t('cfg.empty')}</p>}
          {groups.map((group) => {
            const isCollapsed = collapsed[group.group] ?? false;
            return (
              <section key={group.group} className="rounded-xl border border-edge/[0.06] bg-neutral-900/40">
                <button
                  onClick={() => setCollapsed((prev) => ({ ...prev, [group.group]: !isCollapsed }))}
                  className="flex w-full items-center gap-1.5 px-3 py-2 text-left"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-3 w-3 text-neutral-500" />
                  ) : (
                    <ChevronDown className="h-3 w-3 text-neutral-500" />
                  )}
                  <span className="text-xs font-semibold text-neutral-300">{group.group}</span>
                  <span className="text-[11px] text-neutral-600">{group.keys.length}</span>
                </button>
                {!isCollapsed && (
                  <div className="grid gap-1.5 px-3 pb-3 sm:grid-cols-2">
                    {group.keys.map((key: ConfigKeySpec) => (
                      <ConfigValueRow
                        key={key.key}
                        spec={key}
                        value={currentValue(key.key)}
                        managed={isManaged(key.key)}
                        onChange={(edit) => setEdit(key.key, edit)}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}

          {/* env 块 */}
          <section className="rounded-xl border border-edge/[0.06] bg-neutral-900/40 p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-neutral-300">{t('cfg.env')}</span>
              <span className="text-[11px] text-neutral-500">{t('cfg.envHint')}</span>
            </div>
            {envRows.length === 0 ? (
              <p className="text-[11px] text-neutral-500">{t('cfg.envEmpty')}</p>
            ) : (
              <div className="space-y-1">
                {envRows.map((envVar) => {
                  const dotted = `env.${envVar.name}`;
                  const value = currentValue(dotted);
                  return (
                    <div key={envVar.name} className="flex items-center gap-2" title={envVar.description}>
                      <span className="w-72 shrink-0 truncate font-mono text-[11px] text-neutral-300">
                        {envVar.name}
                      </span>
                      {value === undefined ? (
                        <button
                          onClick={() => setEdit(dotted, { value: '' })}
                          className="rounded-md border border-dashed border-edge/[0.14] px-2 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200 hover:border-edge/[0.3]"
                        >
                          {t('cfg.write')}
                        </button>
                      ) : (
                        <>
                          <input
                            value={String(value)}
                            onChange={(e) => setEdit(dotted, { value: e.target.value })}
                            className="flex-1 rounded-md bg-neutral-900 border border-edge/[0.08] px-2 py-0.5 font-mono text-[11px] text-neutral-200 focus:outline-none focus:border-mac-accent/50"
                          />
                          <button
                            onClick={() => setEdit(dotted, { remove: true })}
                            className="text-[11px] text-neutral-600 hover:text-red-300"
                          >
                            {t('cfg.clear')}
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      {view.backups.length > 0 && (
        <div className="flex items-center gap-2 text-[11px] text-neutral-600">
          <span>{t('cfg.backups', { count: view.backups.length })}</span>
          <button
            onClick={() => void profileAction({ action: 'restoreBackup', backupId: view.backups[0] })}
            className="rounded-md bg-neutral-800 px-2 py-0.5 text-neutral-300 hover:bg-neutral-700"
          >
            {t('cfg.restore')}
          </button>
        </div>
      )}

      {diffState && (
        <DiffDialog
          open
          title={diffState.title}
          beforeLabel={diffState.beforeLabel}
          afterLabel={diffState.afterLabel}
          before={diffState.before}
          after={diffState.after}
          onClose={() => setDiffState(null)}
          footer={
            <>
              <button
                onClick={() => setDiffState(null)}
                className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => {
                  diffState.onAccept();
                  setDiffState(null);
                }}
                className="rounded-lg bg-mac-accent px-3 py-1.5 text-xs text-white hover:opacity-90"
              >
                {t(diffState.acceptKey as MessageKey)}
              </button>
            </>
          }
        />
      )}
    </div>
  );
}
