import { useCallback, useEffect, useState } from 'react';
import { api, type ToolkitPack } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { AgentBadge } from '@/components/AgentBadge';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';
import { FolderOpen, Package, Trash2, TriangleAlert, Wrench } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { errorText, useActionFeedback } from '@/lib/action-feedback';

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
  'external-dir': 'toolkit.prov.external-dir',
  market: 'toolkit.prov.market',
};

/**
 * 工具箱区段（批 10，批 3 增旧副本警示）：包清单（provenance/类型徽标 + 目标面）
 * + 项目级开关（CC 原生包 = 全局安装 + 项目启用）+ 卸载按钮（与 harness 对齐：
 * CC/mod 走 claude plugin uninstall，表面包清扫文件）+ 项目插件位旧副本警示/清理 +
 * 外置目录展示（增删走 REST /toolkit/dirs，文案指引）。开关/卸载调用幂等端点，
 * 返回后置状态后刷新；行级 busy 防重入。pack 按成分分两组渲染（ccPack = Claude Plugins 组，
 * 其余 = 工具包组）；codex 运行态下 Claude 组整组隐藏。
 */
export function ToolkitSection({
  projectId,
  runtimeTab = 'all',
}: {
  projectId: number;
  runtimeTab?: 'claude' | 'codex' | 'all';
}) {
  const t = useT();
  const [packs, setPacks] = useState<ToolkitPack[] | null>(null);
  const [dirs, setDirs] = useState<string[]>([]);
  const [legacyCopies, setLegacyCopies] = useState<string[]>([]);
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
        setDirs(data.dirs);
        setLegacyCopies(data.legacyCopies ?? []);
      })
      .catch((e) => {
        setPacks((prev) => prev ?? []);
        show('error', t('toolkit.loadFailed', { error: errorText(e) }));
      });
  }, [projectId, t, show]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

  if (packs === null) {
    return <p className="text-xs text-neutral-600">{t('toolkit.loading')}</p>;
  }

  // 只分渲染组，不动数据：pack 列表仍单次拉取，toggle/清理逻辑共享同一份。
  const renderPack = (p: ToolkitPack) => {
    const isBusy = rowBusy(rowKey(p));
    return (
      <div
        key={`${p.provenance}:${p.sourceRoot}:${p.id}`}
        className="flex flex-wrap items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.015] px-2 py-1.5"
      >
        <Package
          className={cn('h-3.5 w-3.5 shrink-0', p.enabled ? 'text-emerald-400' : 'text-neutral-600')}
        />
        {/* 名称即注册键（name@marketplace，@后 = 所属市场 = 插件 namespace）——
            身份只此一处，不再另排 id / 键徽标造成三重重复。 */}
        <span
          className="shrink-0 text-xs font-medium text-neutral-200"
          title={
            p.key
              ? t('toolkit.keyTip', { scopes: p.scopes?.join('+') || t('toolkit.scopesNone') })
              : undefined
          }
        >
          {p.key ?? p.name}
        </span>
        {p.id !== p.name && (
          <span className="shrink-0 font-mono text-[10px] text-neutral-500">{p.id}</span>
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
        <span className="shrink-0 text-[10px] text-neutral-600">v{p.version}</span>
        <span className="shrink-0 text-[10px] text-neutral-600">
          {t('toolkit.targets', { targets: p.targets.join('+') })}
        </span>
        {p.weave && (
          <span className="shrink-0 text-[10px] text-neutral-600">
            {t('toolkit.weaveRules', { n: p.weave.ruleCount })}
          </span>
        )}
        {p.description && (
          <span className="min-w-0 truncate text-[11px] text-neutral-500" title={p.description}>
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
          <Switch
            checked={p.enabled}
            disabled={isBusy}
            onChange={(v) => void toggle(p, v)}
            title={t('toolkit.toggleTip')}
          />
        </span>
      </div>
    );
  };

  // 只显示非 weave 成分的 pack：weave 规则包（Markdown Lint 注入一类）由
  // Weave 分类的插件区唯一承载（SPI 扫描同一目录——两处展示=重复开关）。
  // mods 按 CC 插件管线安装（与 server isCcPluginPack 同口径）→ 归 Claude Plugins 组。
  const base = packs.filter((p) => !p.weavePack);
  const isCc = (p: ToolkitPack) => p.ccPack || p.kind === 'mod';
  const claudePacks = base.filter(isCc);
  const toolPacks = base.filter((p) => !isCc(p));
  const showClaudeGroup = runtimeTab !== 'codex' && claudePacks.length > 0;
  const showPacksGroup = toolPacks.length > 0;

  return (
    <div className="space-y-2">
      {/* 存量项目插件位旧副本（CC 不加载的死数据）警示 + 显式清理 */}
      {legacyCopies.length > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium text-amber-300">
              {t('toolkit.legacyTitle', { n: legacyCopies.length })}
            </p>
            <p className="truncate text-[10px] text-amber-200/60" title={legacyCopies.join('\n')}>
              {t('toolkit.legacyHint')}
            </p>
          </div>
          <button
            type="button"
            className="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 text-[10px] text-amber-200 hover:bg-amber-500/20"
            onClick={() => void cleanupLegacy()}
          >
            {t('toolkit.legacyCleanup')}
          </button>
        </div>
      )}

      {!showClaudeGroup && !showPacksGroup && (
        <p className="text-xs text-neutral-600">{t('toolkit.empty')}</p>
      )}

      {showClaudeGroup && (
        <div className="space-y-2">
          <p
            className="flex items-center gap-1.5 text-xs font-medium text-neutral-400"
            title={t('toolkit.claudeGroupHint')}
          >
            {t('toolkit.groupClaude')}
            <AgentBadge agent="claude" />
          </p>
          {claudePacks.map(renderPack)}
        </div>
      )}

      {showPacksGroup && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-neutral-400">{t('toolkit.groupPacks')}</p>
          {toolPacks.map(renderPack)}
        </div>
      )}


      {/* 外置目录：list 展示 + CLI 文案指引（编辑交互从简） */}
      <div className="rounded-md border border-white/[0.06] bg-white/[0.015] px-2 py-1.5">
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-neutral-300">
          <FolderOpen className="h-3.5 w-3.5 text-neutral-500" />
          {t('toolkit.dirsTitle')}
        </p>
        {dirs.length === 0 ? (
          <p className="mt-0.5 text-[10px] text-neutral-600">{t('toolkit.dirsEmpty')}</p>
        ) : (
          <ul className="mt-0.5 space-y-0.5">
            {dirs.map((d) => (
              <li key={d} className="truncate font-mono text-[10px] text-neutral-500" title={d}>
                {d}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 flex items-start gap-1 text-[10px] text-neutral-600">
          <Wrench className="mt-0.5 h-3 w-3 shrink-0" />
          {t('toolkit.dirsHint')}
        </p>
      </div>
    </div>
  );
}
