import { useMemo, useState } from 'react';
import {
  type AssetAgent,
  type AssetEntry,
  type AssetScope,
  type FileAssetCategory,
  type FileAssetUpdate,
} from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { AgentBadge } from '@/components/AgentBadge';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FileCode,
  FileSymlink,
  FileText,
  Folder,
  Trash2,
} from 'lucide-react';

/** Row model for one installed single-file asset (also the uninstall payload). */
export interface FileAssetRow {
  name: string;
  category: FileAssetCategory;
  relPath: string;
  /** Which runtime surface the file lives on (`.codex/…` paths). */
  agent?: AssetAgent;
}

/** 抽象工具大类（筛选概念）：chips 与行 tag 只暴露 harness 工具的抽象概念，
 *  绠向细节（helper 就是 hook 脚本、workflow 并入 rules 等）折叠进大类。
 *  skill/mcp 是 tab 专属维度，不进 chips（tab 已管）。 */
const BUCKET_ORDER = [
  'instructions',
  'command',
  'agent',
  'hooks',
  'rules',
  'style',
  'settings',
  'other',
] as const;

/** tab 专属类别：不参与大类 chips/计数（Skills|MCP tab 各自过滤）。 */
const TAB_KINDS = new Set(['skill', 'mcp']);

/** 原始扫描 category（+路径细判）→ 抽象大类；未知未来类目归 other。 */
function bucketOf(category: string, relPath: string): string {
  switch (category) {
    case 'helper':
      return 'hooks'; // .claude/helpers/ = hook 处理脚本
    case 'rule':
    case 'workflow':
      return 'rules';
    case 'output-style':
      return 'style';
    case 'instructions':
    case 'command':
    case 'agent':
    case 'settings':
      return category;
    default:
      break;
  }
  if (TAB_KINDS.has(category)) return category;
  if (relPath.startsWith('.claude/hooks/')) return 'hooks';
  return 'other';
}

/* One colour family per bucket, expressed in TEXT COLOUR ONLY: both the
 * filter chips and the row tags keep the same grey background, so the hue is
 * what distinguishes buckets. Selected chips additionally get a highlight ring.
 * (Tailwind needs literal class strings, hence no template.) */
const KIND_COLORS: Record<string, { on: string; off: string }> = {
  instructions: {
    on: 'text-teal-200',
    off: 'text-teal-300/50 hover:text-teal-200',
  },
  command: { on: 'text-purple-200', off: 'text-purple-300/50 hover:text-purple-200' },
  agent: { on: 'text-emerald-200', off: 'text-emerald-300/50 hover:text-emerald-200' },
  hooks: { on: 'text-amber-200', off: 'text-amber-300/50 hover:text-amber-200' },
  rules: { on: 'text-rose-200', off: 'text-rose-300/50 hover:text-rose-200' },
  style: { on: 'text-fuchsia-200', off: 'text-fuchsia-300/50 hover:text-fuchsia-200' },
  settings: { on: 'text-cyan-200', off: 'text-cyan-300/50 hover:text-cyan-200' },
  other: { on: 'text-neutral-200', off: 'text-neutral-400/70 hover:text-neutral-200' },
  // tab 专属类别只做行 tag 配色（chips 不列）
  skill: { on: 'text-lime-200', off: 'text-lime-300/50 hover:text-lime-200' },
  mcp: { on: 'text-sky-200', off: 'text-sky-300/50 hover:text-sky-200' },
};

/** Palette for a kind — unknown future kinds fall back to neutral. */
const kindColor = (kind: string) => KIND_COLORS[kind] ?? KIND_COLORS.other;

/* The 全部 chip is an action, not a kind — primary-blue text on the same
 * grey background as every other chip. */
const ALL_ON = 'text-blue-200';
const ALL_OFF = 'text-neutral-400 hover:text-neutral-300';

/** Grey chip shell — identical for every chip; only the text colour varies. */
const CHIP_BASE =
  'inline-flex items-center gap-1.5 rounded-full border border-transparent bg-neutral-800/60 px-2 py-0.5 text-[11px] font-medium transition-colors duration-150 hover:bg-neutral-700/60';

/** Highlight for a chip in the filtered (selected) state. */
const CHIP_ACTIVE_HL = 'bg-neutral-700 ring-1 ring-blue-500/50 hover:bg-neutral-700';

/** Shared grey tag shell for rows — same background as the filter chips. */
const ROW_TAG_BASE =
  'shrink-0 rounded-full border border-transparent bg-neutral-800/60 px-1.5 py-0 text-[10px] font-medium font-sans';

/** Kinds the daemon's uninstall route accepts in a project
 * (mirrors isFileAssetCategory). */
const UNINSTALLABLE = new Set([
  'command',
  'agent',
  'workflow',
  'rule',
  'output-style',
]);

/** Global (user-level) uninstall needs a `userDir` in FILE_ASSET_SPECS —
 * workflow and rule are project-scoped only, and Codex has no such surface. */
const GLOBAL_UNINSTALLABLE = new Set(['command', 'agent', 'output-style']);

type FileNode = { type: 'file'; asset: AssetEntry };
type DirNode = { type: 'dir'; name: string; path: string; children: TreeNode[] };
type TreeNode = FileNode | DirNode;

function lastSegment(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? relPath : relPath.slice(i + 1);
}

function fileStem(relPath: string): string {
  return lastSegment(relPath).replace(/\.(md|js)$/u, '');
}

/** Build a sorted tree from flat asset paths. Directories come before files
 * at every level, both alphabetically — the whole project surface (.claude/,
 * .codex/, root instruction files …) in one hierarchy. */
function buildTree(assets: AssetEntry[]): TreeNode[] {
  const root: DirNode = { type: 'dir', name: '', path: '', children: [] };
  for (const asset of assets) {
    const parts = asset.relPath.split('/');
    let node = root;
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      acc = acc ? `${acc}/${part}` : part;
      if (i === parts.length - 1) {
        node.children.push({ type: 'file', asset });
      } else {
        let dir = node.children.find((c): c is DirNode => c.type === 'dir' && c.name === part);
        if (!dir) {
          dir = { type: 'dir', name: part, path: acc, children: [] };
          node.children.push(dir);
        }
        node = dir;
      }
    }
  }
  const sort = (dir: DirNode) => {
    dir.children.sort((a, b) => {
      const aDir = a.type === 'dir';
      const bDir = b.type === 'dir';
      if (aDir !== bDir) return aDir ? -1 : 1;
      const aName = a.type === 'file' ? lastSegment(a.asset.relPath) : a.name;
      const bName = b.type === 'file' ? lastSegment(b.asset.relPath) : b.name;
      return aName.localeCompare(bName);
    });
    dir.children.forEach((c) => {
      if (c.type === 'dir') sort(c);
    });
  };
  sort(root);
  return root.children;
}

/** Files under a directory, recursively — shown as a dim count on dir rows. */
function countFiles(node: DirNode): number {
  let n = 0;
  for (const c of node.children) n += c.type === 'file' ? 1 : countFiles(c);
  return n;
}

function KindChip({
  kind,
  active,
  onClick,
  children,
}: {
  /** Asset kind — undefined for the 全部 chip (primary-blue action). */
  kind?: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const text = kind ? kindColor(kind) : { on: ALL_ON, off: ALL_OFF };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(CHIP_BASE, active && CHIP_ACTIVE_HL, active ? text.on : text.off)}
    >
      {children}
    </button>
  );
}

function AssetTreeNode({
  node,
  depth,
  scope,
  updates,
  collapsed,
  onToggle,
  onOpenFile,
  onUninstall,
}: {
  node: TreeNode;
  depth: number;
  scope: AssetScope;
  updates?: FileAssetUpdate[];
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (relPath: string) => void;
  onUninstall: (row: FileAssetRow) => void;
}) {
  const t = useT();
  const pad = 8 + depth * 14;

  if (node.type === 'file') {
    const a = node.asset;
    const name = lastSegment(a.relPath);
    const isMd = a.relPath.toLowerCase().endsWith('.md');
    const update = updates?.find(
      (u) => u.name === fileStem(a.relPath) && u.category === a.category,
    );
    const uninstallable =
      scope === 'global'
        ? GLOBAL_UNINSTALLABLE.has(a.category) && a.agent !== 'codex'
        : UNINSTALLABLE.has(a.category);
    return (
      <div className="group/row relative">
        <button
          type="button"
          onClick={() => onOpenFile(a.relPath)}
          style={{ paddingLeft: pad, paddingRight: 30 }}
          className="w-full flex items-center gap-1.5 rounded-md py-1 text-left text-xs font-mono text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/50"
          title={
            a.isSymlink ? t('fileTree.symlinkTitle', { path: a.absPath }) : a.absPath
          }
        >
          {a.isSymlink ? (
            <FileSymlink className="h-3 w-3 shrink-0 text-amber-400" />
          ) : isMd ? (
            <FileText className="h-3 w-3 shrink-0 text-blue-400" />
          ) : (
            <FileCode className="h-3 w-3 shrink-0 text-neutral-500" />
          )}
          <span className="truncate">{name}</span>
          {/* Agent + kind tags sit AFTER the name (no leading dot): the same
              chip colours as the filter bar, so rows and filters agree. */}
          <AgentBadge
            agent={a.agent ?? 'claude'}
            className="shrink-0 px-1.5 py-0 text-[10px] font-sans"
          />
          <span className={cn(ROW_TAG_BASE, kindColor(bucketOf(a.category, a.relPath)).on)}>
            {bucketOf(a.category, a.relPath)}
          </span>
          {update?.outdated && (
            <Badge variant="warning" className="shrink-0 px-1.5 py-0 text-[10px] font-sans">
              {t('fileTree.update')}
            </Badge>
          )}
          {update?.custom && (
            <Badge variant="other" className="shrink-0 px-1.5 py-0 text-[10px] font-sans">
              {t('fileTree.custom')}
            </Badge>
          )}
        </button>
        {uninstallable && (
          <button
            type="button"
            onClick={() =>
              onUninstall({
                name: fileStem(a.relPath),
                category: a.category as FileAssetCategory,
                relPath: a.relPath,
                ...(a.agent ? { agent: a.agent } : {}),
              })
            }
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-neutral-500 opacity-0 group-hover/row:opacity-100 hover:text-red-400 hover:bg-neutral-800"
            title={t('fileTree.uninstall', { name })}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  }

  const isCollapsed = collapsed.has(node.path);
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(node.path)}
        style={{ paddingLeft: pad }}
        className="w-full flex items-center gap-1.5 rounded-md py-1 pr-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-800/50"
      >
        {isCollapsed ? (
          <ChevronRight className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0" />
        )}
        <Folder className="h-3 w-3 shrink-0 text-neutral-500" />
        <span className="truncate">{node.name}</span>
        <span className="text-[10px] text-neutral-600 tabular-nums">{countFiles(node)}</span>
      </button>
      {!isCollapsed &&
        node.children.map((c) => (
          <AssetTreeNode
            key={c.type === 'dir' ? c.path : c.asset.relPath}
            node={c}
            depth={depth + 1}
            scope={scope}
            updates={updates}
            collapsed={collapsed}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
            onUninstall={onUninstall}
          />
        ))}
    </div>
  );
}

/**
 * The 文件资产 view: every non-skill, non-MCP project asset in one file tree
 * (instructions, commands, agents, workflows, rules, output styles, helpers,
 * settings …), filtered by multi-select type chips. Clicking a file opens the
 * right-side preview drawer; uninstallable kinds expose a hover trash.
 */
export function FileAssetTree({
  scope,
  assets,
  updates,
  onUninstall,
  onOpenFile,
}: {
  /** Which view this tree is in — prefixes the heading (项目 X / 全局 X). */
  scope: AssetScope;
  assets: AssetEntry[];
  /** Update info already filtered to this mode's scope. */
  updates?: FileAssetUpdate[];
  onUninstall: (row: FileAssetRow) => void;
  onOpenFile: (relPath: string) => void;
}) {
  const t = useT();
  // Counts cover every known kind — kinds with no files show as 0-count chips
  // rather than disappearing, so the filter bar always reads the full taxonomy.
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const k of BUCKET_ORDER) m.set(k, 0);
    for (const a of assets) {
      if (TAB_KINDS.has(a.category)) continue; // skill/mcp 归 tab 维度，不进 chips
      const b = bucketOf(a.category, a.relPath);
      m.set(b, (m.get(b) ?? 0) + 1);
    }
    return m;
  }, [assets]);

  // Multi-select filter: an empty selection means "show everything". Only
  // kinds the taxonomy knows can stay active — anything else self-heals.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const active = useMemo(() => {
    const s = new Set<string>();
    for (const k of selected) if (counts.has(k)) s.add(k);
    return s;
  }, [selected, counts]);
  const visible = useMemo(
    () =>
      active.size
        ? assets.filter((a) => active.has(bucketOf(a.category, a.relPath)))
        : assets,
    [assets, active],
  );

  const tree = useMemo(() => buildTree(visible), [visible]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  // Every directory path in the tree — used by expand/collapse-all.
  const allDirPaths = useMemo(() => {
    const out: string[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.type === 'dir') {
          out.push(n.path);
          walk(n.children);
        }
      }
    };
    walk(tree);
    return out;
  }, [tree]);
  const anyCollapsed = collapsed.size > 0;
  /** One button that flips between expand-all and collapse-all. */
  const toggleAll = () =>
    anyCollapsed ? setCollapsed(new Set()) : setCollapsed(new Set(allDirPaths));

  // Count-descending (ties keep the taxonomy order), so the busiest kinds
  // sit leftmost; future categories sort in by their own counts too.
  const chipKinds = useMemo(() => {
    const rank = new Map<string, number>();
    BUCKET_ORDER.forEach((k, i) => rank.set(k, i));
    return [...counts.keys()].sort((a, b) => {
      const d = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
      return d !== 0 ? d : (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity);
    });
  }, [counts]);
  const toggleKind = (k: string) => {
    const next = new Set(active);
    if (!next.delete(k)) next.add(k);
    setSelected(next);
  };

  const scopeLabel = scope === 'global' ? t('fileTree.scopeGlobal') : t('fileTree.scopeProject');

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-semibold text-neutral-400 uppercase">
          {scopeLabel} {t('fileTree.title')}{' '}
          <span className="text-neutral-600 normal-case font-normal">
            {scope === 'global' ? t('fileTree.pathsGlobal') : t('fileTree.pathsProject')}
          </span>
        </h2>
        <span className="ml-auto rounded-full bg-neutral-800/60 text-neutral-400 px-2 py-0.5 text-[11px] font-medium tabular-nums">
          {active.size ? `${visible.length} / ${assets.length}` : assets.length}
        </span>
        {allDirPaths.length > 0 && (
          <button
            type="button"
            onClick={toggleAll}
            className="inline-flex items-center gap-1 rounded-full bg-neutral-800 text-neutral-400 px-1.5 py-0.5 text-[10px] hover:bg-neutral-700"
            title={anyCollapsed ? t('fileTree.expandAllDirs') : t('fileTree.collapseAllDirs')}
          >
            {anyCollapsed ? (
              <ChevronsUpDown className="h-2.5 w-2.5" />
            ) : (
              <ChevronsDownUp className="h-2.5 w-2.5" />
            )}
            {anyCollapsed ? t('fileTree.expandAll') : t('fileTree.collapseAll')}
          </button>
        )}
      </div>

      {/* Multi-select type filter — empty selection shows every kind. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <KindChip active={active.size === 0} onClick={() => setSelected(new Set())}>
          {t('fileTree.all')}
          <span className="tabular-nums text-[10px] opacity-70">{assets.length}</span>
        </KindChip>
        {chipKinds.map((k) => (
          <KindChip key={k} kind={k} active={active.has(k)} onClick={() => toggleKind(k)}>
            {k}
            <span className="tabular-nums text-[10px] opacity-70">{counts.get(k) ?? 0}</span>
          </KindChip>
        ))}
      </div>

      {tree.length === 0 ? (
        <p className="text-xs text-neutral-600 border border-dashed border-white/[0.06] rounded-md p-3">
          {t('fileTree.emptyFiltered')}
        </p>
      ) : (
        // Fixed max height: the tree scrolls inside itself instead of
        // stretching the page (chips + panel below stay reachable).
        <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-white/[0.06] bg-neutral-900/40 p-2 space-y-0.5">
          {tree.map((node) => (
            <AssetTreeNode
              key={node.type === 'dir' ? node.path : node.asset.relPath}
              node={node}
              depth={0}
              scope={scope}
              updates={updates}
              collapsed={collapsed}
              onToggle={toggle}
              onOpenFile={onOpenFile}
              onUninstall={onUninstall}
            />
          ))}
        </div>
      )}
    </section>
  );
}
