import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Harness } from '@weavecode/core/harness';
import type { EnableOverride } from '@weavecode/core/tool';
import { api, type ToolkitPack, type PluginRow, type AssetScope } from '@/lib/api';
import { cn } from '@/lib/utils';
import { registerInvalidator } from '@/lib/sse';
import { HARNESS_ORDER } from '@/lib/harness-meta';
import { Badge } from '@/components/ui/badge';
import { AgentBadge } from '@/components/AgentBadge';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FolderTree,
  Package,
  Power,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useToast } from '@/components/Toast';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import { groupByRepo, toggleIn } from '@/lib/repo-groups';
import { StatusPill, statusTone } from '@/components/ui/status-pill';

/** 导出给 LibraryPanel 插件包区复用（同一 kind 徽标语言）。 */
export const KIND_KEY: Record<ToolkitPack['kind'], MessageKey> = {
  skill: 'toolkit.kind.skill',
  hook: 'toolkit.kind.hook',
  mod: 'toolkit.kind.mod',
  rule: 'toolkit.kind.rule',
  surface: 'toolkit.kind.surface',
};

export const KIND_STYLES: Record<ToolkitPack['kind'], string> = {
  skill: 'bg-emerald-900/40 text-emerald-300',
  hook: 'bg-blue-900/40 text-blue-300',
  mod: 'bg-purple-900/40 text-purple-300',
  rule: 'bg-amber-900/40 text-amber-300',
  surface: 'bg-neutral-800 text-neutral-300',
};

const PROV_KEY: Record<ToolkitPack['provenance'], MessageKey> = {
  builtin: 'toolkit.prov.builtin',
  market: 'toolkit.prov.market',
};

/** user 档启停三态循环 inherit → on → off → inherit（与 McpGrid 同序）。 */
const NEXT_STATE: Record<EnableOverride, EnableOverride> = {
  inherit: 'on',
  on: 'off',
  off: 'inherit',
};

const STATE_LABEL: Record<
  EnableOverride,
  'toolkit.enableDefault' | 'toolkit.enableOn' | 'toolkit.enableOff'
> = {
  inherit: 'toolkit.enableDefault',
  on: 'toolkit.enableOn',
  off: 'toolkit.enableOff',
};

/** 包直接放在扫描根下（`scope` 为空）= 没有父级文件夹可作汇总单位 → 单列一块。 */
const SCOPE_ROOT_KEY = '__root__';

/** L2 折叠块：一个 scope 文件夹（扫描根的直接子目录 = 父级文件夹汇总单位）。 */
interface ScopeGroup {
  key: string;
  scope: string;
  packs: ToolkitPack[];
}

function groupByScope(packs: ToolkitPack[]): ScopeGroup[] {
  const byScope = new Map<string, ScopeGroup>();
  for (const p of packs) {
    const key = p.scope || SCOPE_ROOT_KEY;
    const entry = byScope.get(key) ?? { key, scope: p.scope, packs: [] };
    entry.packs.push(p);
    byScope.set(key, entry);
  }
  return [...byScope.values()];
}

/**
 * 工具包区段（批 10，批 3 增旧副本警示，仓库维度改批 6）：**以仓库 namespace 为一级**
 * 折叠块（与外层 Skills 同源），市场里的包文件夹为二级，包行为三级——不再按
 * 「Claude Plugins / 表面工具包」这种成分切法分堆（那种切法看不出包属于哪个市场）。
 * 形态与开关粒度不变：CC 原生包 + mods 走「全局安装 + 项目启用」的整包 Switch，
 * 其余按本项目落盘；行尾卸载按钮 + 热重载由 daemon 负责。运行态页签按包的
 * manifest targets 过滤（CC 包 targets=['claude']，codex 页签自然不见）。
 */
export function ToolkitSection({
  projectId,
  runtimeTab = 'all',
  scope = 'project',
}: {
  projectId: number;
  runtimeTab?: Harness | 'all';
  /** 视图落点（拍板 7-5）：project = 既有 toolkit 管线；user（全局配置区）=
   *  CC 落地包行改走 user 档安装 + user 档启停覆写，不借道锚点项目。 */
  scope?: AssetScope;
}) {
  const t = useT();
  const [packs, setPacks] = useState<ToolkitPack[] | null>(null);
  const [pluginRows, setPluginRows] = useState<PluginRow[]>([]);
  const [legacyCopies, setLegacyCopies] = useState<string[]>([]);
  // 折叠集记「折叠起来的」：默认全展开（包行本身就是可操作面，藏起来反而要点两下）。
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // 统一反馈：动作状态走 useActionFeedback（每行一个 key，toggle 与卸载共用一个 =
  // 行级防重入），消息一律走 toast——原先面板底部一行小字，滚走就看不见。
  const { show } = useToast();
  const fb = useActionFeedback();

  const rowKey = (p: ToolkitPack) => `${p.provenance}:${p.sourceRoot}:${p.id}`;
  const rowBusy = (key: string) => fb.stateOf(key) === 'loading';

  const refresh = useCallback(() => {
    api
      .listToolkit(projectId)
      .then((data) => {
        setPacks(data.packs);
        setLegacyCopies(data.legacyCopies ?? []);
      })
      .catch((e) => {
        setPacks((prev) => prev ?? []);
        show('error', t('toolkit.loadFailed', { error: errorText(e) }));
      });
    // user 档行 = 全局视图 CC 包行的启停状态源（项目视图不拉）。
    if (scope === 'user') {
      api.listPluginState(projectId).then(setPluginRows).catch(() => {});
    }
  }, [projectId, scope, t, show]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 任一客户端开了/卸了工具包后服务端推 invalidate('toolkit') → 重拉当前项目。
  // （本组件的开关回调仍会自己 refresh 一次，那是乐观路径；这条覆盖别的页签。）
  useEffect(() => registerInvalidator('toolkit', refresh), [refresh]);

  const toggle = async (pack: ToolkitPack, enabled: boolean): Promise<void> => {
    const key = rowKey(pack);
    if (rowBusy(key)) return;
    await fb.run(
      key,
      async () => {
        const result = await api.toggleToolkit(projectId, pack.id, enabled, pack.sourceRoot);
        if (result.warnings.length > 0) show('info', result.warnings.join('；'));
        refresh();
      },
      { fail: (e) => t('toolkit.toggleFailed', { error: errorText(e) }) },
    );
  };

  /** user 档安装（安装管理面，拍板 7-6 方案 A）：两步 CLI 较慢，行级三态反馈。 */
  const installUser = async (pack: ToolkitPack): Promise<void> => {
    const key = rowKey(pack);
    if (rowBusy(key)) return;
    await fb.run(
      key,
      async () => {
        const res = await api.install(projectId, {
          category: 'plugin',
          name: pack.name,
          sourceDir: pack.dir,
          version: pack.version,
          description: pack.description,
          scope: 'user',
          agent: 'claude',
        });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        refresh();
        show('success', t('toolkit.userInstalled', { key: pack.key ?? pack.name }));
      },
      { fail: (e) => t('toolkit.installFailed', { error: errorText(e) }) },
    );
  };

  /** user 档启停覆写循环（inherit → on → off）：状态源 = 服务端行的 enable。 */
  const cycleUserEnable = async (pack: ToolkitPack, next: EnableOverride): Promise<void> => {
    const key = rowKey(pack);
    if (rowBusy(key)) return;
    await fb.run(
      key,
      async () => {
        await api.putPluginState(projectId, 'claude', pack.key!, 'user', next);
        refresh();
      },
      { fail: (e) => t('toolkit.toggleFailed', { error: errorText(e) }) },
    );
  };

  /** 卸载：与 harness 对齐（CC/mod = claude plugin uninstall；表面包清扫文件）。 */
  const uninstall = async (pack: ToolkitPack): Promise<void> => {
    const key = rowKey(pack);
    if (rowBusy(key)) return;
    await fb.run(
      key,
      async () => {
        const result = await api.uninstallToolkit(projectId, pack.id, pack.sourceRoot);
        if (result.warnings.length > 0) show('info', result.warnings.join('；'));
        refresh();
        show('success', t('toolkit.uninstalled', { name: pack.name }));
      },
      { fail: (e) => t('toolkit.uninstallFailed', { error: errorText(e) }) },
    );
  };

  const cleanupLegacy = async (): Promise<void> => {
    await fb.run(
      'legacy-cleanup',
      async () => {
        await api.cleanupToolkitLegacyCopies(projectId);
        refresh();
        show('success', t('toolkit.legacyCleaned'));
      },
      { fail: (e) => t('toolkit.toggleFailed', { error: errorText(e) }) },
    );
  };

  // 只分渲染组，不动数据：pack 列表仍单次拉取，toggle/清理逻辑共享同一份。
  // 可见性按 manifest targets 数据行驱动（§6-4 收编）：CC 原生包与 mods 的
  // targets = ['claude']，codex 运行态自然隐藏。
  const visible = useMemo(() => {
    if (!packs) return [];
    return packs.filter(
      (p) => !p.weavePack && (runtimeTab === 'all' || p.targets.includes(runtimeTab)),
    );
  }, [packs, runtimeTab]);

  const repos = useMemo(() => groupByRepo(visible), [visible]);
  /** 每个仓的二级块；仓内包全部直接落在扫描根下 → 没有父级文件夹可当汇总单位，
   *  直接铺包行（免套一层同名空壳）。 */
  const scopesOf = (repo: (typeof repos)[number]) => groupByScope(repo.groups);
  const isFlat = (repo: (typeof repos)[number]) => {
    const scopes = scopesOf(repo);
    return scopes.length === 1 && scopes[0]!.key === SCOPE_ROOT_KEY;
  };
  const allFoldKeys = repos.flatMap((r) => [
    r.key,
    ...(isFlat(r) ? [] : scopesOf(r).map((s) => `${r.key}:${s.key}`)),
  ]);
  const anyExpanded = collapsed.size === 0;

  /** 默认全折叠：数据到达时把各级 key 一次性铺满折叠集；用户自己动过之后不再自动铺。 */
  const userTouchedFold = useRef(false);
  useEffect(() => {
    if (userTouchedFold.current || allFoldKeys.length === 0) return;
    setCollapsed(new Set(allFoldKeys));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 以 join 串做指纹，避免数组新引用每渲染都触发
  }, [allFoldKeys.join('|')]);
  const toggleFold = (key: string): void => {
    userTouchedFold.current = true;
    setCollapsed((prev) => toggleIn(prev, key));
  };

  if (packs === null) {
    return <p className="text-xs text-neutral-600">{t('toolkit.loading')}</p>;
  }

  const renderPack = (p: ToolkitPack) => {
    const isBusy = rowBusy(rowKey(p));
    // user 视图（全局配置区）的 CC 落地包（行带注册键）：改走 user 档安装 +
    // user 档启停覆写（拍板 7-5/7-6）；表面/weave 包无插件安装档语义，维持原管线。
    const userManaged = scope === 'user' && !!p.key;
    const userRow = userManaged
      ? pluginRows.find((r) => r.harness === 'claude' && r.key === p.key && r.scope === 'user')
      : undefined;
    const userState: EnableOverride = userRow?.enable ?? 'inherit';
    const active = userManaged ? (userRow?.effective ?? false) : p.enabled;
    return (
      <div
        key={`${p.provenance}:${p.sourceRoot}:${p.id}`}
        className="flex flex-wrap items-center gap-2 rounded-md border border-edge/[0.06] bg-edge/[0.015] px-2 py-1.5"
      >
        <Package
          className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-emerald-400' : 'text-neutral-600')}
        />
        {/* 名称即注册键（name@marketplace，@后 = 所属市场 = 插件 namespace）——
            身份只此一处，不再另排 id / 键徽标造成三重重复。 */}
        <span
          className="min-w-0 max-w-full truncate text-xs font-medium text-neutral-200"
          title={
            p.key
              ? t('toolkit.keyTip', { scopes: p.scopes?.join('+') || t('toolkit.scopesNone') })
              : undefined
          }
        >
          {p.key ?? p.name}
        </span>
        {p.id !== p.name && (
          <span className="shrink-0 font-mono text-10 text-neutral-500">{p.id}</span>
        )}
        <Badge className={cn('shrink-0', KIND_STYLES[p.kind])}>{t(KIND_KEY[p.kind])}</Badge>
        <Badge
          className={cn(
            'shrink-0',
            p.provenance === 'builtin'
              ? 'bg-amber-900/40 text-amber-300'
              : 'bg-neutral-800 text-neutral-300',
          )}
        >
          {t(PROV_KEY[p.provenance])}
        </Badge>
        <span className="shrink-0 text-10 text-neutral-600">v{p.version}</span>
        <span className="shrink-0 text-10 text-neutral-600">
          {t('toolkit.targets', { targets: p.targets.join('+') })}
        </span>
        {p.weave && (
          <span className="shrink-0 text-10 text-neutral-600">
            {t('toolkit.weaveRules', { n: p.weave.ruleCount })}
          </span>
        )}
        {p.description && (
          <span className="min-w-0 truncate text-11 text-neutral-500" title={p.description}>
            {p.description}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            title={t('toolkit.uninstallTip')}
            disabled={isBusy}
            onClick={() => void uninstall(p)}
            className="rounded p-1 text-neutral-500 hover:bg-red-950/40 hover:text-red-300 disabled:opacity-40 [&_svg]:pointer-events-none"
          >
            <FeedbackIcon
              state={fb.stateOf(rowKey(p))}
              className="h-3.5 w-3.5"
              icon={<Trash2 className="h-3.5 w-3.5" />}
            />
          </button>
          {userManaged ? (
            p.installed ? (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void cycleUserEnable(p, NEXT_STATE[userState])}
                title={t('toolkit.enableTip', { state: t(STATE_LABEL[userState]) })}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-10 font-medium disabled:cursor-not-allowed [&_svg]:pointer-events-none',
                  userState === 'on'
                    ? 'bg-emerald-900/40 text-emerald-300 hover:bg-emerald-900/60'
                    : 'bg-neutral-800 text-neutral-500 hover:bg-neutral-700',
                )}
              >
                <FeedbackIcon
                  state={fb.stateOf(rowKey(p))}
                  className="h-3 w-3"
                  icon={<Power className="h-3 w-3" />}
                />
                {t(STATE_LABEL[userState])}
              </button>
            ) : (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void installUser(p)}
                title={t('toolkit.installTip')}
                className="rounded bg-blue-900/50 px-2 py-0.5 text-10 text-blue-200 hover:bg-blue-800/60 disabled:opacity-40"
              >
                {isBusy ? t('toolkit.installing') : t('toolkit.install')}
              </button>
            )
          ) : (
            <Switch
              checked={p.enabled}
              disabled={isBusy}
              onChange={(v) => void toggle(p, v)}
              title={t('toolkit.toggleTip')}
            />
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="space-y-2">
      {/* 存量项目插件位旧副本（CC 不加载的死数据）警示 + 显式清理 */}
      {legacyCopies.length > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-11 font-medium text-amber-300">
              {t('toolkit.legacyTitle', { n: legacyCopies.length })}
            </p>
            <p className="truncate text-10 text-amber-200/60" title={legacyCopies.join('\n')}>
              {t('toolkit.legacyHint')}
            </p>
          </div>
          <button
            type="button"
            className="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 text-10 text-amber-200 hover:bg-amber-500/20"
            onClick={() => void cleanupLegacy()}
          >
            {t('toolkit.legacyCleanup')}
          </button>
        </div>
      )}

      {visible.length === 0 && <p className="text-xs text-neutral-600">{t('toolkit.empty')}</p>}

      {visible.length > 0 && (
        <div className="flex items-center gap-1">
          <span className="text-11 text-neutral-500">{t('toolkit.hint')}</span>
          <button
            type="button"
            onClick={() => {
              userTouchedFold.current = true;
              setCollapsed(anyExpanded ? new Set(allFoldKeys) : new Set());
            }}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-neutral-800 text-neutral-400 px-1.5 py-0.5 text-10 hover:bg-neutral-700"
            title={anyExpanded ? t('toolkit.collapseAllGroups') : t('toolkit.expandAllGroups')}
          >
            {anyExpanded ? (
              <ChevronsDownUp className="h-3 w-3" />
            ) : (
              <ChevronsUpDown className="h-3 w-3" />
            )}
            {anyExpanded ? t('toolkit.collapseAll') : t('toolkit.expandAll')}
          </button>
        </div>
      )}

      {repos.map((repo) => {
        const isLocal = repo.namespace === undefined;
        const repoCollapsed = collapsed.has(repo.key);
        const packCount = repo.groups.length;
        const allBuiltin = repo.groups.every((p) => p.provenance === 'builtin');
        return (
          <div
            key={repo.key}
            className="rounded-2xl border border-edge/[0.08] bg-neutral-900/60 overflow-hidden"
          >
            <div
              role="button"
              tabIndex={0}
              onClick={() => toggleFold(repo.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setCollapsed((prev) => toggleIn(prev, repo.key));
                }
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-edge/[0.03] cursor-pointer max-lg:flex-wrap"
            >
              {repoCollapsed ? (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
              )}
              <Package className="h-3.5 w-3.5 shrink-0 text-violet-400" />
              {/* 一级 = 仓库 namespace：市场名原样显示，无市场归属的包（裸插件/
                  手加目录）并成一块「本地」——否则整页分不清包属于哪个市场。 */}
              <span className="text-xs font-semibold text-neutral-200 truncate">
                {isLocal ? t('repo.local') : repo.namespace}
              </span>
              {allBuiltin && <Badge className="bg-amber-900/40 text-amber-300">{t('toolkit.prov.builtin')}</Badge>}
              {/* 折叠条总结 tag：数量 + 启用状态数量（类型由包行徽标体现） */}
              <StatusPill
                tone={statusTone(
                  repo.groups.filter((p) => p.enabled).length,
                  repo.groups.length,
                )}
              >
                {t('repo.enabledCount', {
                  done: repo.groups.filter((p) => p.enabled).length,
                  total: repo.groups.length,
                })}
              </StatusPill>
              <span className="shrink-0 text-10 text-neutral-600" title={t('repo.namespaceTip')}>
                {t('repo.packCount', { n: packCount })}
              </span>
            </div>
            {!repoCollapsed && (
              <div className="px-3 pb-3 pt-1 space-y-2">
                {isFlat(repo) ? (
                  <div className="space-y-1.5">{repo.groups.map(renderPack)}</div>
                ) : (
                  scopesOf(repo).map((scope) => {
                    const scopeKey = `${repo.key}:${scope.key}`;
                    const scopeCollapsed = collapsed.has(scopeKey);
                    return (
                      <div
                        key={scopeKey}
                        className="rounded-xl border border-edge/[0.06] bg-neutral-900/40 overflow-hidden"
                      >
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => toggleFold(scopeKey)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setCollapsed((prev) => toggleIn(prev, scopeKey));
                            }
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-edge/[0.02] cursor-pointer max-lg:flex-wrap"
                        >
                          {scopeCollapsed ? (
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                          )}
                          <FolderTree className="h-3.5 w-3.5 shrink-0 text-blue-400" />
                          {/* 二级 = 市场里的包文件夹（父级文件夹作汇总单位） */}
                          <span className="text-xs font-semibold text-neutral-300 truncate">
                            {scope.key === SCOPE_ROOT_KEY ? t('toolkit.scopeRoot') : scope.scope}
                          </span>
                          <Badge variant="skill">{scope.packs.length}</Badge>
                          {/* 汇总单位的 harness 面 = 各包 targets 并集（§6-4 收编） */}
                          {[...new Set(scope.packs.flatMap((p) => p.targets))]
                            .sort((a, b) => HARNESS_ORDER.indexOf(a) - HARNESS_ORDER.indexOf(b))
                            .map((h) => (
                              <AgentBadge key={h} agent={h} />
                            ))}
                        </div>
                        {!scopeCollapsed && (
                          <div className="px-3 pb-3 pt-1 space-y-1.5">
                            {scope.packs.map(renderPack)}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
