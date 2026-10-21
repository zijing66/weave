import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { FileWarning, RefreshCw } from 'lucide-react';
import { parse as parseToml } from 'smol-toml';
import {
  api,
  type ConfigCatalogResponse,
  type ConfigEnvVarSpec,
  type ConfigFileId,
  type ConfigUpdate,
  type ConfigView,
} from '@/lib/api';
import type { Harness } from '@weavecode/core/harness';
import { HARNESS_ORDER, harnessUiOf } from '@/lib/harness-meta';
import {
  buildConfigTree,
  matchesQuery,
  pruneTree,
  treeHasValue,
  valueAt,
  valueOfText,
  type ConfigTreeNode,
  type TreeNodeSpec,
} from '@/lib/config-form';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';
import { ConfigTree, type ConfigTreeHandlers } from './ConfigTree';
import { Combobox } from '@/components/ui/combobox';
import type { RowEdit } from './ConfigValueRow';
import { ConfigProfiles } from './ConfigProfiles';
import { ConfigModelCard } from './ConfigModelCard';
import { DiffDialog } from './DiffDialog';

const FILE_LABEL: Record<ConfigFileId, MessageKey> = {
  user: 'cfg.file.user',
  project: 'cfg.file.project',
  projectLocal: 'cfg.file.projectLocal',
  global: 'cfg.file.global',
};

type Filter = 'set' | 'all' | 'unset';

/** env 变量的文档类型 → 表单类型串（控件种类由 controlOf 从类型串推）。 */
const ENV_TYPE: Record<ConfigEnvVarSpec['kind'], string> = {
  string: 'string',
  boolean: 'Boolean',
  number: 'number',
  list: 'array of strings',
  enum: 'enum',
  path: 'string',
};

const FILTERS: { key: Filter; label: MessageKey }[] = [
  { key: 'set', label: 'cfg.setOnly' },
  { key: 'all', label: 'cfg.all' },
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
  // 默认只看已配置的（文件里真有 key 的）；「全部」才把词表里没配的键亮出来
  const [filter, setFilter] = useState<Filter>('set');
  /** 每个对象节点的展/收（没记过就看默认：里面有已配置的值就展开）。 */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
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

  useEffect(() => {
    setRawMode(false);
    setExpanded({});
  }, [file, target]);

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

  const lockedEntriesOf = useCallback(
    (dotted: string): readonly string[] =>
      (view?.managedEntries ?? []).filter((e) => e.path === dotted).map((e) => e.entry),
    [view],
  );

  const setEdit = (dotted: string, edit: RowEdit): void => {
    setEdits((prev) => ({ ...prev, [dotted]: edit }));
  };

  const pendingCount = Object.keys(edits).length;

  // raw 视图的即时校验：语言随活文件（claude=JSON / codex=TOML），空文本 = 清空不算错
  const rawInvalid = useMemo(() => {
    const trimmed = rawText.trim();
    if (!trimmed) return false;
    if (catalog?.rawFormat === 'toml') {
      try {
        parseToml(trimmed);
        return false;
      } catch {
        return true;
      }
    }
    return valueOfText(rawText).error === 'invalidJson';
  }, [catalog?.rawFormat, rawText]);

  const save = async (): Promise<void> => {
    if (pendingCount === 0 || !catalog) return;
    const updates: ConfigUpdate[] = Object.entries(edits).map(([path, edit]) =>
      edit.remove || edit.value === undefined ? { path, remove: true } : { path, value: edit.value },
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

  // env 块在树上就是 `env` 这个对象：孩子 = 已设置的那些变量，搜索时再补文档里命中的
  const envSpecs = useMemo<TreeNodeSpec[]>(() => {
    // supported:false 的响应只有这一个字段（server 对无 config 槽的 harness 不带 envVars）
    if (!catalog || !catalog.supported || filter === 'unset') return [];
    const env = valueAt(values, 'env');
    const names = new Set(
      typeof env === 'object' && env !== null && !Array.isArray(env) ? Object.keys(env) : [],
    );
    for (const [path, edit] of Object.entries(edits)) {
      if (!path.startsWith('env.')) continue;
      const name = path.slice(4);
      if (edit.remove) names.delete(name);
      else names.add(name);
    }
    if (query.trim()) {
      let added = 0;
      for (const envVar of catalog.envVars) {
        if (added >= 50) break;
        if (names.has(envVar.name) || !matchesQuery(envVar.name, envVar.description, query)) continue;
        names.add(envVar.name);
        added += 1;
      }
    }
    const byName = new Map(catalog.envVars.map((v) => [v.name, v]));
    return [...names].map((name) => {
      const spec = byName.get(name);
      return {
        key: `env.${name}`,
        group: 'Environment',
        type: ENV_TYPE[spec?.kind ?? 'string'] ?? 'string',
        options: spec?.options,
        description: spec?.description ?? '',
      };
    });
  }, [catalog, edits, filter, query, values]);

  const tree = useMemo(() => {
    if (!catalog || !catalog.supported) {
      return { nodes: [] as ConfigTreeNode[], byPath: new Map<string, ConfigTreeNode>() };
    }
    const nodes = buildConfigTree([...catalog.keys, ...envSpecs], values);
    const byPath = new Map<string, ConfigTreeNode>();
    const walk = (list: readonly ConfigTreeNode[]): void => {
      for (const node of list) {
        byPath.set(node.path, node);
        walk(node.children);
      }
    };
    walk(nodes);
    const q = query.trim();
    const kept = pruneTree(nodes, (node) => {
      if (node.extra) return filter !== 'unset' && matchesQuery(node.path, '', q);
      if (!node.spec) return false;
      const set = currentValue(node.path) !== undefined;
      if (filter === 'set' && !set) return false;
      if (filter === 'unset' && set) return false;
      return matchesQuery(node.path, node.spec.description, q);
    });
    return { nodes: kept, byPath };
  }, [catalog, currentValue, envSpecs, filter, query, values]);

  const treeHandlers: ConfigTreeHandlers = {
    isOpen: (node) => {
      if (query.trim() !== '' || filter !== 'all') return true;
      const flag = expanded[node.path];
      if (flag !== undefined) return flag;
      return treeHasValue(node, (path) => currentValue(path) !== undefined);
    },
    onToggle: (path) => {
      const node = tree.byPath.get(path);
      const open = node ? treeHandlers.isOpen(node) : false;
      setExpanded((prev) => ({ ...prev, [path]: !open }));
    },
    hasValue: (path) => currentValue(path) !== undefined,
    isManaged,
    lockedEntriesOf,
    valueOf: currentValue,
    onChange: setEdit,
  };

  /** env 节点底下那行：文档里的变量名当候选（能搜），也允许自己敲一个。 */
  const envFooter = (node: ConfigTreeNode, depth: number): ReactNode =>
    node.path !== 'env' || !catalog ? null : (
      <EnvVarPicker
        depth={depth}
        envVars={catalog.envVars}
        exists={(name) => currentValue(`env.${name}`) !== undefined}
        onAdd={(name) => setEdit(`env.${name}`, { value: '' })}
      />
    );

  const setAllOpen = (open: boolean): void => {
    const next: Record<string, boolean> = {};
    for (const node of tree.byPath.values()) if (node.children.length > 0) next[node.path] = open;
    setExpanded(next);
  };

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

  // 项目的这一页只管项目自己的两份；用户级与全局键只在全局页里出现
  const inProject = projectId != null;
  const files = catalog.files.filter((f) =>
    inProject ? f.id === 'project' || f.id === 'projectLocal' : f.id === 'user' || f.id === 'global',
  );

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

      {/* 该档词表里有 model 键才摆模型卡（global 档写不进去 model） */}
      {catalog.keys.some((k) => k.key === 'model') && (
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
          configuredCredential={(() => {
            const env = valueAt(values, 'env');
            const read = (name: string): string => {
              const got = typeof env === 'object' && env !== null ? valueAt(env as Record<string, unknown>, name) : '';
              return typeof got === 'string' ? got.trim() : '';
            };
            return read('ANTHROPIC_API_KEY') !== '' || read('ANTHROPIC_AUTH_TOKEN') !== '';
          })()}
          onApply={(modelId) => setEdit('model', { value: modelId })}
        />
      )}

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
          onClick={() => setAllOpen(true)}
          className="rounded-md px-2 py-1 text-[11px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
        >
          {t('cfg.expandAll')}
        </button>
        <button
          onClick={() => setAllOpen(false)}
          className="rounded-md px-2 py-1 text-[11px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
        >
          {t('cfg.collapseAll')}
        </button>
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
            {rawInvalid && (
              <span className="text-[11px] text-red-400">
                {catalog?.rawFormat === 'toml' ? t('cfg.invalidToml') : t('cfg.invalidJson')}
              </span>
            )}
          </div>
        </div>
      ) : (
        <>
          {tree.nodes.length === 0 && <p className="text-[11px] text-neutral-500">{t('cfg.empty')}</p>}
          {tree.nodes.length > 0 && (
            <section className="rounded-xl border border-edge/[0.06] bg-neutral-900/40 p-1.5">
              <ConfigTree nodes={tree.nodes} handlers={treeHandlers} footer={envFooter} />
            </section>
          )}
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

/**
 * env 底下「加一个变量」：候选是文档里的变量名（可搜），也允许自己敲一个——
 * 值先进 edits 再照常保存。
 */
function EnvVarPicker({
  depth,
  envVars,
  exists,
  onAdd,
}: {
  depth: number;
  envVars: readonly ConfigEnvVarSpec[];
  exists: (name: string) => boolean;
  onAdd: (name: string) => void;
}) {
  const t = useT();
  const [picked, setPicked] = useState('');
  const spec = envVars.find((v) => v.name === picked);
  const canAdd = picked !== '' && !exists(picked);
  const add = (): void => {
    if (!canAdd) return;
    onAdd(picked);
    setPicked('');
  };
  return (
    <div style={{ paddingLeft: depth * 14 }} className="flex items-start gap-1.5 rounded-md px-1.5 py-1">
      {/* 391 个候选走统一 Combobox（虚拟滚动 + 可搜）；词表是建议不是白名单，creatable 兜自由输入 */}
      <Combobox
        value={picked}
        options={envVars.map((v) => ({ value: v.name, hint: v.description }))}
        onChange={setPicked}
        placeholder={t('cfg.addEnvVar')}
        searchPlaceholder={t('cfg.search')}
        creatable
        className="w-[38%] shrink-0 font-mono text-[11px]"
      />
      <div className="min-w-0 flex-1">
        {spec && <p className="truncate text-[11px] text-neutral-500">{spec.description}</p>}
        {!spec && picked !== '' && exists(picked) && (
          <p className="text-[11px] text-neutral-600">{t('cfg.alreadySet')}</p>
        )}
      </div>
      <button
        disabled={!canAdd}
        onClick={add}
        className="shrink-0 rounded-md border border-dashed border-edge/[0.14] px-2 py-0.5 text-[11px] text-neutral-400 hover:border-edge/[0.3] hover:text-neutral-200 disabled:opacity-40"
      >
        {t('cfg.write')}
      </button>
    </div>
  );
}
