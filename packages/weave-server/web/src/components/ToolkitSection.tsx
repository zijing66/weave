import { useCallback, useEffect, useState } from 'react';
import { api, type ToolkitPack } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { AgentBadge } from '@/components/AgentBadge';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';
import { FolderOpen, Package, TriangleAlert, Wrench } from 'lucide-react';

const KIND_KEY: Record<ToolkitPack['kind'], MessageKey> = {
  skill: 'toolkit.kind.skill',
  hook: 'toolkit.kind.hook',
  mod: 'toolkit.kind.mod',
  rule: 'toolkit.kind.rule',
  surface: 'toolkit.kind.surface',
};

const KIND_STYLES: Record<ToolkitPack['kind'], string> = {
  skill: 'bg-emerald-900/40 text-emerald-300',
  hook: 'bg-blue-900/40 text-blue-300',
  mod: 'bg-purple-900/40 text-purple-300',
  rule: 'bg-amber-900/40 text-amber-300',
  surface: 'bg-neutral-800 text-neutral-300',
};

const PROV_KEY: Record<ToolkitPack['provenance'], MessageKey> = {
  builtin: 'toolkit.prov.builtin',
  'external-dir': 'toolkit.prov.external-dir',
};

/**
 * 工具箱区段（批 10，批 3 增旧副本警示）：包清单（provenance/类型徽标 + 目标面）
 * + 项目级开关（CC 原生包 = 全局安装 + 项目启用）+ 项目插件位旧副本警示/清理 +
 * 外置目录展示（add-dir/remove-dir 走 CLI，文案指引）。开关调用幂等端点，
 * 返回后置状态后刷新。pack 按成分分两组渲染（ccPack = Claude Plugins 组，
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
  const [msg, setMsg] = useState<string | null>(null);

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
        setMsg(t('toolkit.loadFailed', { error: e instanceof Error ? e.message : String(e) }));
      });
  }, [projectId, t]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggle = async (pack: ToolkitPack, enabled: boolean): Promise<void> => {
    setMsg(null);
    try {
      const result = await api.toggleToolkit(projectId, pack.id, enabled, pack.sourceRoot);
      if (result.warnings.length > 0) setMsg(result.warnings.join('；'));
      refresh();
    } catch (e) {
      setMsg(t('toolkit.toggleFailed', { error: e instanceof Error ? e.message : String(e) }));
      refresh();
    }
  };

  const cleanupLegacy = async (): Promise<void> => {
    setMsg(null);
    try {
      await api.cleanupToolkitLegacyCopies(projectId);
      refresh();
    } catch (e) {
      setMsg(t('toolkit.toggleFailed', { error: e instanceof Error ? e.message : String(e) }));
      refresh();
    }
  };

  if (packs === null) {
    return <p className="text-xs text-neutral-600">{t('toolkit.loading')}</p>;
  }

  // 只分渲染组，不动数据：pack 列表仍单次拉取，toggle/清理逻辑共享同一份。
  const renderPack = (p: ToolkitPack) => (
    <div
      key={`${p.provenance}:${p.sourceRoot}:${p.id}`}
      className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.015] px-2 py-1.5"
    >
      <Package
        className={cn('h-3.5 w-3.5 shrink-0', p.enabled ? 'text-emerald-400' : 'text-neutral-600')}
      />
      <span className="shrink-0 text-xs font-medium text-neutral-200">{p.name}</span>
      <span className="shrink-0 font-mono text-[10px] text-neutral-500">{p.id}</span>
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
      <span className="ml-auto shrink-0">
        <Switch
          checked={p.enabled}
          onChange={(v) => void toggle(p, v)}
          title={t('toolkit.toggleTip')}
        />
      </span>
    </div>
  );

  // 只显示非 weave 成分的 pack：weave 规则包（Markdown Lint 注入一类）由
  // Weave 分类的插件区唯一承载（SPI 扫描同一目录——两处展示=重复开关）。
  const base = packs.filter((p) => !p.weavePack);
  const claudePacks = base.filter((p) => p.ccPack);
  const toolPacks = base.filter((p) => !p.ccPack);
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

      {msg && <p className="text-[11px] text-amber-400/90">{msg}</p>}

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
